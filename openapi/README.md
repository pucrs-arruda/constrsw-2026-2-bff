# Contract snapshot

`openapi.json` is the browser-facing snapshot: health, the 19 Courses operations,
and the Resources module's `/api/v1/resources` routes (`bffSession` cookie security).
The merged document keeps the inherited top-level server `http://localhost:8180`
for health/Courses, while each Resources path item carries the module contract
server `http://localhost:8088`. The JSON files in `domains/` preserve the Courses,
Classes and Resources OpenAPI documents from the base checkouts, converted from
YAML without semantic changes. They have no external references. Validate offline
with `npm run test:contract`.

`CourseView` copies Course properties and required fields, then adds required
`classes`. The base's closed Course plus `allOf` would reject the added field.
Both the initial failure and the corrected composed payload are covered by tests.

The Resources browser schemas are self-contained: `ResourceSummary` and `Resource`
add `openOccurrenceCount` and `reservations`; `ResourceList`, `OccurrenceList` and
`FutureReservations` are bare arrays; neither resource view exposes the domain's
`enabled` flag. `Reservation` is copied from the reservations contract so the
snapshot validates the composed future reservations without external references.
The domain snapshot in `domains/resources.openapi.json` keeps the domain
`Resource`/`ResourceAggregate` shapes (including `enabled`) so the BFF can validate
composed reads before mapping.

This snapshot documents Courses and Resources. The inherited Rooms module still
follows its older `/v1/rooms` proxy contract; its owner must reconcile it with the
current base `/api/v1/rooms` composition contract.
