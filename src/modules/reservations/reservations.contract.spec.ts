import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { INestApplication } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { KeycloakJwtVerifier } from './keycloak-jwt.verifier';
import { numberFrom, ReservationsModule, urlFrom } from './reservations.module';

/**
 * Teste de contrato do módulo reservations (Grupo 03), CAs de `bff-spec.md`.
 *
 * Nada é simulado dentro do BFF: o `DownstreamService` e o `CircuitBreaker` reais falam HTTP com
 * um backend falso, e o JWT é validado contra um Keycloak falso que publica um JWKS de verdade.
 */

// ---------- dublês ----------

interface Recorded {
	method: string;
	url: string;
	headers: IncomingMessage['headers'];
	body: string;
}

type Handler = (req: Recorded, res: ServerResponse) => void;

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; url: string }> {
	const server = createServer(handler);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function close(server: Server | undefined): Promise<void> {
	if (!server) {
		return;
	}
	server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** Backend falso: grava cada chamada e responde pelo `handler` da vez. */
async function fakeBackend(): Promise<{ server: Server; url: string; calls: Recorded[]; respond: (h: Handler) => void }> {
	const calls: Recorded[] = [];
	let handler: Handler = (_req, res) => {
		res.writeHead(200, { 'content-type': 'application/json' }).end('[]');
	};
	const { server, url } = await listen((req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (c: Buffer) => chunks.push(c));
		req.on('end', () => {
			const recorded = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
			calls.push(recorded);
			handler(recorded, res);
		});
	});
	return { server, url, calls, respond: (h) => { handler = h; } };
}

const KID = 'kid-teste';

/** Keycloak falso: só o JWKS do realm, numa URL igual à do Keycloak. */
async function fakeKeycloak(publicKey: KeyObject): Promise<{ server: Server; issuer: string; hits: () => number; setKeys: (keys: object[]) => void }> {
	let hits = 0;
	let keys: object[] = [
		{ ...publicKey.export({ format: 'jwk' }), kid: KID, use: 'sig', alg: 'RS256' },
		{ kty: 'RSA', kid: 'chave-de-criptografia', use: 'enc', n: 'AQAB', e: 'AQAB' },
	];
	const { server, url } = await listen((req, res) => {
		if (req.url === '/realms/constrsw/protocol/openid-connect/certs') {
			hits++;
			res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ keys }));
			return;
		}
		res.writeHead(404).end();
	});
	return { server, issuer: `${url}/realms/constrsw`, hits: () => hits, setKeys: (k) => { keys = k; } };
}

function tokenWith(privateKey: KeyObject, claims: Record<string, unknown>, header: Record<string, unknown> = {}): string {
	const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
	const head = encode({ alg: 'RS256', typ: 'JWT', kid: KID, ...header });
	const body = encode(claims);
	const signature = sign('sha256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url');
	return `${head}.${body}.${signature}`;
}

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const now = () => Math.floor(Date.now() / 1000);

// ---------- módulo inteiro, com HTTP de verdade ----------

describe('Módulo reservations do BFF (Grupo 03)', () => {
	let app: INestApplication;
	let backend: Awaited<ReturnType<typeof fakeBackend>>;
	let keycloak: Awaited<ReturnType<typeof fakeKeycloak>>;
	let token: string;

	async function startApp(overrides: Record<string, string> = {}): Promise<void> {
		const moduleRef = await Test.createTestingModule({
			imports: [
				ConfigModule.forRoot({
					isGlobal: true,
					ignoreEnvFile: true,
					ignoreEnvVars: true,
					load: [() => ({
						RESERVATIONS_BASE_URL: backend.url,
						JWT_ISSUER: keycloak.issuer,
						JWT_AUDIENCE: 'oauth',
						BFF_HTTP_TIMEOUT_MS: '500',
						BFF_HTTP_RETRIES: '2',
						BFF_CIRCUIT_BREAKER_ERROR_THRESHOLD_PERCENTAGE: '50',
						BFF_CIRCUIT_BREAKER_RESET_TIMEOUT_MS: '10000',
						BFF_CIRCUIT_BREAKER_VOLUME_THRESHOLD: '100',
						BFF_CIRCUIT_BREAKER_ROLLING_WINDOW_MS: '10000',
						...overrides,
					})],
				}),
				ReservationsModule,
			],
		}).compile();
		app = moduleRef.createNestApplication();
		await app.init();
	}

	beforeEach(async () => {
		backend = await fakeBackend();
		keycloak = await fakeKeycloak(keys.publicKey);
		token = tokenWith(keys.privateKey, { iss: keycloak.issuer, aud: 'oauth', sub: 'professor-1', exp: now() + 300 });
	});

	afterEach(async () => {
		await app?.close();
		await close(backend.server);
		await close(keycloak.server);
	});

	describe('B2 — autenticação', () => {
		beforeEach(() => startApp());

		it('B2.1 sem Authorization → 401 Problem, sem chamar o backend', async () => {
			const res = await request(app.getHttpServer()).get('/api/v1/reservations').expect(401);

			expect(res.headers['content-type']).toContain('application/problem+json');
			expect(res.headers['www-authenticate']).toBe('Bearer');
			expect(res.body).toMatchObject({ type: 'about:blank', status: 401 });
			expect(backend.calls).toHaveLength(0);
		});

		it.each([
			['assinado por outra chave', () => tokenWith(otherKeys.privateKey, { iss: keycloak.issuer, aud: 'oauth', exp: now() + 300 })],
			['expirado', () => tokenWith(keys.privateKey, { iss: keycloak.issuer, aud: 'oauth', exp: now() - 120 })],
			['de outro realm', () => tokenWith(keys.privateKey, { iss: keycloak.issuer.replace('/realms/constrsw', '/realms/outro'), aud: 'oauth', exp: now() + 300 })],
			['com iss que não é URL', () => tokenWith(keys.privateKey, { iss: 'constrsw', aud: 'oauth', exp: now() + 300 })],
			['sem a audiência oauth', () => tokenWith(keys.privateKey, { iss: keycloak.issuer, aud: 'account', exp: now() + 300 })],
			['com kid desconhecido', () => tokenWith(keys.privateKey, { iss: keycloak.issuer, aud: 'oauth', exp: now() + 300 }, { kid: 'outro' })],
			['com alg none', () => tokenWith(keys.privateKey, { iss: keycloak.issuer, aud: 'oauth', exp: now() + 300 }, { alg: 'none' })],
			['mal formado', () => 'nao-e-jwt'],
		])('B2.2 token %s → 401, sem chamar o backend', async (_caso, build) => {
			await request(app.getHttpServer())
				.get('/api/v1/reservations')
				.set('authorization', `Bearer ${build()}`)
				.expect(401);

			expect(backend.calls).toHaveLength(0);
		});

		it('B2.3 token válido chega ao backend com o mesmo Bearer; aud em lista também vale', async () => {
			const tokenComLista = tokenWith(keys.privateKey, { iss: keycloak.issuer, aud: ['account', 'oauth'], exp: now() + 300 });
			await request(app.getHttpServer()).get('/api/v1/reservations').set('authorization', `Bearer ${token}`).expect(200);
			await request(app.getHttpServer()).get('/api/v1/reservations').set('authorization', `Bearer ${tokenComLista}`).expect(200);

			expect(backend.calls.map((c) => c.headers.authorization)).toEqual([`Bearer ${token}`, `Bearer ${tokenComLista}`]);
		});

		it('aceita o mesmo realm pedido por outro host (localhost:8081 em vez de keycloak:8080)', async () => {
			const peloHost = tokenWith(keys.privateKey, { iss: 'http://localhost:8081/realms/constrsw', aud: 'oauth', exp: now() + 300 });

			await request(app.getHttpServer()).get('/api/v1/reservations').set('authorization', `Bearer ${peloHost}`).expect(200);
		});

		it('guarda as chaves: várias chamadas, uma busca só do JWKS', async () => {
			for (let i = 0; i < 3; i++) {
				await request(app.getHttpServer()).get('/api/v1/reservations').set('authorization', `Bearer ${token}`).expect(200);
			}
			expect(keycloak.hits()).toBe(1);
		});

		it('B2.4 Keycloak fora do ar ao buscar as chaves → 503 Problem', async () => {
			await close(keycloak.server);

			const res = await request(app.getHttpServer())
				.get('/api/v1/reservations')
				.set('authorization', `Bearer ${token}`)
				.expect(503);

			expect(res.headers['content-type']).toContain('application/problem+json');
			expect(backend.calls).toHaveLength(0);
		});
	});

	describe('B3 — proxy', () => {
		beforeEach(() => startApp());

		const auth = () => ({ authorization: `Bearer ${token}` });

		it('B3.1 as 14 operações chegam ao backend com o mesmo método e path', async () => {
			const server = app.getHttpServer();
			const id = '60000000-0000-4000-8000-000000000001';
			const detailId = '70000000-0000-4000-8000-000000000001';
			const operacoes: Array<[string, string]> = [
				['get', '/api/v1/reservations'],
				['post', '/api/v1/reservations'],
				['get', '/api/v1/reservations/ocupacao?data=2026-11-03&faixaId=C'],
				['get', `/api/v1/reservations/${id}`],
				['put', `/api/v1/reservations/${id}`],
				['patch', `/api/v1/reservations/${id}`],
				['delete', `/api/v1/reservations/${id}`],
				['get', `/api/v1/reservations/${id}/details`],
				['post', `/api/v1/reservations/${id}/details`],
				['get', `/api/v1/reservations/${id}/details/${detailId}`],
				['put', `/api/v1/reservations/${id}/details/${detailId}`],
				['patch', `/api/v1/reservations/${id}/details/${detailId}`],
				['delete', `/api/v1/reservations/${id}/details/${detailId}`],
				['get', '/api/v1/identidade/me'],
			];
			for (const [method, path] of operacoes) {
				await (request(server) as unknown as Record<string, (p: string) => request.Test>)[method](path).set(auth()).expect(200);
			}

			expect(backend.calls.map((c) => `${c.method} ${c.url}`)).toEqual(
				operacoes.map(([method, path]) => `${method.toUpperCase()} ${path}`),
			);
		});

		it('B3.2 201 volta igual: status, corpo, Content-Type e Location; o corpo chega ao backend', async () => {
			const criada = JSON.stringify({ id: 'abc', status: 'ACTIVE' });
			backend.respond((_req, res) => {
				res.writeHead(201, { 'content-type': 'application/json', location: '/api/v1/reservations/abc' }).end(criada);
			});
			const corpo = { lessonId: 'l1', data: '2026-11-07', faixaId: 'C', resourceIds: ['r1'] };

			const res = await request(app.getHttpServer()).post('/api/v1/reservations').set(auth()).send(corpo).expect(201);

			expect(res.headers.location).toBe('/api/v1/reservations/abc');
			expect(res.headers['content-type']).toContain('application/json');
			expect(res.text).toBe(criada);
			expect(JSON.parse(backend.calls[0].body)).toEqual(corpo);
			expect(backend.calls[0].headers['content-type']).toContain('application/json');
		});

		it('CAP-1 repassa os cabeçalhos do domínio (X-Total-Count, Retry-After, WWW-Authenticate, ETag) e não vaza Set-Cookie', async () => {
			backend.respond((_req, res) => {
				res.writeHead(200, {
					'content-type': 'application/json',
					'x-total-count': '3',
					'retry-after': '5',
					'www-authenticate': 'Bearer error="insufficient_scope"',
					etag: '"v1"',
					'set-cookie': 'interno=segredo',
				}).end('[]');
			});

			const res = await request(app.getHttpServer()).get('/api/v1/reservations').set(auth()).expect(200);

			expect(res.headers['x-total-count']).toBe('3');
			expect(res.headers['retry-after']).toBe('5');
			expect(res.headers['www-authenticate']).toBe('Bearer error="insufficient_scope"');
			expect(res.headers.etag).toBe('"v1"');
			expect(res.headers['set-cookie']).toBeUndefined();
		});

		it('B3.3 query complexa chega sem ser decodificada', async () => {
			const path = '/api/v1/reservations?data={gteq}2026-11-05&purpose={like}%25banca%25&faixaId=C';

			await request(app.getHttpServer()).get(path).set(auth()).expect(200);

			expect(backend.calls[0].url).toBe(path);
		});

		it.each([400, 403, 404, 409, 422])('B3.4 erro %i do backend volta com o mesmo status e Problem', async (status) => {
			const problem = JSON.stringify({ type: 'urn:closed-cras:recusa:FR-23', title: 'Recusa', status, code: 'FR-23' });
			backend.respond((_req, res) => {
				res.writeHead(status, { 'content-type': 'application/problem+json' }).end(problem);
			});

			const res = await request(app.getHttpServer()).get('/api/v1/reservations').set(auth()).expect(status);

			expect(res.headers['content-type']).toContain('application/problem+json');
			expect(res.text).toBe(problem);
			expect(backend.calls).toHaveLength(1);
		});

		it('B3.5 PATCH chega com application/merge-patch+json e o corpo cru', async () => {
			const patch = '{"status":"CANCELLED"}';

			await request(app.getHttpServer())
				.patch('/api/v1/reservations/abc')
				.set(auth())
				.set('content-type', 'application/merge-patch+json')
				.send(patch)
				.expect(200);

			expect(backend.calls[0].headers['content-type']).toBe('application/merge-patch+json');
			expect(backend.calls[0].body).toBe(patch);
		});

		it('o Accept enviado ao backend aceita problem+json (senão o DELETE 204 do reservations dá 406)', async () => {
			await request(app.getHttpServer()).delete('/api/v1/reservations/abc').set(auth()).expect(200);

			expect(backend.calls[0].headers.accept).toContain('application/problem+json');
		});

		it('204 sem corpo volta sem corpo', async () => {
			backend.respond((_req, res) => {
				res.writeHead(204).end();
			});

			const res = await request(app.getHttpServer()).delete('/api/v1/reservations/abc').set(auth()).expect(204);

			expect(res.text).toBe('');
		});

		it('id "." ou ".." não escapa da árvore de reservations', async () => {
			await request(app.getHttpServer()).get('/api/v1/reservations/%2e%2e').set(auth()).expect(404);
			expect(backend.calls).toHaveLength(0);
		});
	});

	describe('B4 — resiliência', () => {
		const auth = () => ({ authorization: `Bearer ${token}` });

		it('B4.1 backend fora do ar → 503 Problem', async () => {
			await startApp();
			await close(backend.server);

			const res = await request(app.getHttpServer()).get('/api/v1/reservations').set(auth()).expect(503);

			expect(res.headers['content-type']).toContain('application/problem+json');
			expect(res.body).toMatchObject({ type: 'about:blank', title: 'Dependência indisponível', status: 503 });
			expect(res.body.code).toBeUndefined();
		});

		it('B4.2 backend acima do timeout → 503', async () => {
			await startApp({ BFF_HTTP_TIMEOUT_MS: '100', BFF_HTTP_RETRIES: '0' });
			backend.respond((_req, res) => {
				setTimeout(() => res.writeHead(200).end('[]'), 400);
			});

			await request(app.getHttpServer()).get('/api/v1/reservations').set(auth()).expect(503);
		});

		it('B4.3 GET é repetido até BFF_HTTP_RETRIES; POST e PATCH uma vez só', async () => {
			await startApp({ BFF_HTTP_TIMEOUT_MS: '100', BFF_HTTP_RETRIES: '2' });
			backend.respond(() => {
				// nunca responde: cada tentativa estoura o timeout
			});

			await request(app.getHttpServer()).get('/api/v1/reservations').set(auth()).expect(503);
			expect(backend.calls.filter((c) => c.method === 'GET')).toHaveLength(3);

			await request(app.getHttpServer()).post('/api/v1/reservations').set(auth()).send({ a: 1 }).expect(503);
			expect(backend.calls.filter((c) => c.method === 'POST')).toHaveLength(1);

			await request(app.getHttpServer())
				.patch('/api/v1/reservations/abc')
				.set(auth())
				.set('content-type', 'application/merge-patch+json')
				.send('{"purpose":"x"}')
				.expect(503);
			expect(backend.calls.filter((c) => c.method === 'PATCH')).toHaveLength(1);
		});

		it('B4.4 circuito aberto → 503 sem chamar o backend', async () => {
			await startApp({ BFF_HTTP_TIMEOUT_MS: '100', BFF_HTTP_RETRIES: '0', BFF_CIRCUIT_BREAKER_VOLUME_THRESHOLD: '2' });
			backend.respond(() => {
				// timeout
			});

			await request(app.getHttpServer()).get('/api/v1/reservations').set(auth()).expect(503);
			await request(app.getHttpServer()).get('/api/v1/reservations').set(auth()).expect(503);
			const antes = backend.calls.length;

			await request(app.getHttpServer()).get('/api/v1/reservations').set(auth()).expect(503);

			expect(backend.calls).toHaveLength(antes);
		});

		it('B4.5 500 do backend é resposta: volta como veio e não é repetido', async () => {
			await startApp({ BFF_HTTP_RETRIES: '2' });
			backend.respond((_req, res) => {
				res.writeHead(500, { 'content-type': 'application/problem+json' }).end('{"status":500}');
			});

			await request(app.getHttpServer()).get('/api/v1/reservations').set(auth()).expect(500);

			expect(backend.calls).toHaveLength(1);
		});
	});
});

// ---------- configuração (B1.2) ----------

describe('Configuração do módulo reservations', () => {
	const config = (values: Record<string, string>) => ({ get: (name: string) => values[name] }) as unknown as ConfigService;

	it('B1.2 URL inválida impede a subida citando a variável', () => {
		expect(() => urlFrom(config({ RESERVATIONS_BASE_URL: 'reservations:8109' }), 'RESERVATIONS_BASE_URL', 'http://x'))
			.toThrow('RESERVATIONS_BASE_URL');
		expect(() => urlFrom(config({ JWT_ISSUER: 'nao e url' }), 'JWT_ISSUER', 'http://x')).toThrow('JWT_ISSUER');
	});

	it('B1.2 número inválido impede a subida citando a variável', () => {
		expect(() => numberFrom(config({ BFF_HTTP_TIMEOUT_MS: 'tres' }), 'BFF_HTTP_TIMEOUT_MS', 3000)).toThrow('BFF_HTTP_TIMEOUT_MS');
	});

	it('ausente usa o valor do .env do base, sem barra no fim', () => {
		expect(urlFrom(config({}), 'RESERVATIONS_BASE_URL', 'http://reservations:8109/')).toBe('http://reservations:8109');
		expect(numberFrom(config({}), 'BFF_HTTP_RETRIES', 2)).toBe(2);
	});

	it('o JWKS sai do JWT_ISSUER', () => {
		const verifier = new KeycloakJwtVerifier({ issuer: 'http://keycloak:8080/realms/constrsw/', audience: 'oauth', timeoutMs: 100 });
		expect(verifier.jwksUrl).toBe('http://keycloak:8080/realms/constrsw/protocol/openid-connect/certs');
	});
});

// ---------- rotação de chave ----------

describe('KeycloakJwtVerifier — rotação de chave', () => {
	it('kid novo depois do cache busca o JWKS de novo', async () => {
		const keycloak = await fakeKeycloak(keys.publicKey);
		try {
			const verifier = new KeycloakJwtVerifier({ issuer: keycloak.issuer, audience: 'oauth', timeoutMs: 500, refreshCooldownMs: 0 });
			const claims = { iss: keycloak.issuer, aud: 'oauth', exp: now() + 300 };
			expect((await verifier.verify(tokenWith(keys.privateKey, claims))).ok).toBe(true);

			keycloak.setKeys([{ ...otherKeys.publicKey.export({ format: 'jwk' }), kid: 'nova', use: 'sig' }]);
			const check = await verifier.verify(tokenWith(otherKeys.privateKey, claims, { kid: 'nova' }));

			expect(check.ok).toBe(true);
			expect(keycloak.hits()).toBe(2);
		}
		finally {
			await close(keycloak.server);
		}
	});

	it('kid desconhecido dentro do intervalo mínimo não busca de novo', async () => {
		const keycloak = await fakeKeycloak(keys.publicKey);
		try {
			const verifier = new KeycloakJwtVerifier({ issuer: keycloak.issuer, audience: 'oauth', timeoutMs: 500, refreshCooldownMs: 60_000 });
			const claims = { iss: keycloak.issuer, aud: 'oauth', exp: now() + 300 };
			await verifier.verify(tokenWith(keys.privateKey, claims));
			for (let i = 0; i < 5; i++) {
				await verifier.verify(tokenWith(keys.privateKey, claims, { kid: `forjado-${i}` }));
			}

			expect(keycloak.hits()).toBe(1);
		}
		finally {
			await close(keycloak.server);
		}
	});
});
