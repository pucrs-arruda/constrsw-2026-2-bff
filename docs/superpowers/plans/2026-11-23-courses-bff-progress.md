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

Task 5: complete — 3a9b533; CourseView allOf regression observed false for a valid composed payload and passed after flattening. Ajv and formats declared directly at the already installed versions. Runtime schema checks reject incomplete upstream payloads before composition. Offline reference walk detected a missing Health snapshot; included before final validation. 352 references/19 operations and all domain schemas validated. Docker build and anonymous health/separate metrics listener passed as non-root.

Task 6: complete for the approved implementation scope — real-stack E2E passed with 23 verified checks across all 19 operations, real Courses/OAuth/Keycloak/PostgreSQL and an explicit Classes fixture. The disposable Courses stack passed 62 scenarios, with monitoring not requested. The E2E's initial PUT test used create-only bibliographicReferences; corrected the test payload against CourseUpdate and reran successfully. No production code change was needed for that domain refusal.

Final review: fresh gpt-6.2-astra reviewer, 8bb9c50..3a9b533. Three Important findings and one runner-lifecycle finding reproduced before fixes.

Final: fixed decoded dot identifiers — raw HTTP tests observed unexpected 503/path normalization, then CO-400 before domain dispatch.

Final: fixed empty GET/HEAD bodies — tests observed 503 before omission of empty bodies. Nonempty bodies explicitly return CO-400, preserving write bodies.

Final: fixed caller cancellation opening circuits — closed and half-open tests observed incorrectly open circuits, then passed with cancellations excluded and probe admission released.

Final: fixed runner teardown on import failure — regraded Important because the command never exited on bootstrap failure. Child-process regression timed out before the fix and exited with the expected sanitized failure after the fix.

Final verification after the fix pass: 94/94 tests, 352 offline references, 19 documented operations and TypeScript build passed. Compose's transitive graph contains only BFF, Courses, OAuth, PostgreSQL, Keycloak, OTel collector and Prometheus; cookie names align and configured NODE_OPTIONS execute in the image.

Final: Ruling: Classes production compatibility remains unverified; use the explicit fixture under the approved scope and do not start another group's service. A live integration check is still required against the deployed Classes version.

Final: minor (deferred): none. Existing dependency-audit alerts are recorded in README; no multipart upload handler was added and inherited framework pins were retained.

Final compatibility check: reproduced Rooms forwarding an invented {} for GET
with Content-Length: 0 after the empty-body correction; preserve actual zero
length separately from an explicitly submitted {}. Added the regression and
fixed hasBody. Final suite passed: 95/95 tests; offline contract and build passed; final Docker image rebuilt successfully.

Delivery steering: user explicitly requested waiting to open a PR until the
professor publishes the shared E2E runner. Keep local grupo05; the current E2E
is provisional verification, with official-runner integration still pending
that external artifact. No PR or push is authorized by this instruction.

Publication: user subsequently authorized pushing grupo05 to the BFF remote. PR remains held until the professor publishes the official E2E runner and the group adapts its tests. No base push.
