# Courses contract snapshot

`openapi.json` is the Group 05 contribution: health and the 19 Courses operations.
The JSON files in `domains/` preserve the Courses and Classes OpenAPI documents
from the base `docs/open-api/` checkout on 2026-11-23, converted from YAML without
semantic changes. They have no external references. Validate offline with
`npm run test:contract`.

`CourseView` copies Course properties and required fields, then adds required
`classes`. The base's closed Course plus `allOf` would reject the added field.
Both the initial failure and the corrected composed payload are covered by tests.

This snapshot documents Courses. The inherited Rooms module still follows its
older `/v1/rooms` proxy contract; its owner must reconcile it with the current
base `/api/v1/rooms` composition contract.
