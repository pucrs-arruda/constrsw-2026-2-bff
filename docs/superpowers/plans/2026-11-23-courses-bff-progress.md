# Execution ledger — plan: 2026-11-23-courses-bff.md

Pre-flight: HTTP response headers and cancellation are consumed by Courses;
configureApp must be shared by production and HTTP tests; offline contracts must
be copied into the runtime image for response validation.

Ruling: Execute in the current grupo05 checkout with the user's approved continuation; no additional worktree or publication. A caller expecting a separate checkout would instead see the implementation here.

Task 1: complete — Group 08 history merged at ab1eca6; npm ci installed 511 packages with original pinned versions; TypeScript build passed. Production startup reproduced missing class-validator before the fix.

Task 2: complete — df86266; 9 regression failures observed, then 25/25 tests passed. Corrected headers, empty bodies, redirects, cancellation, safe retry configuration, HTTP 5xx accounting and stale half-open completions.

Ruling: Remove unused global ValidationPipe rather than adding validation packages. The proxy has no DTOs; Courses owns input validation and receives raw payloads. Future BFF DTO endpoints must add explicit validation and dependencies.

Task 3: complete — 71b52d5 and metrics in eb76ff9; OAuth cookie tests failed before implementation, then 39 tests passed. Metrics test reproduced 404 before endpoint implementation. Browser CORS exposes response headers and rejects unsafe cookie requests from supplied untrusted origins.

Task 4: complete — eb76ff9; 41 HTTP tests failed against absent Courses routes, then all 82 tests passed. The test suite covers all 19 operations, local semester boundaries, queries, independent circuits, cookie forwarding, malformed payloads and no partial composition.

Task 5: in progress — CourseView allOf regression observed false for a valid composed payload. Ajv and formats declared directly at the already installed versions. Runtime schema checks reject incomplete upstream payloads before composition. Offline reference walk detected a missing Health snapshot; included before final validation.

Task 6: pending — real-stack E2E, Docker verification, whole-branch review.
