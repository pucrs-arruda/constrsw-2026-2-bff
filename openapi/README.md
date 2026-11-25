# Courses contract snapshot

`openapi.json` is the Group 05 contribution: health and the 19 Courses operations.
The JSON files in `domains/` preserve the Courses and Classes OpenAPI documents
from the base `docs/open-api/` checkout on 2026-11-23, converted from YAML without
semantic changes. They have no external references. Validate offline with
`npm run test:contract`.

`CourseView` copies Course properties and required fields, then adds required
`classes`. The base's closed Course plus `allOf` would reject the added field.
Both the initial failure and the corrected composed payload are covered by tests.

O Grupo 08 acrescenta 12 operações sob `/api/v1/rooms`. Os dois GETs principais
usam `RoomView`, com o array obrigatório `classes` do semestre em curso.
`npm run test:contract` também confere essa contribuição.
