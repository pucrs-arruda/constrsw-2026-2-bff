# Courses module for the shared BFF

## Intent and ownership

Implement Group 05's Courses contribution on branch `grupo05` of `backend/bff`. The deliverable provides the 19 Courses business operations through the BFF and enriches the course collection and individual course reads with current-semester classes. Reuse the shared NestJS application already published by Group 08 and retain its Rooms module and tests.

The browser-facing behavior follows `docs/open-api/bff.yaml` in the base repository, the current Courses and Classes OpenAPIs, and the November 16 UX authentication update. Runtime URLs, timeout and breaker settings come from the environment names already supplied by the base Compose. The base repository cannot be published by this user. Implementation, documentation and runnable verification belong in the BFF submodule.

## Approach

The proposed integration incorporates `origin/grupo08-feat/modulo-rooms` at commit `8bb9c50` into `grupo05` and adds `src/modules/courses/`. It retains the upstream scaffold's history and module registration convention. Shared changes are limited to concrete requirements of the new module and regressions demonstrated by tests. The implementer chooses private helper names and dependency-injection details after inspecting that scaffold.

The existing NestJS 12 and TypeScript package versions and lockfile are the starting point. Verify package availability and the existing build before changing dependency versions. Any compatibility adjustment must be justified by an actual installation or build failure and recorded in the README.

## HTTP behavior

- Publish `/api/v1/courses`, `/api/v1/courses/{courseId}`, the nested bibliographic-reference and syllabus-item collections/items, and `/api/v1/courses/syllabus-items/{syllabusItemId}`. Support the same methods as the Courses OpenAPI.
- Forward query strings, request bodies, content types and the caller's bearer token to Courses. Preserve successful statuses, error envelopes, relevant response headers such as `Location`, and empty 204 responses. Empty objects, empty arrays and malformed payloads must reach the domain with their meaning intact.
- For POST, PUT, PATCH, DELETE and secondary-resource GETs, return the domain response. The BFF delegates business validation and permission decisions to the domain services.
- Enrich only successful collection and individual-course GET responses. A Courses refusal such as 400, 401, 403 or 404 is passed through, with no Classes request.
- Transport errors, timeouts and open circuits on this module produce the existing Courses 503 envelope with `error_code: CO-503` and the four required error-envelope fields. Composition failures use that same envelope. Avoid returning partial course data after a Classes failure.

## Current-semester composition

- Determine `year` and `semester` server-side using `America/Sao_Paulo`. January through July is semester 1, August through December is semester 2. Use an injectable clock so tests cover the exact local-time boundary.
- Fetch Classes for the current `year` and `semester` with the same caller token. Group the returned records by `courseId` and attach `classes` to each course. For a course item, a `courseId` filter can narrow the request. For a collection, one semester query avoids one Classes request per course.
- Confirm the returned class belongs to the current year, semester and course. Exclude logically disabled classes. Follow the contract's semester definition without introducing a separate status or start/end-date rule.
- Return `classes: []` when there are no matching classes. An empty course collection remains empty and needs no Classes request. Treat a malformed Classes response as a dependency failure. The documented Classes collection returns an array, including an empty array when no match exists.
- Preserve course and class ordering supplied by the services. Enrichment must preserve every original course field, including `bibliographicReferences` and `syllabusItems`.

## Authentication and browser compatibility

The current UX performs login, refresh and logout through the OAuth service and uses its HttpOnly session cookie. Implement server-side extraction of the access token from that cookie for forwarding. Configure the cookie name with `SESSION_COOKIE_NAME`, matching the OAuth deployment's `OAUTH_SESSION_COOKIE_NAME` Compose input. The documented OAuth example uses `closed_cras_session`; use this as the standalone default and explicitly configure a different deployment value when necessary. Forward the access token only, and do not forward the refresh token or entire cookie to Courses or Classes.

Retain explicit Bearer-header support for contract/API clients. A supplied malformed Authorization header must not silently fall back to a cookie. A shared helper may extend the scaffold's `bearerTokenOf` function while retaining its documented `request.bearerToken` integration point. Courses and Classes validate the forwarded token and resource permission. Document the remaining ownership of full shared authentication and apply exact-origin credentialed CORS using the scaffold's `BFF_ORIGIN` setting. A cookie-authenticated unsafe request with a supplied untrusted Origin must be rejected. Health stays anonymous.

## Shared HTTP support

Reuse the Group 08 `DownstreamService` and `CircuitBreaker`. Validate the actual behavior against bounded timeouts, redirect handling, HTTP 5xx failures, body read failures, open circuits, and concurrent half-open requests. Any shared fix needs a regression test and must keep Rooms' existing contract tests passing.

Courses and Classes use separate breaker instances. Network retries apply only to GET/HEAD for this module. Writes get a single attempt, including PUT, PATCH and DELETE, because the domain's soft-delete and error behavior makes automatic replay externally observable. Forward HTTP error responses rather than converting a domain refusal into a transport exception. Propagate caller cancellation when supported without leaving unhandled requests running.

## Contract and execution artifacts

- Provide a self-contained Courses BFF OpenAPI under `openapi/`, covering health and the implemented Courses routes, with local copies of the required domain contracts and transitive references. Validate every reference offline.
- Define `CourseView` by combining the Course properties and required fields with required `classes`. It must validate an actual composed payload. Referencing a closed Course through `allOf` and adding `classes` would reject that response.
- Register Courses beside Rooms in `app.module.ts`. Preserve the existing Rooms routes and public behavior. Note that Group 08's existing `/v1/rooms` prefix differs from the current base BFF OpenAPI and remains a follow-up for that module's owner.
- Update `.env.example`, the README and Docker support for running Courses through the BFF. Provide a Courses-focused Compose contribution that starts the BFF with only its required services and does not start the other groups' business services implicitly. Classes may be an external URL or a clearly named fixture in tests.
- Expose process health, readable logs without tokens/cookies/bodies, and HTTP metrics suitable for the existing monitoring environment. Do not create BFF persistence for domain aggregates.

## Verification and acceptance

1. Preserve the Group 08 baseline tests. Introduce failing tests before each new behavior and run the full suite after implementation.
2. HTTP integration tests use real local Courses/Classes fixture servers and the actual Nest app. Cover all 19 operations, request and response forwarding, 201 Location and 204 semantics, query preservation, and composition on only the two course GET forms.
3. Composition tests cover July/August and year boundaries in Sao Paulo, disabled and unrelated classes, empty collections, Classes outages/refusals/malformed responses, Courses refusals, and preservation of every course field.
4. Authentication tests cover the OAuth cookie format, Bearer-header precedence, malformed credentials, refresh-token exclusion, trusted and untrusted origins, and no credential leakage in logs.
5. Resilience tests cover bounded timeouts/retries, no replay of writes, circuit transitions and independent breakers for Courses and Classes.
6. Contract tests validate the composed CourseView and proxy responses against offline OpenAPI/JSON Schema. The known closed-schema/allOf problem must fail before correction and pass afterward.
7. `npm test -- --runInBand`, `npm run build`, the Docker build, and an executable E2E through the BFF must pass. The E2E exercises real Courses and the existing OAuth/Keycloak stack; a Classes fixture is explicitly reported when used. No live Classes deployment compatibility is claimed from fixture results.

## Delivery boundary

Deliver the implementation and validation results on local branch `grupo05`. The user has prohibited pushing the base repository. Publication of the BFF branch and any PR is a separate user decision. Record required base integration changes in the BFF README so a maintainer can apply them.
