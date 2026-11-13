# bff

Serviço bff - constrsw 2026/2

BFF do Closed CRAS: a única porta que o frontend Angular enxerga. Os nove contextos não falam com
o browser (AD-6), então tudo que a UI precisa passa por aqui — como *proxy* (pass-through do CRUD
de um contexto) ou como *read-model de composição* (leitura que junta contextos).

> **Estado:** scaffold + módulo `rooms` (Grupo 08). Os outros oito contextos, o `modules/auth` e o
> `modules/ocupacao` ainda não existem. Veja [Quem faz o quê](#quem-faz-o-quê).

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
    auth/bearer-token.ts       # encaixe com o modules/auth que ainda não existe
    health/                    # GET /health anônimo (AD-7)
    http/
      circuit-breaker.ts       # disjuntor por downstream (AD-10)
      downstream.service.ts    # timeout + retry idempotente + breaker
  modules/
    rooms/                     # Grupo 08
```

## Quem faz o quê

Pelo PRD, **cada grupo pluga o próprio domínio no BFF** — e, no frontend, implementa a tela de um
domínio **alheio** (FR-28). Então aqui o Grupo 08 é dono de `modules/rooms/` e de mais nada.

| Pasta | Dono |
|---|---|
| `modules/rooms/` | Grupo 08 |
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
