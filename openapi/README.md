# Contract snapshot

`openapi.json` is the browser-facing snapshot: health, the 19 Courses operations,
the 8 Resources operations (including the logical `DELETE` of a resource and of an
occurrence), the 12 Rooms operations under `/api/v1/rooms`, and the 13 Lessons operations
(`bffSession` cookie `closed_cras_session`).
The merged document keeps the inherited top-level server `http://localhost:8180`
for health/Courses, while each Resources path item carries the module contract
server `http://localhost:8088`. The JSON files in `domains/` preserve the Courses, Rooms, Classes, Resources and Lessons
OpenAPI documents from the base checkouts, converted from
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

O Grupo 08 acrescenta 12 operações sob `/api/v1/rooms`. Os dois GETs principais
usam `RoomView`, com o array obrigatório `classes` do semestre em curso.
`npm run test:contract` também confere essa contribuição.

O Grupo 02 acrescenta 13 operações de Lessons em cinco paths sob `/api/v1/lessons`,
incluindo geração e tópicos. `domains/lessons.openapi.json` preserva o contrato
`docs/open-api/grupo02-lessons-api.yaml` da base. As rotas browser reutilizam seus
schemas, parâmetros e respostas, com prefixo `/api/v1` e servidor BFF herdado
(`http://localhost:8180`), sem publicar o health do domínio. Cada operação aceita
Bearer ou o cookie `bffSession`; o domínio continua validando o token e as regras.
`npm run test:contract` compila os schemas e verifica a contagem das 13 operações.
Os testes `lessons.schemas.spec.ts` verificam os métodos, referências, transporte
de autenticação e payloads válidos/inválidos, incluindo o envelope LE-503 do BFF.
