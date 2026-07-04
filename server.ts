import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import multer from "multer";
import * as xlsx from "xlsx";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import nodemailer from "nodemailer";
import { GoogleGenAI } from "@google/genai";

const require = createRequire(import.meta.url);
const pdfModule = require("pdf-parse");
const pdf = typeof pdfModule === "function" ? pdfModule : (pdfModule.default || pdfModule);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function cleanJsonString(str: string): string {
  let cleaned = str.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/i, "");
    if (cleaned.endsWith("```")) {
      cleaned = cleaned.slice(0, -3);
    }
  }
  return cleaned.trim();
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      }
    }
  });

  // Configure Mailer
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: parseInt(process.env.SMTP_PORT || "465"),
    secure: true,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  // Mullter for file uploads
  const upload = multer({ storage: multer.memoryStorage() });

  app.use(express.json());

  // API Route: Send OTP Email
  app.post("/api/send-otp", async (req, res) => {
    const { email, otp, id } = req.body;
    
    if (!email || !otp) {
      return res.status(400).json({ error: "Missing email or otp" });
    }

    try {
      console.log(`[AUTH] Attempting to send OTP ${otp} to ${email} for ID ${id}`);

      // Only send if credentials exist
      if (process.env.SMTP_USER && process.env.SMTP_PASS) {
        await transporter.sendMail({
          from: `"PEC Placement Portal" <${process.env.SMTP_USER}>`,
          to: email,
          subject: "Verification Code - PEC Placement Cell",
          html: `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; rounded: 20px;">
              <h2 style="color: #2563eb;">Campus Authentication</h2>
              <p>Hi ${id},</p>
              <p>Your one-time verification code to access the PEC Placement Portal is:</p>
              <div style="font-size: 32px; font-weight: bold; letter-spacing: 0.2em; text-align: center; color: #1e293b; background: #f8fafc; padding: 20px; border-radius: 12px; margin: 20px 0;">
                ${otp}
              </div>
              <p style="color: #64748b; font-size: 12px;">This code will expire in 5 minutes. If you did not request this, please ignore this email.</p>
            </div>
          `,
        });
        res.json({ success: true, message: "Email sent" });
      } else {
        console.warn("[AUTH] SMTP Credentials missing. Check .env or Secrets.");
        res.status(400).json({ 
          error: "SMTP_NOT_CONFIGURED", 
          message: "Email service not configured. Please see logs.",
          otp: otp 
        });
      }
    } catch (error) {
      console.error("Email sending failed:", error);
      res.status(500).json({ error: "FAILED_TO_SEND", details: error instanceof Error ? error.message : "Undefined" });
    }
  });

  // API Route: Excel parsing
  app.post("/api/parse-excel", upload.single("file"), (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }
      const workbook = xlsx.read(req.file.buffer, { type: "buffer" });
      const sheetName = workbook.SheetNames[0];
      const data = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);
      res.json(data);
    } catch (error) {
      console.error("Excel parsing error:", error);
      res.status(500).json({ error: "Failed to parse Excel file" });
    }
  });

  // API Route: PDF parsing (for Resume AI)
  app.post("/api/parse-pdf", upload.single("file"), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }
      console.log("Parsing PDF file:", req.file.originalname, "Size:", req.file.size);
      const data = await pdf(req.file.buffer);
      if (!data || !data.text) {
        throw new Error("No text extracted from PDF");
      }
      res.json({ text: data.text });
    } catch (error: any) {
      console.error("PDF parsing error details:", {
        message: error.message,
        stack: error.stack,
        code: error.code
      });
      res.status(500).json({ error: "Failed to parse PDF file", details: error.message });
    }
  });

  // API Route: Generate behavioral interview questions
  app.post("/api/gemini/generate-questions", async (req, res) => {
    try {
      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash",
        contents: "Generate 5 common behavioral interview questions for a software engineering role. Return as a plain JSON array of strings.",
        config: { responseMimeType: "application/json" }
      });
      res.json({ text: cleanJsonString(response.text || "[]") });
    } catch (error: any) {
      console.error("Gemini Generate Questions Error:", error);
      res.status(500).json({ error: "Failed to generate questions", details: error.message });
    }
  });

  // API Route: Evaluate interview answer
  app.post("/api/gemini/evaluate-answer", async (req, res) => {
    try {
      const { userAnswer, question } = req.body;
      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash",
        contents: `Evaluate this interview answer. User answered "${userAnswer}" to the question "${question}". Provide brief, constructive feedback (2 sentences max).`,
      });
      res.json({ text: response.text || "Good answer, keep going!" });
    } catch (error: any) {
      console.error("Gemini Evaluate Answer Error:", error);
      res.status(500).json({ error: "Failed to evaluate answer", details: error.message });
    }
  });

  // API Route: Analyze resume
  app.post("/api/gemini/analyze-resume", async (req, res) => {
    try {
      const { text, jobDescription, studentName, companyName, jobRole } = req.body;
      
      const prompt = `You are an expert ATS (Applicant Tracking System) specialist, resume writer, and career coach with 15+ years of experience helping candidates optimize resumes for top companies like Google, Amazon, Microsoft, and other Fortune 500 companies.

Analyze the following resume against the job description and provide a COMPLETE, COMPREHENSIVE analysis with ALL of the following components.

---

RESUME TEXT:
${text || "No resume text provided."}

JOB DESCRIPTION:
${jobDescription || "A modern software engineering or tech role requiring solid problem solving, coding, system design, and communication skills."}

STUDENT NAME: ${studentName || "Candidate"}
COMPANY NAME: ${companyName || "Top Tech Company"}
JOB ROLE: ${jobRole || "Software Engineer"}

---

Provide your analysis in the following EXACT JSON format with ALL sections filled:

{
    "ats_score": {
        "overall": 0,
        "keyword_match": 0,
        "skills_match": 0,
        "experience_match": 0,
        "education_match": 0,
        "formatting_score": 0,
        "status": "Excellent/Good/Fair/Poor",
        "status_message": "One sentence status message"
    },
    
    "skills_analysis": {
        "present": ["skill1", "skill2"],
        "missing": ["skill1", "skill2"],
        "critical_missing": ["skill1", "skill2"],
        "relevance_score": 0,
        "skill_gap_analysis": {
            "strong_match": ["skill1", "skill2"],
            "missing_skills": ["skill1", "skill2"],
            "extra_skills": ["skill1", "skill2"],
            "improvement_plan": [
                {
                    "skill": "Skill Name",
                    "action": "How to acquire or showcase",
                    "priority": "High/Medium/Low",
                    "timeline": "1 week/1 month/3 months"
                }
            ]
        }
    },
    
    "keywords_analysis": {
        "found": ["keyword1", "keyword2"],
        "missing": ["keyword1", "keyword2"],
        "critical_missing": ["keyword1", "keyword2"],
        "total_jd_keywords": 0,
        "matched_percentage": 0,
        "keyword_density_score": 0,
        "keyword_placement_suggestions": ["suggestion1", "suggestion2"]
    },
    
    "summary_analysis": {
        "quality": "Excellent/Good/Fair/Poor",
        "score": 0,
        "feedback": "Detailed feedback about the summary section",
        "strengths": ["strength1", "strength2"],
        "weaknesses": ["weakness1", "weakness2"],
        "suggested_improvement": "Write the improved summary here"
    },
    
    "experience_analysis": {
        "quality": "Excellent/Good/Fair/Poor",
        "score": 0,
        "star_format_used": true,
        "quantifiable_achievements": 0,
        "achievement_quality": "Excellent/Good/Fair/Poor",
        "feedback": "Detailed feedback about experience section",
        "strengths": ["strength1", "strength2"],
        "weaknesses": ["weakness1", "weakness2"],
        "suggested_improvements": [
            {
                "original": "Original bullet point",
                "improved": "Improved bullet point with metrics",
                "reason": "Why this improvement helps"
            }
        ],
        "star_examples": [
            {
                "situation": "Brief situation",
                "task": "Task description",
                "action": "Action taken",
                "result": "Result with metrics"
            }
        ]
    },
    
    "education_analysis": {
        "quality": "Excellent/Good/Fair/Poor",
        "score": 0,
        "relevance": 0,
        "feedback": "Detailed feedback about education section",
        "strengths": ["strength1", "strength2"],
        "weaknesses": ["weakness1", "weakness2"],
        "suggestions": ["suggestion1", "suggestion2"]
    },
    
    "formatting_analysis": {
        "score": 0,
        "issues": ["issue1", "issue2"],
        "suggestions": ["suggestion1", "suggestion2"],
        "ats_compatibility": {
            "overall_score": 0,
            "file_format": {"compatible": true, "message": "Explanation"},
            "resume_length": {"pages": 1, "optimal": true, "message": "Explanation"},
            "section_headers": {
                "proper_headers": ["Header1", "Header2"],
                "missing_headers": ["Header1", "Header2"],
                "score": 0
            },
            "contact_info": {
                "complete": true,
                "missing": ["Phone", "Email"],
                "message": "Explanation"
            },
            "dates": {
                "consistent": true,
                "issues": ["issue1"],
                "message": "Explanation"
            },
            "grammar": {
                "errors": ["error1", "error2"],
                "score": 0
            },
            "improvements": ["Improvement suggestion 1", "Improvement suggestion 2"]
        }
    },
    
    "improvement_suggestions": [
        {
            "priority": "Critical/High/Medium/Low",
            "category": "Keywords/Skills/Experience/Formatting/Summary/Education/ATS",
            "suggestion": "Specific improvement suggestion",
            "example": "Example of how to implement",
            "impact": "High/Medium/Low"
        }
    ],
    
    "overall_feedback": {
        "strengths": ["strength1", "strength2", "strength3"],
        "weaknesses": ["weakness1", "weakness2", "weakness3"],
        "summary": "Overall summary of the resume quality (2-3 sentences)",
        "recommendation": "Clear recommendation - Approve/Needs Improvement/Major Rework Required",
        "confidence": "High/Medium/Low"
    },
    
    "improved_resume": {
        "personal_info": {
            "name": "${studentName || "Candidate"}",
            "email": "email@domain.com",
            "phone": "+91 98765 43210",
            "location": "City, State, Country",
            "linkedin": "linkedin.com/in/username",
            "github": "github.com/username",
            "portfolio": "portfolio.com/username"
        },
        "professional_summary": "Write a powerful 3-4 sentence improved summary here",
        "core_competencies": ["Competency 1", "Competency 2", "Competency 3", "Competency 4", "Competency 5"],
        "technical_skills": {
            "programming_languages": ["Language1", "Language2"],
            "frameworks": ["Framework1", "Framework2"],
            "tools": ["Tool1", "Tool2"],
            "cloud_platforms": ["Platform1", "Platform2"],
            "other": ["Skill1", "Skill2"]
        },
        "professional_experience": [
            {
                "company": "${companyName || "Previous Company"}",
                "location": "City, State",
                "role": "${jobRole || "Software Engineer"}",
                "duration": "MM/YYYY - MM/YYYY",
                "achievements": [
                    "Quantified achievement 1 with metrics",
                    "Quantified achievement 2 with metrics",
                    "Quantified achievement 3 with metrics"
                ]
            }
        ],
        "education": [
            {
                "degree": "Bachelor of Engineering",
                "institution": "Institution Name",
                "location": "City, State",
                "graduation_year": "YYYY",
                "cgpa": "8.5/10",
                "relevant_coursework": ["Course1", "Course2"]
            }
        ],
        "projects": [
            {
                "name": "Project Name",
                "description": "Brief project description",
                "technologies": ["Tech1", "Tech2"],
                "achievements": ["Achievement 1", "Achievement 2"],
                "link": "projectlink.com"
            }
        ],
        "certifications": [
            {
                "name": "Certification Name",
                "issuer": "Issuing Organization",
                "year": "YYYY"
            }
        ]
    },
    
    "cover_letter": {
        "content": "Write a professional 3-4 paragraph cover letter here",
        "subject_line": "Application for ${jobRole || "Software Engineer"} - ${studentName || "Candidate"}",
        "tone": "Professional/Enthusiastic/Confident",
        "key_points_highlighted": ["Point1", "Point2"]
    },
    
    "interview_questions": {
        "behavioral": [
            {
                "question": "Tell me about a time when...",
                "context": "Based on experience section",
                "star_guidance": "Situation - Task - Action - Result"
            }
        ],
        "technical": [
            {
                "question": "Explain how you would implement...",
                "skill_tested": "Skill Name",
                "difficulty": "Easy/Medium/Hard"
            }
        ],
        "hr": [
            {
                "question": "Where do you see yourself in 5 years?",
                "purpose": "Career goals assessment"
            }
        ],
        "role_specific": [
            {
                "question": "How would you approach...?",
                "context": "Role-specific scenario"
            }
        ],
        "resume_specific": [
            {
                "question": "Can you elaborate on your experience at...?",
                "reference": "Specific resume entry"
            }
        ],
        "preparation_tips": ["Tip 1", "Tip 2"]
    },
    
    "action_plan": {
        "immediate_actions": [
            {"action": "Action 1", "priority": "High", "time_estimate": "10 minutes"},
            {"action": "Action 2", "priority": "High", "time_estimate": "15 minutes"}
        ],
        "short_term": [
            {"action": "Action 1", "time_estimate": "1-2 days"},
            {"action": "Action 2", "time_estimate": "1-2 days"}
        ],
        "long_term": [
            {"action": "Action 1", "time_estimate": "1 week"},
            {"action": "Action 2", "time_estimate": "1 week"}
        ],
        "checklist": [
            "Add missing keywords",
            "Quantify achievements",
            "Fix formatting issues",
            "Review and finalize"
        ]
    },
    
    "summary_visual": {
        "progress": 0,
        "grade": "A/B/C/D/F",
        "one_liner": "One-line summary of resume quality"
    }
}

---

INSTRUCTIONS:
1. Be thorough and detailed in ALL sections. Populate with real, solid, highly relevant suggestions, skills, and advice based on the candidate's resume and job description. Do not leave array properties empty if you can extract or suggest relevant items.
2. Provide specific, actionable suggestions.
3. Quantify everything possible.
4. Use professional language.
5. DO NOT fabricate information - only improve existing content.
6. Keep the improved resume factual and accurate based on what the candidate has done, but rewrite them beautifully with standard powerful active verbs and metrics where possible.
7. Provide at least 5 improvement suggestions in the improvement_suggestions list.
8. Generate at least 3 interview questions per category under the interview_questions object.
9. Make the cover letter tailored to the specific job.
10. Return ONLY valid JSON - no additional text before or after. Ensure all nested values correspond to actual data or constructive suggestions.`;

      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash",
        contents: prompt,
        config: {
          responseMimeType: "application/json"
        }
      });
      res.json({ text: cleanJsonString(response.text || "{}") });
    } catch (error: any) {
      console.error("Gemini Analyze Resume Error:", error);
      res.status(500).json({ error: "Failed to analyze resume", details: error.message });
    }
  });

  // API Route: Health check
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Error handle middleware
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error("Unhandled Error:", err);
    res.status(500).json({ error: "Internal Server Error", message: err.message });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
