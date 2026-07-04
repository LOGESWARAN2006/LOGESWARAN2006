# Security Specification: Panimalar Placement Portal

## Data Invariants
1. A user cannot modify their own `role` or `placementProbability` (Tier 2 access).
2. Submissions must always be linked to the `request.auth.uid`.
3. Question bank is read-only for students; modifications are Admin-only.
4. Students can only see their own submissions.

## The Dirty Dozen (Attack Vectors)
1. **Self-Promotion**: Student trying to update their role to 'ADMIN'.
2. **Score Spoofing**: Student trying to set their own `placementProbability` to 100%.
3. **Orphaned Submission**: Creating a submission for a non-existent `questionId`.
4. **Identity Theft**: User A trying to read User B's private profile.
5. **Bank Vandalism**: Student trying to delete or modify a coding problem in the shared bank.
6. **Submission Hijack**: User A trying to submit a solution on behalf of User B.
7. **Junk ID Injection**: Creating a document with a 2MB ID string.
8. **Shadow Field Injection**: Adding an `isVerified: true` field to a submission.
9. **History Erasure**: Student trying to delete their own low-score submissions.
10. **Query Scrape**: Attempting a `list` query across all users' submissions.
11. **PII Leak**: Unauthenticated user trying to get a user's email.
12. **Future Dating**: Setting a `submittedAt` timestamp to the year 2099.

## Test Runner (TDD Plan)
- Test `allow create` on `/users/` only if `uid == request.auth.uid`.
- Test `allow update` on `/users/` to block `role` changes.
- Test `allow create` on `/submissions/` to ensure `userId == auth.uid`.
- Test `allow write` on `/questions/` is denied for students.
- Test `allow read` on `/users/` for faculty.
