# bff

Serviço bff - constrsw 2026/2

BFF do Closed CRAS: a única porta que o frontend Angular enxerga. Os nove contextos não falam com
o browser (AD-6), então tudo que a UI precisa passa por aqui — como *proxy* (pass-through do CRUD
de um contexto) ou como *read-model de composição* (leitura que junta contextos).

> **Estado:** scaffold + módulos `reservations` (Grupo 03), `rooms` (Grupo 08) e `students` (Grupo 04). Os outros contextos,
> o `modules/auth` e o `modules/ocupacao` ainda não existem. Veja [Quem faz o quê](#quem-faz-o-quê).

## Rodar

```bash
npm install
npm test          # unit + contrato
npm run start:dev # porta 3001 por padrão
```

### Teste fim a fim

`npm run test:e2e` roda `test/e2e/*.e2e-spec.ts` contra a stack **real** do compose do base (BFF,
contextos e Keycloak no ar), sem dublês. Não roda no `npm test`.

```bash
# na raiz do base: o mínimo para o e2e de students
docker compose up -d --build postgresql keycloak students classes
docker compose up -d --build --no-deps bff
# em backend/bff
npm run test:e2e
E2E_DOCKER=1 npm run test:e2e   # inclui o 503 BFF-DEPENDENCY parando o container classes
```

- `test/e2e/support/e2e-env.ts` é compartilhado: URLs (portas externas do `.env` do base), token
  do Keycloak (`admin@pucrs.br` por padrão) e cliente HTTP. O que não estiver no ambiente é lido do
  `.env` do base quando o BFF está em `backend/bff`. Sobrescreva com `E2E_BFF_URL`,
  `E2E_KEYCLOAK_URL`, `E2E_<CONTEXTO>_URL`, `E2E_USERNAME`, `E2E_PASSWORD`, `E2E_BASE_ENV_FILE`.
- **Para os outros grupos:** copie `test/e2e/students.e2e-spec.ts` como
  `test/e2e/<contexto>.e2e-spec.ts`. O roteiro é: criar dados pelo BFF (proxy) e direto no contexto
  da composição, conferir que o GET do BFF traz o corpo do dono do dado mais o campo composto, e
  limpar o que criou.

Dentro do compose do repositório base, o serviço sobe como `api` e é publicado em
`localhost:8180`. Fora dele, copie `.env.example` para `.env`.

## Estrutura

```text
src/
  main.ts                      # bootstrap; CORS só aqui (AD-6)
  app.module.ts                # ponto de encontro dos nove módulos
  common/
    academic/current-semester.ts # semestre em curso (fuso America/Sao_Paulo) da composição T3
    auth/bearer-token.ts       # encaixe com o modules/auth que ainda não existe
    health/                    # GET /health anônimo (AD-7)
    http/
      circuit-breaker.ts       # disjuntor por downstream (AD-10)
      downstream.service.ts    # timeout + retry idempotente + breaker
  modules/
    reservations/              # Grupo 03
    rooms/                     # Grupo 08
    students/                  # Grupo 04
test/
  jest-e2e.json                # config do npm run test:e2e
  e2e/
    support/e2e-env.ts         # compartilhado: URLs, token, HTTP
    students.e2e-spec.ts       # Grupo 04 (modelo para <contexto>.e2e-spec.ts)
    reservations.e2e-spec.ts   # Grupo 03
```

## Módulo `students` (Grupo 04)

Paths de `docs/open-api/bff.yaml` do repositório base, sob `/api/v1/students`:

| Rota | Tipo |
|---|---|
| `GET /api/v1/students` | composição: cada estudante + `classes` |
| `GET /api/v1/students/{id}` | composição: estudante + `classes` |
| `POST`, `PUT`, `PATCH`, `DELETE` de `/api/v1/students[/{id}]` | proxy |
| `/api/v1/students/{id}/enrollments[/{enrollmentId}]` (todos os verbos) | proxy |

`classes` são as classes do **semestre em curso** em que o estudante está matriculado
(`studentIds` contém o id). Semestre em curso no fuso America/Sao_Paulo: `year` = ano atual,
`semester` = 1 antes de agosto e 2 de agosto em diante. O BFF faz **uma** chamada
`GET /api/v1/classes?year=&semester=` por requisição (em paralelo com o students) e filtra
`studentIds` em memória, porque o classes não filtra por estudante.

- Erro do students (400, 401, 403, 404…) sobe intacto.
- students 200 e classes fora do ar, com status não 2xx ou corpo que não é lista → `503`
  `application/problem+json` com `code` `BFF-DEPENDENCY`; o estudante não é devolvido pela metade.
- students fora do ar → `503` com `code` `BFF-DOWNSTREAM-UNAVAILABLE`, como nos demais proxies.

Variáveis: `STUDENTS_BASE_URL` (default `http://students:8080`) e `CLASSES_BASE_URL` (default
`http://classes:8107`), mais os `BFF_HTTP_*` e `BFF_CIRCUIT_BREAKER_*` compartilhados.

## Módulo `reservations` (Grupo 03)

**Proxy puro** (o `bff.yaml` não pede composição para reservations), com os mesmos paths do contrato
do contexto (`docs/open-api/grupo03-reservations-api.yaml` do base):

| Rota | Métodos |
|---|---|
| `/api/v1/reservations` | GET, POST |
| `/api/v1/reservations/ocupacao` | GET |
| `/api/v1/reservations/{id}` | GET, PUT, PATCH, DELETE |
| `/api/v1/reservations/{id}/details` | GET, POST |
| `/api/v1/reservations/{id}/details/{detailId}` | GET, PUT, PATCH, DELETE |
| `/api/v1/identidade/me` | GET |

- **JWT validado no Keycloak** antes de chamar o backend: assinatura pelo JWKS do realm
  (`${JWT_ISSUER}/protocol/openid-connect/certs`, chaves em cache, nova busca se o `kid` mudar),
  `iss` no realm de `JWT_ISSUER` (qualquer host: o token pedido direto no Keycloak por
  `localhost:8081` vem com outro host no `iss`, e a assinatura já prova a origem), `aud` contém `JWT_AUDIENCE`, não expirado. Sem token ou inválido → `401`
  `problem+json`, sem chamar o backend. Keycloak fora do ar → `503`. Só `node:crypto`, sem lib nova.
- O mesmo `Authorization: Bearer` segue para o backend. Query vai como chegou (`{gteq}`, `%25`…);
  o PATCH (`application/merge-patch+json`) chega cru.
- Resposta do backend sobe intacta: status, corpo, `Content-Type` e `Location`.
- Backend fora do ar, timeout ou circuito aberto → `503` `problem+json` no formato do contrato do
  reservations (sem `code`: lá `code` é só `FR-n`).

Variáveis (todas já passadas pelo compose do base): `RESERVATIONS_BASE_URL`, `JWT_ISSUER`,
`JWT_AUDIENCE`, mais os `BFF_HTTP_*` e `BFF_CIRCUIT_BREAKER_*` compartilhados. URL ou número
inválido impede a subida com mensagem que cita a variável.

E2E: `npm run test:e2e -- reservations` (stack do base no ar, com a massa padrão do reservations).
Cobre 401, identidade, criar (corpo igual ao do backend direto), query `{like}`, ocorrência, 403 do
domínio, cancelar por merge-patch, 409 FR-30, excluir e 404.

Mudanças em código compartilhado feitas junto com este módulo:

- `DownstreamService`: devolve também `location` (opcional) e manda
  `Accept: application/json, application/problem+json` (só `application/json` dava `406` no
  `DELETE` do reservations, que só declara `problem+json`).
- `package.json`: `class-validator` e `class-transformer`, exigidos pelo `ValidationPipe` do
  `main.ts`. Sem eles o BFF não subia no compose (o `ValidationPipe` derrubava a aplicação na
  inicialização).

## Quem faz o quê

Pelo PRD, **cada grupo pluga o próprio domínio no BFF** — e, no frontend, implementa a tela de um
domínio **alheio** (FR-28). Então aqui o Grupo 08 é dono de `modules/rooms/` e de mais nada.

| Pasta | Dono |
|---|---|
| `modules/reservations/` | Grupo 03 |
| `modules/rooms/` | Grupo 08 |
| `modules/students/` | Grupo 04 |
| `modules/classes/`, `modules/lessons/`, … | um grupo cada |
| `modules/ocupacao/` | FR-29, dono único a definir |
| `modules/auth/` | **sem dono** — ver abaixo |
| `common/` | compartilhado |

### O que falta e não é de ninguém

1. **`modules/auth/`** — login (`POST /v1/auth/login`, Direct Access Grant do client confidencial
   `bff`), cookie httpOnly SameSite=Lax e tradução cookie → `Authorization: Bearer`. Enquanto não
   existir, `common/auth/bearer-token.ts` aceita o header `Authorization` da própria requisição
   para manter os módulos testáveis. **Isso contraria o AD-4** e precisa cair quando o `auth`
   entrar — o browser nunca deve carregar token.
2. **`openapi/openapi.yaml`** — o contrato público do BFF, distinguindo proxy de read-model.

## Acrescentando um módulo

1. `src/modules/<contexto>/` com controller, service e módulo.
2. Uma linha em `app.module.ts` (ordem alfabética — é o arquivo que mais gera conflito).
3. Reuse `DownstreamService` + `CircuitBreaker`: o AD-10 exige timeout e disjuntor em **todo** hop.
4. Leia base URL e parâmetros do `ConfigService`; o compose do base já passa tudo por env.

## Decisões que valem para qualquer módulo

- **Proxy não interpreta regra de negócio** (AD-6). A recusa do domínio — status e `problem+json`
  — sobe intacta. Validar invariante aqui duplicaria a regra em dois lugares.
- **Indisponibilidade vira 503 estável** (AD-10), com `code` de infraestrutura, nunca um código
  `FR-*` inventado.
- **Retry só em método idempotente**, com backoff limitado. `POST` não é repetido.
- **Resiliência em código próprio.** A spine lista `@nestjs/resilience` como *seed*, e diz: "Libs
  na Stack são seed; o comportamento é a invariante". São ~80 linhas, sem dependência extra.
