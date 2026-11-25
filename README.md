# BFF — contribuição do Grupo 05

BFF em Node.js 24 (>=24.15), NestJS 12 e TypeScript. A branch `bff/grupo05` integra
Reservations do Grupo 03, Rooms do Grupo 08 e Students do Grupo 04, e acrescenta Courses.

## Funcionalidade

As 19 operações de Courses estão em `/api/v1/courses`, incluindo referências
bibliográficas, itens do plano e a consulta global de item de plano.

Somente GET da coleção principal e GET de uma disciplina acrescentam `classes`.
O ano/semestre vem do relógio do servidor em `America/Sao_Paulo`: janeiro a julho
é semestre 1; agosto a dezembro é semestre 2. A consulta a Classes usa o mesmo
token e uma requisição por coleção, exclui registros desabilitados e confirma
os vínculos retornados. Sem turmas, retorna `classes: []`. Falha ou resposta fora
do contrato na composição retorna o envelope de quatro campos `CO-503`.

Escritas e GETs secundários preservam a resposta do domínio. O proxy mantém query,
corpo, status, Content-Type, Location e X-Total-Count. Cursos valida o payload de
entrada; o BFF preserva também JSON vazio ou malformado para essa validação.

## Como subir

O BFF **só sobe pelo Compose da raiz** do repositório base. Não há execução
fora do compose: variáveis vêm do `.env` da base e do bloco `bff` em
`docker-compose.yml` (porta publicada: `BFF_EXTERNAL_API_PORT`, tipicamente 8180).

```sh
# na raiz do repositório base
docker compose up -d --build bff
```

| Variável (no container) | Origem no base | Uso |
|---|---|---|
| `PORT` | `BFF_INTERNAL_API_PORT` | Porta HTTP do BFF |
| `BFF_ORIGIN` | `BFF_ORIGIN` | Origem do frontend para CORS com credenciais |
| `SESSION_COOKIE_NAME` | `BFF_SESSION_COOKIE_NAME` | Mesmo nome de cookie do OAuth |
| `COURSES_BASE_URL` | `BFF_COURSES_BASE_URL` | Origem HTTP de Courses, sem `/api/v1` |
| `CLASSES_BASE_URL` | `BFF_CLASSES_BASE_URL` | Origem HTTP de Classes, sem `/api/v1` |
| `STUDENTS_BASE_URL` | `BFF_STUDENTS_BASE_URL` | Origem HTTP de Students |
| `EMPLOYEES_BASE_URL` | `BFF_EMPLOYEES_BASE_URL` | Origem HTTP de Employees, sem `/api/v1` |
| `RESERVATIONS_BASE_URL` | `BFF_RESERVATIONS_BASE_URL` | Origem HTTP de Reservations |
| `ROOMS_BASE_URL` | `BFF_ROOMS_BASE_URL` | Origem HTTP de Rooms |
| `RESOURCES_BASE_URL` | `BFF_RESOURCES_BASE_URL` | Origem HTTP de Resources, sem `/api/v1` |
| `JWT_ISSUER` / `JWT_AUDIENCE` | `BFF_JWT_*` | Validação JWT (reservations) |
| `BFF_HTTP_*` / `BFF_CIRCUIT_BREAKER_*` | mesmos nomes | Resiliência dos hops (AD-10) |
| `BFF_INTERNAL_METRICS_PORT` | `BFF_INTERNAL_METRICS_PORT` | Listener adicional opcional de `/metrics` |

O timeout aplica-se a cada tentativa. O limite total inclui tentativas e backoff
exponencial limitado a 1000 ms. Respostas HTTP de erro são preservadas; HTTP 5xx
conta como falha no circuito. Writes de Courses não são repetidas. Courses e
Classes têm circuitos independentes. Redirecionamentos não são seguidos.

## Testes no submodule

Com a stack do compose no ar (quando o E2E exigir), em `backend/bff`:

```sh
npm ci
npm test -- --runInBand
npm run test:contract
npm run build
```

## OAuth e frontend

O frontend faz login, refresh e logout no serviço OAuth, conforme a UX atual.
O BFF extrai somente `access_token` do cookie HttpOnly e o encaminha aos domínios,
que validam o acesso. Use `credentials: 'include'` nas chamadas do frontend.
Clientes de API também podem enviar Authorization Bearer; um header explícito
malformado não causa fallback para o cookie. Tokens, cookies, query strings e
corpos não entram nos logs HTTP. Escritas autenticadas por cookie com Origin
informada e diferente de `BFF_ORIGIN` são recusadas.

Não há novos endpoints de login no BFF. A gestão completa de autenticação
compartilhada continua sob coordenação da turma. O hook `request.bearerToken`
foi preservado para um futuro guard.

## Módulo `students` (Grupo 04)

Sob `/api/v1/students`, GET da coleção e GET de um estudante acrescentam
`classes`; POST, PUT, PATCH, DELETE e as rotas de matrículas são proxy. A
composição retorna as classes do semestre atual em que `studentIds` contém o
estudante, usando uma consulta a Classes por requisição. Erros do domínio sobem
intactos; quando Students responde 200, uma falha ou resposta inválida de Classes
resulta em 503 sem devolver o estudante pela metade.

## Módulo `employees`

**Proxy puro** (sem composição T3), com os mesmos paths do contrato
`docs/open-api/arruda-employees-api.yaml` / `bff.yaml`:

| Rota | Métodos |
|---|---|
| `/api/v1/employees` | GET, POST |
| `/api/v1/employees/{id}` | GET, PUT, PATCH, DELETE |
| `/api/v1/employees/{id}/dependents` | GET, POST |
| `/api/v1/employees/{id}/dependents/{dependentId}` | GET, PUT, PATCH, DELETE |

O Bearer do usuário (header ou cookie de sessão) segue para o domínio. Status, corpo,
`Content-Type` e `Location` sobem intactos. Domínio fora do ar → `503` `problem+json`
com `code: BFF-DOWNSTREAM-UNAVAILABLE`.

`EMPLOYEES_BASE_URL` é só a origem HTTP (sem `/api/v1`); o prefixo do contrato é
montado no serviço.

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
- Resposta do backend sobe intacta: status, corpo, `Content-Type` e os cabeçalhos que o `DownstreamService` seleciona (`Location`, `X-Total-Count`, `Retry-After`, `WWW-Authenticate`, `ETag`, `Last-Modified`, `Cache-Control`), como pede a SPEC-bff (CAP-1).
- Backend fora do ar, timeout ou circuito aberto → `503` `problem+json` no formato do contrato do
  reservations (sem `code`: lá `code` é só `FR-n`).

Variáveis (passadas pelo compose da base): `RESERVATIONS_BASE_URL`, `JWT_ISSUER`,
`JWT_AUDIENCE`, mais os `BFF_HTTP_*` e `BFF_CIRCUIT_BREAKER_*` compartilhados.
URL ou número inválido impede a subida com mensagem que cita a variável.

E2E: `npm run test:e2e -- reservations` (stack do base no ar, com a massa padrão do reservations).
Cobre 401, identidade, criar (corpo igual ao do backend direto), query `{like}`, ocorrência, 403 do
domínio, cancelar por merge-patch, 409 FR-30, excluir e 404.

## Módulo `resources` (UX-S3)

Rotas browser-facing publicadas sob `/api/v1/resources` (o mesmo prefixo do domínio e do
`docs/open-api/bff.yaml`):

| Rota | Método | Comportamento |
|---|---|---|
| `/api/v1/resources` | GET | Lista o domínio, responde array puro e acrescenta `openOccurrenceCount` + `reservations` a cada item |
| `/api/v1/resources` | POST | Proxy da criação; `Location` em `/api/v1/resources/{id}` |
| `/api/v1/resources/{resourceId}` | GET | Agregado com `openOccurrenceCount`, `reservations` e `occurrences` em array puro |
| `/api/v1/resources/{resourceId}` | PATCH | Proxy da atualização; mesmo agregado composto |
| `/api/v1/resources/{resourceId}/occurrences` | POST | Proxy do registro; `Location` em `/api/v1/resources/...` |
| `/api/v1/resources/{resourceId}/occurrences/{occurrenceId}` | PATCH | Proxy da resolução (`{resolution}`) |

- `openOccurrenceCount` é o número de ocorrências com status `OPEN`, calculado no read time. Não é
  persistido e não existe no contrato do domínio. A lista faz uma leitura de agregado por recurso
  (N+1); se qualquer leitura de detalhe falhar, a resposta é 503, sem lista parcial.
- `reservations` é composição somente leitura do contexto reservations: reservas futuras cujo
  `resourceIds` contém o recurso. Futuro = início da faixa (`data` + cânone A–E/F–N/P) posterior ao
  agora em `America/Sao_Paulo`; `status` não é filtrado. Lista lê as reservas uma vez; detalhe
  consulta por `resourceId`. Falha da composição → 503 sem payload parcial.
- `enabled` é flag de exclusão lógica do domínio e é removida de recursos e ocorrências. As
  coleções sobem como array puro; nenhum campo de roster, Student, availability, occupancy ou
  inventory-item é acrescentado.
- Sem sessão (cookie ou `Authorization: Bearer`), toda rota responde 401 `problem+json`
  (`AUTH_UNAUTHENTICATED`/`MISSING_TOKEN`) sem chamar o domínio. Recusas do domínio (403, 404, 409,
  422) passam intactas; o BFF não aplica papel nem regra de ocorrência.
- O `Bearer` do usuário é encaminhado; `Origin` e cookie nunca são repassados ao domínio.
- Domínio fora do ar, timeout ou circuito aberto → 503 `problem+json`
  `DEPENDENCY_UNAVAILABLE` com `reason` `RESOURCES_UPSTREAM_UNAVAILABLE` (um 503 do próprio domínio
  continua sendo repassado como veio).

Configuração: `RESOURCES_BASE_URL` (default `http://resources:8106`),
`RESERVATIONS_BASE_URL` (default `http://reservations:8109`) mais os `BFF_HTTP_*` e
`BFF_CIRCUIT_BREAKER_*` compartilhados. A lista repassa somente os filtros documentados (`code`,
`type`, `active`, `tag`). O `docker-compose.yml` da base **não** define um serviço `bff`; inclua
estas chaves no serviço `bff` do seu override (ou no bloco que você usa para subir o BFF):

```yaml
services:
  bff:
    environment:
      RESOURCES_BASE_URL: http://resources:8106
      RESERVATIONS_BASE_URL: http://reservations:8109
      # ou: RESOURCES_BASE_URL: ${BFF_RESOURCES_BASE_URL}
      #     RESERVATIONS_BASE_URL: ${BFF_RESERVATIONS_BASE_URL}
    depends_on:
      resources: { condition: service_healthy }
      reservations: { condition: service_healthy }
      oauth: { condition: service_healthy }
```

Se preferir a convenção do base, defina `BFF_RESOURCES_BASE_URL=http://resources:8106` e
`BFF_RESERVATIONS_BASE_URL=http://reservations:8109` no `.env` e use
`RESOURCES_BASE_URL: ${BFF_RESOURCES_BASE_URL}` / `RESERVATIONS_BASE_URL:
${BFF_RESERVATIONS_BASE_URL}`. O cookie de sessão continua vindo de `SESSION_COOKIE_NAME` (default
`closed_cras_session`); `cras_session` no contrato é placeholder do módulo de auth.

Testes: `npm test` cobre o proxy/read-model com fronteira HTTP real e o contrato offline;
`npm run test:e2e:resources` exige a stack do compose com resources, OAuth/Keycloak e o BFF.
`E2E_DOCKER=1` ativa o cenário de resources parado. O cenário de papel somente leitura roda quando
`E2E_READONLY_USERNAME` (e opcionalmente `E2E_READONLY_PASSWORD`) está definido.

## Quem faz o quê

| Pasta | Dono |
|---|---|
| `src/modules/courses/` | Grupo 05 |
| `src/modules/employees/` | proxy employees (malha) |
| `src/modules/reservations/` | Grupo 03 |
| `src/modules/rooms/` | Grupo 08 |
| `src/modules/students/` | Grupo 04 |
| `src/modules/resources/` | resources (UX-S3) |
| `src/modules/classes/`, `src/modules/lessons/`, … | um grupo cada |
| `src/modules/ocupacao/` | FR-29, dono único a definir |
| `common/` | compartilhado |

Cada grupo registra seu módulo em `app.module.ts`, em ordem alfabética. Mudanças
em `common/` devem preservar a compatibilidade com os módulos já integrados.

## Docker Compose da base

A partir da raiz da base configurada:

```sh
docker compose -f docker-compose.yml -f backend/bff/compose.courses.yaml up -d --build bff
```

O override troca as dependências diretas do BFF por OAuth e Courses. Ele não
inicia os microsserviços de outros grupos. Classes precisa estar disponível na
URL configurada para os dois GETs compostos; pode ser externa. Os outros grupos
continuam responsáveis por seus próprios módulos. A infraestrutura necessária
segue as dependências de OAuth/Courses na base.

`SESSION_COOKIE_NAME` do BFF deve corresponder ao OAuth. O override usa
`OAUTH_SESSION_COOKIE_NAME` da base; ao combinar outro override que altere o
cookie do OAuth, ajuste também o BFF. Não publique o `.env`.

## Verificação E2E

O E2E de Courses agora segue o modelo integrado na main: arquivo
`test/e2e/courses.e2e-spec.ts`, configuração `test/jest-e2e.json` e helpers de
`test/e2e/support/e2e-env.ts`. O script provisório com Classes simulada foi
substituído. O teste fala com o BFF publicado, Courses e Classes reais, usando
o token do Keycloak obtido pelo fluxo real de login do OAuth.

Com a base configurada, inicie os serviços necessários da raiz:

```sh
docker compose up -d postgresql keycloak oauth courses classes
docker compose -f docker-compose.yml -f backend/bff/compose.courses.yaml up -d --no-deps --build bff
```

Em `backend/bff`, execute apenas nosso domínio:

```sh
npm run test:e2e:courses
```

`npm run test:e2e -- courses` equivale ao comando acima. `npm run test:e2e` sem
filtro inclui também os E2Es dos outros grupos e exige os respectivos serviços.
Os testes unitários/HTTP locais continuam separados em `npm test`.

Courses reutiliza configuração e HTTP compartilhados, e obtém o token em
`POST /login` do OAuth. Isso exercita a mesma autenticação da aplicação e evita
que os hosts externo/interno do Keycloak gerem emissores diferentes. Os helpers
do runner e o E2E de Students permanecem intactos.

O suporte compartilhado lê o .env da base sem imprimir seus valores. Para um
ambiente diferente, configure `E2E_BFF_URL`, `E2E_COURSES_URL`,
`E2E_CLASSES_URL`, `E2E_OAUTH_URL`, `E2E_KEYCLOAK_URL`, `E2E_USERNAME`, `E2E_PASSWORD` e, se
necessário, `E2E_BASE_ENV_FILE`. Courses usa as credenciais do usuário no OAuth;
os E2Es dos outros grupos que chamam o helper `accessToken` diretamente usam
também `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_CLIENT_SECRET` e `KEYCLOAK_REALM`.

O roteiro cobre as 19 operações de Courses; compara leituras compostas com
Courses/Classes diretamente; exclui turmas de outro curso, ano, semestre ou
removidas; verifica classes vazias, 400/401/404/409 e limpeza dos dados criados.
Cada execução usa códigos únicos e apaga apenas seus próprios registros.

Com `E2E_DOCKER=1`, inclui o cenário CO-503 parando e restaurando o container de
Classes. `E2E_CLASSES_CONTAINER` permite outro nome de container. Esse cenário
exige uma stack local que possa ser interrompida. Por padrão, fica desativado.

Classes aceita IDs sintéticos de sala/professor na configuração padrão da base,
como no modelo de Students. Se a implantação habilitar validação externa dessas
referências, forneça `E2E_ROOM_ID` e `E2E_PROFESSOR_ID` válidos. O teste não sobe
Rooms, Professors ou outros microsserviços de grupos alheios.

## Contrato, observabilidade e integração dos grupos

`openapi/openapi.json` contém health, as 19 operações de Courses e as rotas browser
de Resources (`/api/v1/resources`, servidor de contrato `http://localhost:8088`); os
contratos de domínio, incluindo `domains/resources.openapi.json`, estão copiados
localmente, com referências verificáveis sem rede. CourseView corrige a
incompatibilidade de `allOf` com o Course fechado do contrato original. Respostas
que serão compostas (Courses e o agregado/lista de Resources) são validadas com Ajv.

`GET /health` é anônimo. `GET /metrics` expõe `bff_http_requests_total` com método,
rota parametrizada e status, além de uptime. Se configurado, o listener adicional
usa `BFF_INTERNAL_METRICS_PORT`. O Prometheus da base ainda precisa de um scrape
do BFF para exibir essas métricas no Grafana; disponibilizar o endpoint sozinho
não configura um dashboard. Logs incluem rota parametrizada, status e duração.

Cada grupo acrescenta `src/modules/<domínio>/` e registra seu módulo em
`app.module.ts`, em ordem alfabética. Mudanças em `common/` devem preservar a
compatibilidade com os módulos existentes. `app.module.ts`, `package.json` e
lockfile são pontos compartilhados de integração.

Rooms mantém suas rotas legadas `/v1/rooms` e testes. Students e Reservations
mantêm E2Es independentes. Courses reutiliza o runner compartilhado para testar
com Classes real.

As versões NestJS/TypeScript originais foram mantidas: instalação e build
passaram. O ValidationPipe global sem DTOs foi removido, corrigindo a falha de
bootstrap por dependências ausentes e preservando a validação nos domínios.
Ajv e ajv-formats são dependências diretas para validar respostas compostas.
O audit do lockfile herdado reporta avisos, incluindo dois de severidade alta
na cadeia platform-express/multer. Este módulo não usa upload multipart;
uma atualização compartilhada dessa cadeia deve ser coordenada com a turma.

GET/HEAD com corpo vazio são encaminhados sem corpo; corpos não vazios nesses
métodos recebem CO-400. Identificadores `.` e `..` também recebem CO-400 antes
da normalização de URL. Cancelamentos do navegador não contam como falhas dos
serviços e liberam uma tentativa de recuperação cancelada.

Validação em 2026-11-23: 112 testes locais passaram, incluindo Students e Rooms;
o contrato offline verificou 352 referências e 19 operações. O E2E novo passou
29 cenários com BFF, Courses, Classes, OAuth/Keycloak e PostgreSQL reais, incluindo
CO-503 com parada e restauração de Classes. A limpeza foi executada e Classes
voltou saudável. Build NestJS e checagem de tipos do E2E também passaram.

O runner E2E compartilhado é usado por Courses e continua disponível aos
demais módulos.
