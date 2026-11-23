# BFF — contribuição do Grupo 05

BFF em Node.js 24 (>=24.15), NestJS 12 e TypeScript. A branch `grupo05` integra
os commits do scaffold/Rooms do Grupo 08 e acrescenta Courses.

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

## Rodar localmente

```sh
npm ci
npm test -- --runInBand
npm run test:contract
npm run build
npm run start:prod
```

Copie `.env.example` para `.env` e ajuste os endereços dos serviços. A porta local
padrão é 3001; a publicação prevista pelo Compose da base é 8180.

| Variável | Uso |
|---|---|
| `PORT` | Porta HTTP do BFF; padrão 3001 |
| `BFF_ORIGIN` | Origem exata do frontend para CORS com credenciais |
| `SESSION_COOKIE_NAME` | Mesmo nome de cookie do OAuth; exemplo `closed_cras_session` |
| `COURSES_BASE_URL` | Origem HTTP de Courses, sem `/api/v1` |
| `CLASSES_BASE_URL` | Origem HTTP de Classes, sem `/api/v1` |
| `ROOMS_BASE_URL` | Origem do proxy Rooms herdado |
| `BFF_HTTP_TIMEOUT_MS` | Timeout por tentativa, incluindo leitura do corpo; padrão 3000 |
| `BFF_HTTP_RETRIES` | Repetições por falha de rede; Courses/Classes somente GET/HEAD; padrão 2 |
| `BFF_CIRCUIT_BREAKER_ERROR_THRESHOLD_PERCENTAGE` | Percentual de falhas; padrão 50 |
| `BFF_CIRCUIT_BREAKER_RESET_TIMEOUT_MS` | Intervalo de recuperação; padrão 10000 |
| `BFF_CIRCUIT_BREAKER_VOLUME_THRESHOLD` | Volume mínimo da janela; padrão 10 |
| `BFF_CIRCUIT_BREAKER_ROLLING_WINDOW_MS` | Janela do circuito; padrão 10000 |
| `BFF_INTERNAL_METRICS_PORT` | Listener adicional opcional de `/metrics` |

O timeout aplica-se a cada tentativa. O limite total inclui tentativas e backoff
exponencial limitado a 1000 ms. Respostas HTTP de erro são preservadas; HTTP 5xx
conta como falha no circuito. Writes de Courses não são repetidas. Courses e
Classes têm circuitos independentes. Redirecionamentos não são seguidos.

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

O runner testa o Nest real com OAuth, Keycloak e Courses reais, e uma fixture
HTTP explícita de Classes. Exercita as 19 operações, login por cookie, composição,
falhas, métricas e limpeza apenas da disciplina criada pela execução.

Em ambiente com conta de teste já autorizada, configure `BFF_E2E_OAUTH_URL`,
`BFF_E2E_COURSES_URL`, `BFF_E2E_USERNAME` e `BFF_E2E_PASSWORD`, então execute:

```sh
npm run build
npm run test:e2e
```

Outra opção é preparar a stack descartável pelo runner existente de Courses:

```sh
python backend/courses/scripts/base_e2e.py --keep
```

Esse comando é executado da raiz da base e informa o caminho do receipt em
`backend/courses/target/`. No BFF, configure `BFF_E2E_RECEIPT` com esse caminho e
execute `npm run test:e2e`. O receipt contém credenciais temporárias: mantenha-o
ignorado. Ao terminar, use o runner de Courses com `--cleanup <receipt>` para
remover somente aquele projeto e seus volumes. O runner BFF fecha a própria
aplicação/fixture e exclui logicamente apenas a disciplina de teste.

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
`app.module.ts`, em ordem alfabética. Mudanças em `common/` pedem regressões e
compatibilidade com os módulos existentes. Os pontos prováveis de conflito dos
PRs são AppModule, package.json e lockfile. O merge preserva o histórico do Grupo
08, permitindo ao Git reconhecer os commits quando seu PR entrar.

Rooms mantém suas rotas legadas `/v1/rooms` e testes. Seu dono deve reconciliar
esse prefixo e a composição de leitura com o contrato atual da base. Os demais
módulos da turma não fazem parte desta contribuição. Os testes com fixture não
comprovam compatibilidade com um deployment real de Classes.

As versões NestJS/TypeScript originais foram mantidas: instalação e build
passaram. O ValidationPipe global sem DTOs foi removido, corrigindo a falha de
bootstrap por dependências ausentes e preservando a validação nos domínios.
Ajv e ajv-formats são dependências diretas para validar respostas compostas.
O audit do lockfile herdado reporta avisos, incluindo dois de severidade alta
na cadeia platform-express/multer. Este módulo não usa upload multipart;
uma atualização compartilhada dessa cadeia deve ser coordenada com a turma.

Esta contribuição permanece na branch local `grupo05`. A base não foi publicada.
