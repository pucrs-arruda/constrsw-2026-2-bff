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
| `RESERVATIONS_BASE_URL` | `BFF_RESERVATIONS_BASE_URL` | Origem HTTP de Reservations |
| `ROOMS_BASE_URL` | `BFF_ROOMS_BASE_URL` | Origem HTTP de Rooms |
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

## Módulo `rooms` (Grupo 08)

Sob `/api/v1/rooms`, as operações seguem o contrato `docs/open-api/bff.yaml`:

| Rota | Métodos | Comportamento |
|---|---|---|
| `/api/v1/rooms` | GET | Composição T3: lista salas com `classes` do semestre em curso |
| `/api/v1/rooms` | POST | Proxy puro para o serviço rooms (`Location`, status e erros intactos) |
| `/api/v1/rooms/{id}` | GET | Composição T3: recupera sala com `classes` do semestre em curso |
| `/api/v1/rooms/{id}` | PUT, PATCH, DELETE | Proxy puro para o serviço rooms |
| `/api/v1/rooms/{id}/accessibility-features` | GET, POST | Proxy puro para características de acessibilidade |
| `/api/v1/rooms/{id}/accessibility-features/{featureId}` | GET, PUT, PATCH, DELETE | Proxy puro para característica por id |

- **Composição de leitura (T3):** `GET /api/v1/rooms` e `GET /api/v1/rooms/{id}` compõem `classes` do semestre em curso (calculado no fuso `America/Sao_Paulo`: `year` civil; `semester` = 1 de janeiro a julho e 2 de agosto a dezembro). As turmas entram na composição quando `roomId` for igual ao id da sala. Coleção vazia do rooms não chama classes e retorna `[]`. Falha ou indisponibilidade do serviço classes retorna 503 `application/problem+json` com `code: 'BFF-DEPENDENCY'` — a sala nunca é retornada sem turmas por falha na dependência.
- **Decisão D5 (filtro de classes por papel):** O BFF repassa o token do próprio usuário ao rooms e ao classes (mesmo padrão de students e courses). Como consequência, o serviço classes filtra as turmas com base no papel do usuário logado: coordinator e administrator veem todas as turmas sediadas na sala; professor vê apenas as turmas que conduz; student vê apenas as turmas que cursa.
- **Resiliência e proxy:** Timeout, retry (apenas métodos idempotentes `GET` e `HEAD` para evitar repetição indevida de escritas) e circuit breakers independentes para rooms e classes. Query strings cruas (`{gteq}`, `%25` do like) e corpos brutos são preservados. Headers `X-Total-Count` e `Location` são repassados; nos GETs compostos, `etag` e `last-modified` são removidos e `cache-control: no-store` é definido.
- **Exceções de escopo fora de `src/modules/rooms/` (Seção 0.6 / `spec-bff/contribution.md`):**
  - `src/bootstrap.ts`: 1 linha adicionada (`app.use('/api/v1/rooms', raw({ type: () => true, limit: '1mb' }));`) ao lado de `/api/v1/courses` para preservar o corpo bruto (`Buffer`) no proxy e delegar a validação de JSON malformado ao serviço `rooms` (`RM-400`).
  - Pontos compartilhados de contrato, testes e execução do domínio (entregues em conjunto com a suíte de testes/contrato do Grupo 08): `openapi/*` (`openapi/domains/rooms.openapi.json`, `openapi/openapi.json`, `openapi/README.md`), `scripts/validate-contract.cjs`, script `test:e2e:rooms` em `package.json`, `compose.rooms.yaml`, `src/testing/rooms-fixtures.ts`, `src/rooms.integration.spec.ts` e `test/e2e/rooms.e2e-spec.ts`.


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

Variáveis (passadas pelo compose da base): `RESERVATIONS_BASE_URL`, `JWT_ISSUER`,
`JWT_AUDIENCE`, mais os `BFF_HTTP_*` e `BFF_CIRCUIT_BREAKER_*` compartilhados.
URL ou número inválido impede a subida com mensagem que cita a variável.

E2E: `npm run test:e2e -- reservations` (stack do base no ar, com a massa padrão do reservations).
Cobre 401, identidade, criar (corpo igual ao do backend direto), query `{like}`, ocorrência, 403 do
domínio, cancelar por merge-patch, 409 FR-30, excluir e 404.

## Quem faz o quê

| Pasta | Dono |
|---|---|
| `src/modules/reservations/` | Grupo 03 |
| `src/modules/rooms/` | Grupo 08 |
| `src/modules/students/` | Grupo 04 |
| `src/modules/courses/` | Grupo 05 |
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

`openapi/openapi.json` contém health e as 19 operações de Courses; seus contratos
de domínio estão copiados localmente, com referências verificáveis sem rede.
CourseView corrige a incompatibilidade de `allOf` com o Course fechado do
contrato original. Respostas que serão compostas são validadas com Ajv.

`GET /health` é anônimo. `GET /metrics` expõe `bff_http_requests_total` com método,
rota parametrizada e status, além de uptime. Se configurado, o listener adicional
usa `BFF_INTERNAL_METRICS_PORT`. O Prometheus da base ainda precisa de um scrape
do BFF para exibir essas métricas no Grafana; disponibilizar o endpoint sozinho
não configura um dashboard. Logs incluem rota parametrizada, status e duração.

Cada grupo acrescenta `src/modules/<domínio>/` e registra seu módulo em
`app.module.ts`, em ordem alfabética. Mudanças em `common/` devem preservar a
compatibilidade com os módulos existentes. `app.module.ts`, `package.json` e
lockfile são pontos compartilhados de integração.

Rooms publica `/api/v1/rooms` com composição T3 de turmas e testes. Students e Reservations
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
