import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { request as rawRequest } from 'node:http';

import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { RESOURCES_CLOCK } from './modules/resources/resources.service';
import { httpFixture, Reply, SeenRequest } from './testing/http-fixture';
import {
	futureReservation,
	occurrence,
	otherResourceReservation,
	pastReservation,
	RESOURCE_ID,
	resolvedOccurrence,
	resource,
	resourceAggregate,
} from './testing/domain-fixtures';

const DOMAIN = '/api/v1/resources';
const RESERVATIONS = '/api/v1/reservations';
const NOW = new Date('2026-11-25T15:00:00Z'); // 12:00 em America/Sao_Paulo

describe('Resources BFF over real HTTP boundaries', () => {
	let app: INestApplication;
	let resources: Awaited<ReturnType<typeof httpFixture>>;
	let reservations: Awaited<ReturnType<typeof httpFixture>>;
	let handler: (seen: SeenRequest) => Reply;
	let reservationsHandler: (seen: SeenRequest) => Reply;
	const originalEnv = { ...process.env };

	beforeEach(async () => {
		handler = defaultHandler;
		reservationsHandler = () => ({ body: '[]' });
		resources = await httpFixture(seen => handler(seen));
		reservations = await httpFixture(seen => reservationsHandler(seen));
		Object.assign(process.env, {
			RESOURCES_BASE_URL: resources.url,
			RESERVATIONS_BASE_URL: reservations.url,
			BFF_HTTP_RETRIES: '0',
			BFF_HTTP_TIMEOUT_MS: '200',
			BFF_CIRCUIT_BREAKER_VOLUME_THRESHOLD: '100',
		});
		const module = await Test.createTestingModule({ imports: [AppModule] })
			.overrideProvider(RESOURCES_CLOCK)
			.useValue(() => NOW)
			.compile();
		app = module.createNestApplication({ bodyParser: false, logger: false });
		configureApp(app);
		await app.init();
	});

	afterEach(async () => {
		await app.close();
		await resources.close();
		await reservations.close();
		for (const key of ['RESOURCES_BASE_URL', 'RESERVATIONS_BASE_URL', 'BFF_HTTP_RETRIES', 'BFF_HTTP_TIMEOUT_MS', 'BFF_CIRCUIT_BREAKER_VOLUME_THRESHOLD']) {
			if (originalEnv[key] === undefined) delete process.env[key]; else process.env[key] = originalEnv[key];
		}
	});

	it('lista com openOccurrenceCount e repassa token sem Origin nem cookie', async () => {
		const response = await request(app.getHttpServer())
			.get('/api/v1/resources?code=PROJ-01&tag=av')
			.set('authorization', 'Bearer caller-access')
			.set('origin', 'http://localhost:4200')
			.set('cookie', 'closed_cras_session=' + encodeURIComponent('{"access_token":"cookie-access","refresh_token":"keep-private"}'))
			.expect(200);

		expect(response.body).toEqual([{ ...summary(resource), openOccurrenceCount: 1 }]);
		expect(response.body[0]).not.toHaveProperty('enabled');
		expect(resources.seen.map(seen => seen.url)).toEqual([`${DOMAIN}?code=PROJ-01&tag=av`, `${DOMAIN}/${RESOURCE_ID}`]);
		expect(reservations.seen.map(seen => seen.url)).toEqual([RESERVATIONS]);
		for (const seen of [...resources.seen, ...reservations.seen]) {
			expect(seen.headers.authorization).toBe('Bearer caller-access');
			expect(seen.headers.origin).toBeUndefined();
			expect(seen.headers.cookie).toBeUndefined();
			expect(JSON.stringify(seen)).not.toContain('keep-private');
		}
	});

	it('encaminha somente o access_token do cookie de sessão', async () => {
		await request(app.getHttpServer())
			.get('/api/v1/resources')
			.set('cookie', 'closed_cras_session=' + encodeURIComponent('{"access_token":"cookie-access","refresh_token":"keep-private"}'))
			.expect(200);

		for (const seen of [...resources.seen, ...reservations.seen]) {
			expect(seen.headers.authorization).toBe('Bearer cookie-access');
			expect(seen.headers.cookie).toBeUndefined();
			expect(JSON.stringify(seen)).not.toContain('keep-private');
		}
	});

	it('encaminha somente os filtros documentados no contrato', async () => {
		await request(app.getHttpServer())
			.get('/api/v1/resources?enabled=false&name=x&code=PROJ-01')
			.set('authorization', 'Bearer caller-access')
			.expect(200);

		expect(resources.seen[0].url).toBe(`${DOMAIN}?code=PROJ-01`);
	});

	it('codifica o identificador uma única vez (%2F não vira %252F)', async () => {
		handler = () => ({ status: 404, body: '{}' });
		await app.listen(0, '127.0.0.1');
		const port = app.getHttpServer().address().port;
		const status = await new Promise<number>((resolve, reject) => {
			const pending = rawRequest({ host: '127.0.0.1', port, method: 'GET', path: '/api/v1/resources/a%2Fb', headers: { authorization: 'Bearer caller-access' } }, response => {
				response.resume();
				response.on('end', () => resolve(response.statusCode!));
			});
			pending.on('error', reject);
			pending.end();
		});
		expect(status).toBe(404);
		expect(resources.seen[0].url).toBe(`${DOMAIN}/a%2Fb`);
	});

	it('monta cada item da lista a partir do agregado já lido', async () => {
		handler = seen => seen.url.split('?')[0] === DOMAIN
			? { body: JSON.stringify([{ ...resource, name: 'snapshot antigo' }]) }
			: { body: JSON.stringify({ ...resourceAggregate, name: 'agregado atual' }) };

		const response = await request(app.getHttpServer())
			.get('/api/v1/resources')
			.set('authorization', 'Bearer caller-access')
			.expect(200);

		expect(response.body[0].name).toBe('agregado atual');
	});

	it('deduplica tags do domínio antes de responder', async () => {
		handler = seen => seen.url.split('?')[0] === DOMAIN
			? { body: JSON.stringify([{ ...resource, tags: ['av', 'av', 'portable'] }]) }
			: { body: JSON.stringify({ ...resourceAggregate, tags: ['av', 'av', 'portable'] }) };

		const response = await request(app.getHttpServer())
			.get('/api/v1/resources')
			.set('authorization', 'Bearer caller-access')
			.expect(200);

		expect(response.body[0].tags).toEqual(['av', 'portable']);
	});

	it('lista dois recursos com contagens abertas diferentes e lê cada detalhe', async () => {
		const secondId = '99999999-9999-4999-8999-999999999999';
		const secondOccurrence = { ...occurrence, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
		const second = { ...resource, id: secondId, code: 'PROJ-02', name: 'Projector 2' };
		handler = seen => {
			const path = seen.url.split('?')[0];
			if (path === DOMAIN) return { body: JSON.stringify([resource, second]) };
			if (path === `${DOMAIN}/${RESOURCE_ID}`) return { body: JSON.stringify({ ...resourceAggregate, occurrences: [occurrence, secondOccurrence] }) };
			if (path === `${DOMAIN}/${secondId}`) return { body: JSON.stringify({ ...second, occurrences: [] }) };
			return { status: 404, body: '{}' };
		};

		const response = await request(app.getHttpServer())
			.get('/api/v1/resources')
			.set('authorization', 'Bearer caller-access')
			.expect(200);

		expect(response.body.map((item: { id: string; openOccurrenceCount: number }) => [item.id, item.openOccurrenceCount]))
			.toEqual([[RESOURCE_ID, 2], [secondId, 0]]);
		expect(resources.seen.map(seen => seen.url)).toEqual([DOMAIN, `${DOMAIN}/${RESOURCE_ID}`, `${DOMAIN}/${secondId}`]);
		expect(reservations.seen.map(seen => seen.url)).toEqual([RESERVATIONS]);
	});

	it('compõe apenas as reservations futuras do próprio recurso na lista', async () => {
		const cancelled = { ...futureReservation, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', status: 'CANCELLED' };
		reservationsHandler = () => ({ body: JSON.stringify([futureReservation, pastReservation, otherResourceReservation, cancelled]) });

		const response = await request(app.getHttpServer())
			.get('/api/v1/resources')
			.set('authorization', 'Bearer caller-access')
			.expect(200);

		expect(response.body[0].reservations).toEqual([futureReservation, cancelled]);
		expect(reservations.seen.map(seen => seen.url)).toEqual([RESERVATIONS]);
	});

	it('detalhe consulta reservations pelo resourceId e filtra o futuro', async () => {
		reservationsHandler = () => ({ body: JSON.stringify([futureReservation, pastReservation, otherResourceReservation]) });

		const response = await request(app.getHttpServer())
			.get(`/api/v1/resources/${RESOURCE_ID}`)
			.set('authorization', 'Bearer caller-access')
			.expect(200);

		expect(response.body.reservations).toEqual([futureReservation]);
		expect(reservations.seen.map(seen => seen.url)).toEqual([`${RESERVATIONS}?resourceId=${RESOURCE_ID}`]);
	});

	it('remove etag/last-modified e envia cache-control no-store nas leituras compostas', async () => {
		const headers = { etag: '"v1"', 'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT' };
		handler = seen => seen.url.split('?')[0] === DOMAIN
			? { body: JSON.stringify([resource]), headers }
			: { body: JSON.stringify(resourceAggregate), headers };

		const list = await request(app.getHttpServer())
			.get('/api/v1/resources')
			.set('authorization', 'Bearer caller-access')
			.expect(200);
		expect(list.headers.etag).toBeUndefined();
		expect(list.headers['last-modified']).toBeUndefined();
		expect(list.headers['cache-control']).toBe('no-store');

		const detail = await request(app.getHttpServer())
			.get(`/api/v1/resources/${RESOURCE_ID}`)
			.set('authorization', 'Bearer caller-access')
			.expect(200);
		expect(detail.headers.etag).toBeUndefined();
		expect(detail.headers['last-modified']).toBeUndefined();
		expect(detail.headers['cache-control']).toBe('no-store');
	});

	it('detalhe compõe occurrences e remove enabled', async () => {
		const response = await request(app.getHttpServer())
			.get(`/api/v1/resources/${RESOURCE_ID}`)
			.set('authorization', 'Bearer caller-access')
			.expect(200);

		expect(response.body).toEqual({
			...summary(resource),
			openOccurrenceCount: 1,
			occurrences: [withoutEnabled(occurrence)],
		});
		expect(JSON.stringify(response.body)).not.toContain('"enabled"');
	});

	it('cria recurso com Location no prefixo do browser e sem enabled', async () => {
		const response = await request(app.getHttpServer())
			.post('/api/v1/resources')
			.set('authorization', 'Bearer caller-access')
			.send({ code: 'PROJ-01', name: 'Projector 1', type: 'PROJECTOR' })
			.expect(201);

		expect(response.headers.location).toBe(`/api/v1/resources/${RESOURCE_ID}`);
		expect(response.body).toEqual({ ...summary(resource), openOccurrenceCount: 0, occurrences: [] });
		expect(resources.seen[0].body).toBe('{"code":"PROJ-01","name":"Projector 1","type":"PROJECTOR"}');
		expect(reservations.seen).toHaveLength(0);
	});

	it('envia text/plain ao domínio e repassa o 415 problem+json', async () => {
		const problem = JSON.stringify({
			type: 'urn:closed-cras:unsupported-media-type', title: 'Unsupported media type', status: 415,
			detail: 'The request body must be application/json.', instance: DOMAIN, code: 'UNSUPPORTED_MEDIA_TYPE',
		});
		handler = () => ({ status: 415, body: problem, headers: { 'content-type': 'application/problem+json' } });

		const response = await request(app.getHttpServer())
			.post('/api/v1/resources')
			.set('authorization', 'Bearer caller-access')
			.set('content-type', 'text/plain')
			.send('hello')
			.expect(415);

		expect(resources.seen[0].headers['content-type']).toBe('text/plain');
		expect(resources.seen[0].body).toBe('hello');
		expect(response.headers['content-type']).toContain('application/problem+json');
		expect(response.text).toBe(problem);
	});

	it('POST autenticado por cookie leva somente o Bearer do access_token ao domínio', async () => {
		const response = await request(app.getHttpServer())
			.post('/api/v1/resources')
			.set('cookie', 'closed_cras_session=' + encodeURIComponent('{"access_token":"cookie-access","refresh_token":"keep-private"}'))
			.send({ code: 'PROJ-01', name: 'Projector 1', type: 'PROJECTOR' })
			.expect(201);

		expect(response.status).toBe(201);
		expect(resources.seen[0].headers.authorization).toBe('Bearer cookie-access');
		expect(resources.seen[0].headers.cookie).toBeUndefined();
		expect(JSON.stringify(resources.seen[0])).not.toContain('keep-private');
	});

	it('atualiza o agregado, mantém a contagem e compõe reservations', async () => {
		reservationsHandler = () => ({ body: JSON.stringify([futureReservation]) });

		const response = await request(app.getHttpServer())
			.patch(`/api/v1/resources/${RESOURCE_ID}`)
			.set('authorization', 'Bearer caller-access')
			.send({ active: false })
			.expect(200);

		expect(response.body).toEqual({
			...summary(resource, [futureReservation]),
			openOccurrenceCount: 1,
			occurrences: [withoutEnabled(occurrence)],
		});
	});

	it('registra ocorrência com Location no prefixo do browser e sem enabled', async () => {
		const response = await request(app.getHttpServer())
			.post(`/api/v1/resources/${RESOURCE_ID}/occurrences`)
			.set('authorization', 'Bearer caller-access')
			.send({ description: 'Lamp does not turn on', type: 'MALFUNCTION' })
			.expect(201);

		expect(response.headers.location).toBe(`/api/v1/resources/${RESOURCE_ID}/occurrences/${occurrence.id}`);
		expect(response.body).toEqual(withoutEnabled(occurrence));
	});

	it('resolve a ocorrência e o próximo detalhe conta uma a menos', async () => {
		handler = seen => seen.url.endsWith(`/occurrences/${occurrence.id}`)
			? { body: JSON.stringify(resolvedOccurrence) }
			: { body: JSON.stringify({ ...resourceAggregate, occurrences: [resolvedOccurrence] }) };

		const resolved = await request(app.getHttpServer())
			.patch(`/api/v1/resources/${RESOURCE_ID}/occurrences/${occurrence.id}`)
			.set('authorization', 'Bearer caller-access')
			.send({ resolution: 'Lamp replaced' })
			.expect(200);

		expect(resolved.body).toEqual(withoutEnabled(resolvedOccurrence));
		expect(resources.seen[0].body).toBe('{"resolution":"Lamp replaced"}');

		const detail = await request(app.getHttpServer())
			.get(`/api/v1/resources/${RESOURCE_ID}`)
			.set('authorization', 'Bearer caller-access')
			.expect(200);

		expect(detail.body.openOccurrenceCount).toBe(0);
	});

	it('exclui logicamente o recurso pelo BFF e repassa o 204 do domínio', async () => {
		const response = await request(app.getHttpServer())
			.delete(`/api/v1/resources/${RESOURCE_ID}`)
			.set('authorization', 'Bearer caller-access')
			.expect(204);

		expect(response.text).toBe('');
		expect(resources.seen[0].method).toBe('DELETE');
		expect(resources.seen[0].url).toBe(`${DOMAIN}/${RESOURCE_ID}`);
		expect(reservations.seen).toHaveLength(0);
	});

	it('exclui logicamente a ocorrência pelo BFF', async () => {
		const response = await request(app.getHttpServer())
			.delete(`/api/v1/resources/${RESOURCE_ID}/occurrences/${occurrence.id}`)
			.set('authorization', 'Bearer caller-access')
			.expect(204);

		expect(response.text).toBe('');
		expect(resources.seen[0].method).toBe('DELETE');
		expect(resources.seen[0].url).toBe(`${DOMAIN}/${RESOURCE_ID}/occurrences/${occurrence.id}`);
	});

	it('repassa o 409 da segunda resolução sem alterar o corpo', async () => {
		const problem = JSON.stringify({
			type: 'urn:closed-cras:recusa:FR-22', title: 'Business rule refused', status: 409,
			detail: 'A resolved occurrence is terminal.', instance: `${DOMAIN}/${RESOURCE_ID}/occurrences/${occurrence.id}`,
			code: 'FR-22', reason: 'OCCURRENCE_ALREADY_RESOLVED',
		});
		handler = () => ({ status: 409, body: problem, headers: { 'content-type': 'application/problem+json' } });

		const response = await request(app.getHttpServer())
			.patch(`/api/v1/resources/${RESOURCE_ID}/occurrences/${occurrence.id}`)
			.set('authorization', 'Bearer caller-access')
			.send({ resolution: 'again' })
			.expect(409);

		expect(response.headers['content-type']).toContain('application/problem+json');
		expect(response.text).toBe(problem);
	});

	it('repassa 422 de código duplicado/forma inválida sem reinterpretar', async () => {
		const problem = JSON.stringify({
			type: 'urn:closed-cras:validation', title: 'Validation failed', status: 422,
			detail: 'The request body has invalid fields.', instance: DOMAIN, code: 'VALIDATION',
			errors: [{ field: 'code', message: 'must be 3-32 characters' }],
		});
		handler = () => ({ status: 422, body: problem, headers: { 'content-type': 'application/problem+json' } });

		const response = await request(app.getHttpServer())
			.post('/api/v1/resources')
			.set('authorization', 'Bearer caller-access')
			.send({ code: 'x' })
			.expect(422);

		expect(response.text).toBe(problem);
		expect(response.body.errors).toEqual([{ field: 'code', message: 'must be 3-32 characters' }]);
	});

	it('encaminha o corpo cru e devolve o 400 problem+json do domínio para JSON malformado', async () => {
		const problem = JSON.stringify({
			type: 'urn:closed-cras:malformed-request', title: 'Malformed request', status: 400,
			detail: 'The request body is not valid JSON.', instance: DOMAIN, code: 'MALFORMED_REQUEST',
		});
		handler = () => ({ status: 400, body: problem, headers: { 'content-type': 'application/problem+json' } });

		const response = await request(app.getHttpServer())
			.post('/api/v1/resources')
			.set('authorization', 'Bearer caller-access')
			.set('content-type', 'application/json')
			.send('{broken')
			.expect(400);

		expect(resources.seen[0].body).toBe('{broken');
		expect(response.text).toBe(problem);
	});

	it('repassa 403 de papel sem lógica de papel no BFF', async () => {
		const problem = JSON.stringify({
			type: 'urn:closed-cras:auth:forbidden', title: 'Access denied', status: 403,
			detail: 'This operation requires write access.', instance: DOMAIN, code: 'AUTH_FORBIDDEN', reason: 'ROLE_NOT_ALLOWED',
		});
		handler = () => ({ status: 403, body: problem, headers: { 'content-type': 'application/problem+json' } });

		const response = await request(app.getHttpServer())
			.post('/api/v1/resources')
			.set('authorization', 'Bearer read-only')
			.send({ code: 'PROJ-01', name: 'Projector', type: 'PROJECTOR' })
			.expect(403);

		expect(response.text).toBe(problem);
	});

	it.each([
		['get', '/api/v1/resources'],
		['post', '/api/v1/resources'],
		['get', `/api/v1/resources/${RESOURCE_ID}`],
		['patch', `/api/v1/resources/${RESOURCE_ID}`],
		['post', `/api/v1/resources/${RESOURCE_ID}/occurrences`],
		['patch', `/api/v1/resources/${RESOURCE_ID}/occurrences/${occurrence.id}`],
		['delete', `/api/v1/resources/${RESOURCE_ID}`],
		['delete', `/api/v1/resources/${RESOURCE_ID}/occurrences/${occurrence.id}`],
	])('gera 401 problem+json sem chamar o domínio em %s %s', async (method, path) => {
		const response = await (request(app.getHttpServer()) as any)[method](path).expect(401);

		expect(response.headers['content-type']).toContain('application/problem+json');
		expect(response.body).toMatchObject({ status: 401, code: 'AUTH_UNAUTHENTICATED', reason: 'MISSING_TOKEN' });
		expect(resources.seen).toHaveLength(0);
		expect(reservations.seen).toHaveLength(0);
	});

	it('devolve 503 RESOURCES_UPSTREAM_UNAVAILABLE quando o domínio não responde', async () => {
		handler = () => ({ delay: 1_000 });

		const response = await request(app.getHttpServer())
			.get('/api/v1/resources')
			.set('authorization', 'Bearer caller-access')
			.expect(503);

		expect(response.headers['content-type']).toContain('application/problem+json');
		expect(response.body).toMatchObject({ status: 503, code: 'DEPENDENCY_UNAVAILABLE', reason: 'RESOURCES_UPSTREAM_UNAVAILABLE' });
		expect(response.body).not.toHaveProperty('items');
	});

	it('devolve 503 sem lista parcial quando um detalhe falha', async () => {
		handler = seen => seen.url === DOMAIN
			? { body: JSON.stringify([resource]) }
			: { status: 500, body: '{}' };

		const response = await request(app.getHttpServer())
			.get('/api/v1/resources')
			.set('authorization', 'Bearer caller-access')
			.expect(503);

		expect(response.body.reason).toBe('RESOURCES_UPSTREAM_UNAVAILABLE');
		expect(response.body).not.toHaveProperty('items');
	});

	it('devolve 503 sem lista parcial quando reservations falha', async () => {
		reservationsHandler = () => ({ status: 500, body: '{}' });

		const response = await request(app.getHttpServer())
			.get('/api/v1/resources')
			.set('authorization', 'Bearer caller-access')
			.expect(503);

		expect(response.body).toMatchObject({ status: 503, code: 'DEPENDENCY_UNAVAILABLE', reason: 'RESOURCES_UPSTREAM_UNAVAILABLE' });
		expect(Array.isArray(response.body)).toBe(false);
	});

	it('devolve 503 quando reservations não responde', async () => {
		reservationsHandler = () => ({ delay: 1_000 });

		const response = await request(app.getHttpServer())
			.get(`/api/v1/resources/${RESOURCE_ID}`)
			.set('authorization', 'Bearer caller-access')
			.expect(503);

		expect(response.body.reason).toBe('RESOURCES_UPSTREAM_UNAVAILABLE');
	});

	it('devolve 503 quando reservations devolve payload fora do contrato', async () => {
		reservationsHandler = () => ({ body: JSON.stringify({ items: [] }) });

		const response = await request(app.getHttpServer())
			.get('/api/v1/resources')
			.set('authorization', 'Bearer caller-access')
			.expect(503);

		expect(response.body.reason).toBe('RESOURCES_UPSTREAM_UNAVAILABLE');
	});

	it('preserva o status e o corpo de um 503 do próprio domínio', async () => {
		const problem = JSON.stringify({ type: 'urn:closed-cras:dependency:unavailable', title: 'Dependency unavailable', status: 503, detail: 'database down', instance: DOMAIN, code: 'DEPENDENCY_UNAVAILABLE', reason: 'DATABASE_UNAVAILABLE' });
		handler = () => ({ status: 503, body: problem, headers: { 'content-type': 'application/problem+json' } });

		const response = await request(app.getHttpServer())
			.get('/api/v1/resources')
			.set('authorization', 'Bearer caller-access')
			.expect(503);

		expect(response.text).toBe(problem);
		expect(response.body.reason).toBe('DATABASE_UNAVAILABLE');
	});

	it('não expõe roster, Student, availability, occupancy nem inventory-item', async () => {
		const response = await request(app.getHttpServer())
			.get(`/api/v1/resources/${RESOURCE_ID}`)
			.set('authorization', 'Bearer caller-access')
			.expect(200);

		const body = JSON.stringify(response.body);
		for (const forbidden of ['roster', 'student', 'availability', 'occupancy', 'inventory']) {
			expect(body.toLowerCase()).not.toContain(forbidden);
		}
		expect(body).not.toContain('"enabled"');
	});

	it('recusa segmento de ponto em identificador antes da normalização da URL', async () => {
		await app.listen(0, '127.0.0.1');
		const port = app.getHttpServer().address().port;
		const status = await new Promise<number>((resolve, reject) => {
			const pending = rawRequest({ host: '127.0.0.1', port, method: 'GET', path: `/api/v1/resources/${'%2e%2e'}`, headers: { authorization: 'Bearer caller-access' } }, response => {
				response.resume();
				response.on('end', () => resolve(response.statusCode!));
			});
			pending.on('error', reject);
			pending.end();
		});
		expect(status).toBe(400);
		expect(resources.seen).toHaveLength(0);
	});
});

function defaultHandler(seen: SeenRequest): Reply {
	const path = seen.url.split('?')[0];
	if (seen.method === 'GET' && path === DOMAIN) return { body: JSON.stringify([resource]) };
	if (seen.method === 'GET' && path === `${DOMAIN}/${RESOURCE_ID}`) return { body: JSON.stringify(resourceAggregate) };
	if (seen.method === 'PATCH' && path === `${DOMAIN}/${RESOURCE_ID}`) return { body: JSON.stringify(resourceAggregate) };
	if (seen.method === 'POST' && path === DOMAIN) {
		return { status: 201, body: JSON.stringify(resource), headers: { location: `${DOMAIN}/${RESOURCE_ID}` } };
	}
	if (seen.method === 'POST' && path === `${DOMAIN}/${RESOURCE_ID}/occurrences`) {
		return { status: 201, body: JSON.stringify(occurrence), headers: { location: `${DOMAIN}/${RESOURCE_ID}/occurrences/${occurrence.id}` } };
	}
	if (seen.method === 'PATCH' && path.endsWith(`/occurrences/${occurrence.id}`)) {
		return { body: JSON.stringify(resolvedOccurrence) };
	}
	if (seen.method === 'DELETE' && (path === `${DOMAIN}/${RESOURCE_ID}` || path.endsWith(`/occurrences/${occurrence.id}`))) {
		return { status: 204 };
	}
	return { status: 404, body: '{}' };
}

function summary(value: typeof resource, reservations: unknown[] = []): Record<string, unknown> {
	const { enabled: _enabled, ...rest } = value;
	return { ...rest, reservations };
}

function withoutEnabled(value: Record<string, unknown>): Record<string, unknown> {
	const { enabled: _enabled, ...rest } = value;
	return rest;
}
