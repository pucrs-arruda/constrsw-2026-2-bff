# bff

Serviço bff - constrsw 2026/2

BFF do Closed CRAS: a única porta que o frontend Angular enxerga. Os nove contextos não falam com
o browser (AD-6), então tudo que a UI precisa passa por aqui — como *proxy* (pass-through do CRUD
de um contexto) ou como *read-model de composição* (leitura que junta contextos).

> **Estado:** scaffold + módulos `rooms` (Grupo 08) e `students` (Grupo 04). Os outros contextos,
> o `modules/auth` e o `modules/ocupacao` ainda não existem. Veja [Quem faz o quê](#quem-faz-o-quê).

## Rodar

```bash
npm install
npm test          # unit + contrato
npm run start:dev # porta 3001 por padrão
```

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
    rooms/                     # Grupo 08
    students/                  # Grupo 04
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

## Quem faz o quê

Pelo PRD, **cada grupo pluga o próprio domínio no BFF** — e, no frontend, implementa a tela de um
domínio **alheio** (FR-28). Então aqui o Grupo 08 é dono de `modules/rooms/` e de mais nada.

| Pasta | Dono |
|---|---|
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
