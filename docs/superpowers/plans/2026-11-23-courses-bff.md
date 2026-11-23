# Courses BFF Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task with TDD and a final fresh review.

**Goal:** Deliver the 19 Courses operations in the shared Node.js/NestJS BFF, with current-semester Classes composition on the two principal reads.

**Architecture:** Integrate Group 08 commit `8bb9c50`, preserving Rooms and its tests. Add a Courses Nest module using separate Courses/Classes downstream clients. Shared HTTP and browser-session support remain reusable.

**Tech Stack:** Node.js, NestJS, TypeScript, Jest, Supertest, Docker, offline OpenAPI/JSON Schema validation.

**Spec:** `docs/superpowers/specs/2026-11-23-courses-bff-design.md`

## Global Constraints

- Work on `grupo05` in the current BFF checkout, as requested. No base push; no BFF publication without authorization.
- Reuse existing dependencies when installable; record evidence of required compatibility changes.
- Preserve Rooms' public behavior and existing tests; no implementation of other groups' business modules.
- Semester 1 is January through July; semester 2 is August through December, in `America/Sao_Paulo`.
- Courses errors retain their four-field envelope; dependency failure uses `CO-503` and never partial composition.
- Same access token reaches Courses and Classes; no refresh tokens, cookies or bodies in logs.
- Start only required infrastructure, OAuth, Courses and BFF; Classes may use an explicit test fixture.

## Review Focus

- Encoded path delimiters must not change a downstream route; cover HTTP forwarding.
- Malformed and empty JSON bodies must reach the domain intact; cover bootstrap body parsing.
- An old request completing during a half-open probe must not admit more traffic; cover breaker generations.
- A forged cookie or malformed Authorization must not bypass downstream authorization or Origin enforcement; cover browser auth.
- Classes outages, malformed payloads and ignored filters must not yield misleading partial Courses; cover composition.

### Task 1: Integrate and establish executable baseline

**Files:** Existing scaffold, `package.json`, `package-lock.json`, `.gitignore`.
**Interfaces:** Produces existing `AppModule`, `DownstreamService.send(DownstreamRequest): Promise<DownstreamResponse>` and `CircuitBreaker.run<T>(call): Promise<T>`.

- [x] Merge `8bb9c50` preserving history; run `npm ci`, baseline tests and build.
- [x] Capture install/build failures before making minimal dependency compatibility changes.
- [x] Preserve the baseline 15 tests and commit integration/compatibility fixes.

### Task 2: Correct shared HTTP behavior

**Files:** `src/common/http/{downstream.service,circuit-breaker}.ts`, adjacent tests, Rooms controller and its contract tests.
**Interfaces:** Extend DownstreamResponse with optional safe headers; DownstreamRequest with optional AbortSignal; DownstreamOptions with retryMethods. HTTP failures remain responses, counted as breaker failures without automatic replay of writes.

- [x] Write failing real-HTTP tests for Location/total-count, redirects, 5xx circuit opening, network timeout, cancellation, body-read failure and retry bounds. Add breaker concurrency regression.
- [x] Run focused tests and confirm behavioral failures.
- [x] Implement header preservation, manual redirects, failure accounting, generation-aware recovery and configurable safe retries. Redact request/query/error details in logs.
- [x] Add failing Rooms tests for empty bodies and headers; correct controller forwarding and encoded path segments.
- [x] Run all tests/build and commit.

### Task 3: Browser-compatible application bootstrap

**Files:** `src/bootstrap.ts`, `src/main.ts`, `src/common/auth/bearer-token.ts`, auth/bootstrap tests, health/metrics support.
**Interfaces:** `configureApp(app: INestApplication): void`; `bearerTokenOf(request: Request): string | undefined`. Reads SESSION_COOKIE_NAME/BFF_ORIGIN and preserves request.bearerToken hook.

- [x] Write failing HTTP tests for OAuth JSON cookie, explicit Bearer precedence, malformed credentials, trusted/untrusted Origin and no refresh-token forwarding.
- [x] Implement cookie extraction and unsafe-origin rejection; configure exact-origin CORS and exposed response headers.
- [x] Preserve raw bodies for Courses while keeping parsed Rooms bodies. Expose health and low-cardinality request metrics without secrets.
- [x] Run suite/build and commit.

### Task 4: Courses routes and Classes composition

**Files:** `src/modules/courses/{courses.module,courses.controller,courses.service,current-semester}.ts`, HTTP integration/semester tests, `src/app.module.ts`.
**Interfaces:** `currentSemester(date: Date): {year:number;semester:number}`; `CoursesService.forward(request: DownstreamRequest, compose?: 'collection'|'item'): Promise<DownstreamResponse>`; injectable clock provider.

- [x] Write and run failing tests for all 19 routes/methods using actual Nest application and HTTP fixture servers.
- [x] Test exact Sao Paulo July/August/year boundaries, course-field/order preservation, current associations, disabled/unrelated classes, empty results and unavailable/malformed dependencies.
- [x] Add Nest controller, service and configured downstream providers; encode path segments, preserve queries/status/body/headers and normalize only infrastructure/composition failure into CO-503.
- [x] Compose only successful principal GETs, query Classes once per collection, filter current links and include classes:[] when appropriate.
- [x] Run suite/build and commit.

### Task 5: Offline contract and executable deployment artifacts

**Files:** `openapi/`, `scripts/validate-contract.cjs`, `.env.example`, `compose.courses.yaml`, `Dockerfile`, `.dockerignore`, `README.md`.
**Interfaces:** Self-contained Courses/health OpenAPI with corrected CourseView; npm contract script; Compose override for base BFF with no other groups in depends_on.

- [x] Add a failing schema check demonstrating closed Course plus allOf rejects classes.
- [x] Copy required domain contracts/transitive references, derive valid CourseView and validate references/composed/proxy payloads offline.
- [x] Document runtime environment, cookie alignment, inherited Rooms limitations and base integration instructions.
- [x] Run full suite, contract check, build and Docker build; commit artifacts.

### Task 6: Real-stack E2E and final review

**Files:** `scripts/e2e.cjs`, fixture utilities, README validation evidence.
**Interfaces:** npm E2E command exercises OAuth login cookie, real Courses CRUD, BFF composition and cleanup; accepts environment URLs/credentials privately.

- [x] Run BFF with real Courses/OAuth/Keycloak, explicit Classes fixture and required infrastructure only.
- [x] Exercise login, principal reads/composition, secondary proxies, writes, refusal propagation, Classes failure, metrics and cleanup.
- [x] Run full tests, contracts, build and Docker verification; request fresh whole-branch review.
- [x] Reproduce material review findings with failing tests, fix and verify the suite; commit final changes.
- [x] Report results and concrete limitations; leave publication to the user.
