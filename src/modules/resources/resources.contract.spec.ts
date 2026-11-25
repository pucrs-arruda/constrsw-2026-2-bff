import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { DownstreamResponse, DownstreamService, DownstreamUnavailableError } from '../../common/http/downstream.service';
import {
	futureReservation,
	occurrence,
	RESOURCE_ID,
	resolvedOccurrence,
	resource,
	resourceAggregate,
} from '../../testing/domain-fixtures';
import { ResourcesController } from './resources.controller';
import {
	RESERVATIONS_DOWNSTREAM,
	RESOURCES_CLOCK,
	RESOURCES_DOWNSTREAM,
	ResourcesService,
	unavailable,
} from './resources.service';

const OPEN = '/api/v1/resources';
const RESERVATIONS = '/api/v1/reservations';
const NOW = new Date('2026-11-25T15:00:00Z'); // 12:00 em America/Sao_Paulo

interface SentCall { method: string; path: string; body?: string; contentType?: string; bearerToken?: string }

describe('Proxy de resources (fronteira BFF↔domínio)', () => {
	let app: INestApplication;
	let resourcesSent: SentCall[];
	let reservationsSent: SentCall[];
	let reply: (call: SentCall) => DownstreamResponse;
	let reservationsReply: (call: SentCall) => DownstreamResponse;

	beforeEach(async () => {
		resourcesSent = [];
		reservationsSent = [];
		reply = (call) => {
			const path = call.path.split('?')[0];
			if (path === OPEN) return json(200, [resource]);
			if (path === `${OPEN}/${RESOURCE_ID}` && call.method === 'GET') return json(200, resourceAggregate);
			if (path === `${OPEN}/${RESOURCE_ID}` && call.method === 'PATCH') return json(200, resourceAggregate);
			if (path === `${OPEN}/${RESOURCE_ID}/occurrences` && call.method === 'POST') {
				return { ...json(201, occurrence), location: `${OPEN}/${RESOURCE_ID}/occurrences/${occurrence.id}` };
			}
			if (path.endsWith(`/occurrences/${occurrence.id}`) && call.method === 'PATCH') return json(200, resolvedOccurrence);
			if (call.method === 'DELETE') return { status: 204, body: '', contentType: null };
			return json(200, {});
		};
		reservationsReply = () => json(200, []);

		const resourcesDownstream = {
			send: jest.fn(async (call: SentCall) => {
				resourcesSent.push(call);
				return reply(call);
			}),
		} as unknown as DownstreamService;
		const reservationsDownstream = {
			send: jest.fn(async (call: SentCall) => {
				reservationsSent.push(call);
				return reservationsReply(call);
			}),
		} as unknown as DownstreamService;

		const moduleRef = await Test.createTestingModule({
			controllers: [ResourcesController],
			providers: [
				ResourcesService,
				{ provide: RESOURCES_DOWNSTREAM, useValue: resourcesDownstream },
				{ provide: RESERVATIONS_DOWNSTREAM, useValue: reservationsDownstream },
				{ provide: RESOURCES_CLOCK, useValue: () => NOW },
			],
		}).compile();

		app = moduleRef.createNestApplication();
		await app.init();
	});

	afterEach(async () => {
		await app.close();
	});

	it('mapeia /api/v1/resources para o domínio preservando a query string', async () => {
		await request(app.getHttpServer())
			.get('/api/v1/resources?code=PROJ-01&type=PROJECTOR&active=true&tag=av')
			.set('authorization', 'Bearer token-do-usuario')
			.expect(200);

		expect(resourcesSent[0].path).toBe(`${OPEN}?code=PROJ-01&type=PROJECTOR&active=true&tag=av`);
		expect(resourcesSent[0].method).toBe('GET');
		expect(resourcesSent[0].bearerToken).toBe('token-do-usuario');
	});

	it('gera 401 problem+json sem chamar o domínio quando não há sessão', async () => {
		const response = await request(app.getHttpServer()).get('/api/v1/resources').expect(401);

		expect(response.headers['content-type']).toContain('application/problem+json');
		expect(response.body).toMatchObject({ status: 401, code: 'AUTH_UNAUTHENTICATED', reason: 'MISSING_TOKEN' });
		expect(resourcesSent).toHaveLength(0);
		expect(reservationsSent).toHaveLength(0);
	});

	it('compõe openOccurrenceCount por item da lista lendo cada agregado', async () => {
		const response = await request(app.getHttpServer())
			.get('/api/v1/resources')
			.set('authorization', 'Bearer token')
			.expect(200);

		expect(response.body).toEqual([{ ...summary(resource), openOccurrenceCount: 1 }]);
		expect(response.body[0]).not.toHaveProperty('enabled');
		expect(resourcesSent.map(call => call.path)).toEqual([OPEN, `${OPEN}/${RESOURCE_ID}`]);
		expect(reservationsSent.map(call => call.path)).toEqual([RESERVATIONS]);
	});

	it('compõe apenas as reservations futuras do próprio recurso', async () => {
		const past = { ...futureReservation, id: '99999999-9999-4999-8999-999999999998', faixaId: 'A' };
		const other = { ...futureReservation, id: '99999999-9999-4999-8999-999999999997', resourceIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'] };
		reservationsReply = () => json(200, [futureReservation, past, other]);

		const response = await request(app.getHttpServer())
			.get('/api/v1/resources')
			.set('authorization', 'Bearer token')
			.expect(200);

		expect(response.body[0].reservations).toEqual([futureReservation]);
		expect(reservationsSent[0].path).toBe(RESERVATIONS);
		expect(reservationsSent[0].bearerToken).toBe('token');
	});

	it('devolve o agregado de detalhe com occurrences e sem enabled', async () => {
		reply = () => json(200, { ...resourceAggregate, occurrences: [occurrence, resolvedOccurrence] });
		reservationsReply = () => json(200, [futureReservation]);

		const response = await request(app.getHttpServer())
			.get(`/api/v1/resources/${RESOURCE_ID}`)
			.set('authorization', 'Bearer token')
			.expect(200);

		expect(response.body).toEqual({
			...summary(resource, [futureReservation]),
			openOccurrenceCount: 1,
			occurrences: [withoutEnabled(occurrence), withoutEnabled(resolvedOccurrence)],
		});
		expect(reservationsSent[0].path).toBe(`${RESERVATIONS}?resourceId=${RESOURCE_ID}`);
		expect(response.body).not.toHaveProperty('enabled');
		for (const item of response.body.occurrences) expect(item).not.toHaveProperty('enabled');
	});

	it('cria recurso com occurrences/reservations vazias, count 0 e Location no prefixo do browser', async () => {
		reply = () => ({ ...json(201, resource), location: `${OPEN}/${RESOURCE_ID}` });

		const response = await request(app.getHttpServer())
			.post('/api/v1/resources')
			.set('authorization', 'Bearer token')
			.send({ code: 'PROJ-01', name: 'Projector 1', type: 'PROJECTOR' })
			.expect(201);

		expect(response.headers.location).toBe(`/api/v1/resources/${RESOURCE_ID}`);
		expect(response.body).toEqual({ ...summary(resource), openOccurrenceCount: 0, occurrences: [] });
		expect(resourcesSent[0].body).toBe('{"code":"PROJ-01","name":"Projector 1","type":"PROJECTOR"}');
		expect(reservationsSent).toHaveLength(0);
	});

	it('atualiza recurso compondo o agregado e as reservations', async () => {
		reservationsReply = () => json(200, [futureReservation]);

		const response = await request(app.getHttpServer())
			.patch(`/api/v1/resources/${RESOURCE_ID}`)
			.set('authorization', 'Bearer token')
			.send({ active: false })
			.expect(200);

		expect(response.body).toEqual({
			...summary(resource, [futureReservation]),
			openOccurrenceCount: 1,
			occurrences: [withoutEnabled(occurrence)],
		});
		expect(resourcesSent[0].method).toBe('PATCH');
		expect(resourcesSent[0].body).toBe('{"active":false}');
	});

	it('registra ocorrência sem enabled e mantém o Location do domínio', async () => {
		const response = await request(app.getHttpServer())
			.post(`/api/v1/resources/${RESOURCE_ID}/occurrences`)
			.set('authorization', 'Bearer token')
			.send({ description: 'Lamp does not turn on', type: 'MALFUNCTION' })
			.expect(201);

		expect(response.headers.location).toBe(`/api/v1/resources/${RESOURCE_ID}/occurrences/${occurrence.id}`);
		expect(response.body).toEqual(withoutEnabled(occurrence));
	});

	it('resolve a ocorrência devolvendo o corpo do domínio sem enabled', async () => {
		const response = await request(app.getHttpServer())
			.patch(`/api/v1/resources/${RESOURCE_ID}/occurrences/${occurrence.id}`)
			.set('authorization', 'Bearer token')
			.send({ resolution: 'Lamp replaced' })
			.expect(200);

		expect(response.body).toEqual(withoutEnabled(resolvedOccurrence));
		expect(response.body.status).toBe('RESOLVED');
	});

	it('exclui logicamente o recurso pelo verbo DELETE e devolve 204 sem corpo', async () => {
		const response = await request(app.getHttpServer())
			.delete(`/api/v1/resources/${RESOURCE_ID}`)
			.set('authorization', 'Bearer token')
			.expect(204);

		expect(response.text).toBe('');
		expect(resourcesSent[0].method).toBe('DELETE');
		expect(resourcesSent[0].path).toBe(`${OPEN}/${RESOURCE_ID}`);
		expect(reservationsSent).toHaveLength(0);
	});

	it('exclui logicamente a ocorrência pelo caminho aninhado', async () => {
		const response = await request(app.getHttpServer())
			.delete(`/api/v1/resources/${RESOURCE_ID}/occurrences/${occurrence.id}`)
			.set('authorization', 'Bearer token')
			.expect(204);

		expect(response.text).toBe('');
		expect(resourcesSent[0].method).toBe('DELETE');
		expect(resourcesSent[0].path).toBe(`${OPEN}/${RESOURCE_ID}/occurrences/${occurrence.id}`);
	});

	it('não chama o domínio no DELETE sem sessão', async () => {
		await request(app.getHttpServer()).delete(`/api/v1/resources/${RESOURCE_ID}`).expect(401);
		expect(resourcesSent).toHaveLength(0);
	});

	it('repassa 409 do domínio byte a byte', async () => {
		const problem = JSON.stringify({ type: 'urn:closed-cras:recusa:FR-22', title: 'Business rule refused', status: 409, detail: 'already', instance: OPEN, code: 'FR-22', reason: 'OCCURRENCE_ALREADY_RESOLVED' });
		reply = () => ({ status: 409, body: problem, contentType: 'application/problem+json' });

		const response = await request(app.getHttpServer())
			.patch(`/api/v1/resources/${RESOURCE_ID}/occurrences/${occurrence.id}`)
			.set('authorization', 'Bearer token')
			.send({ resolution: 'again' })
			.expect(409);

		expect(response.headers['content-type']).toContain('application/problem+json');
		expect(response.text).toBe(problem);
	});

	it('repassa 422 de validação do domínio sem reinterpretar', async () => {
		const problem = JSON.stringify({ type: 'urn:closed-cras:validation', title: 'Validation failed', status: 422, detail: 'invalid', instance: OPEN, code: 'VALIDATION', errors: [{ field: 'code', message: 'invalid' }] });
		reply = () => ({ status: 422, body: problem, contentType: 'application/problem+json' });

		const response = await request(app.getHttpServer())
			.post('/api/v1/resources')
			.set('authorization', 'Bearer token')
			.send({ code: 'x' })
			.expect(422);

		expect(response.text).toBe(problem);
	});

	it('repassa 403 de papel somente leitura vindo do domínio', async () => {
		const problem = JSON.stringify({ type: 'urn:closed-cras:auth:forbidden', title: 'Access denied', status: 403, detail: 'role', instance: OPEN, code: 'AUTH_FORBIDDEN', reason: 'ROLE_NOT_ALLOWED' });
		reply = () => ({ status: 403, body: problem, contentType: 'application/problem+json' });

		const response = await request(app.getHttpServer())
			.post('/api/v1/resources')
			.set('authorization', 'Bearer token')
			.send({ code: 'PROJ-01', name: 'Projector', type: 'PROJECTOR' })
			.expect(403);

		expect(response.text).toBe(problem);
	});

	it('traduz falha de transporte em 503 RESOURCES_UPSTREAM_UNAVAILABLE', async () => {
		reply = () => { throw new DownstreamUnavailableError('resources', 'circuito aberto'); };

		const response = await request(app.getHttpServer())
			.get('/api/v1/resources')
			.set('authorization', 'Bearer token')
			.expect(503);

		expect(response.headers['content-type']).toContain('application/problem+json');
		expect(response.body).toMatchObject({ status: 503, code: 'DEPENDENCY_UNAVAILABLE', reason: 'RESOURCES_UPSTREAM_UNAVAILABLE' });
		expect(response.body).toEqual(JSON.parse(unavailable('/api/v1/resources').body));
	});

	it('traduz falha da composição de reservations em 503 sem corpo parcial', async () => {
		reservationsReply = () => ({ status: 500, body: '{}', contentType: 'application/json' });

		const response = await request(app.getHttpServer())
			.get('/api/v1/resources')
			.set('authorization', 'Bearer token')
			.expect(503);

		expect(response.body).toMatchObject({ status: 503, code: 'DEPENDENCY_UNAVAILABLE', reason: 'RESOURCES_UPSTREAM_UNAVAILABLE' });
		expect(Array.isArray(response.body)).toBe(false);
	});

	it('devolve 503 quando reservations devolve payload fora do contrato', async () => {
		reservationsReply = () => json(200, { items: [] });

		const response = await request(app.getHttpServer())
			.get(`/api/v1/resources/${RESOURCE_ID}`)
			.set('authorization', 'Bearer token')
			.expect(503);

		expect(response.body.reason).toBe('RESOURCES_UPSTREAM_UNAVAILABLE');
	});

	it('devolve 503 sem corpo parcial quando a leitura de um detalhe falha', async () => {
		reply = (call) => call.path === OPEN
			? json(200, [resource])
			: { status: 500, body: '{}', contentType: 'application/json' };

		const response = await request(app.getHttpServer())
			.get('/api/v1/resources')
			.set('authorization', 'Bearer token')
			.expect(503);

		expect(response.body.reason).toBe('RESOURCES_UPSTREAM_UNAVAILABLE');
		expect(response.body).not.toHaveProperty('items');
	});

	it('devolve 500 problem+json INTERNAL_ERROR para erro inesperado', async () => {
		reply = () => { throw new Error('falha inesperada'); };

		const response = await request(app.getHttpServer())
			.get('/api/v1/resources')
			.set('authorization', 'Bearer token')
			.expect(500);

		expect(response.headers['content-type']).toContain('application/problem+json');
		expect(response.body).toMatchObject({
			type: 'urn:closed-cras:internal',
			title: 'Internal error',
			status: 500,
			detail: 'An unexpected error occurred.',
			code: 'INTERNAL_ERROR',
		});
	});

	const invalidSuccess: Array<{
		name: string;
		method: 'get' | 'post' | 'patch';
		path: string;
		response: () => DownstreamResponse;
		body?: unknown;
	}> = [
		{ name: 'item de lista', method: 'get', path: '/api/v1/resources', response: () => json(200, [{ ...resource, name: 42 }]) },
		{ name: 'agregado de detalhe', method: 'get', path: `/api/v1/resources/${RESOURCE_ID}`, response: () => json(200, { ...resourceAggregate, occurrences: 'nope' }) },
		{ name: 'recurso criado', method: 'post', path: '/api/v1/resources', response: () => json(201, { ...resource, tags: 'nope' }), body: { code: 'PROJ-01' } },
		{ name: 'ocorrência criada', method: 'post', path: `/api/v1/resources/${RESOURCE_ID}/occurrences`, response: () => json(201, { ...occurrence, status: 'BROKEN' }), body: { description: 'x' } },
		{ name: 'ocorrência resolvida', method: 'patch', path: `/api/v1/resources/${RESOURCE_ID}/occurrences/${occurrence.id}`, response: () => json(200, { ...resolvedOccurrence, priority: 'BOGUS' }), body: { resolution: 'x' } },
	];

	it.each(invalidSuccess)('resposta de sucesso inválida ($name) vira 503 sem corpo parcial', async ({ method, path, response, body }) => {
		reply = response;
		const pending = (request(app.getHttpServer()) as any)[method](path).set('authorization', 'Bearer token');
		if (body !== undefined) pending.send(body);

		const result = await pending.expect(503);

		expect(result.body).toMatchObject({ status: 503, code: 'DEPENDENCY_UNAVAILABLE', reason: 'RESOURCES_UPSTREAM_UNAVAILABLE' });
		expect(result.body).not.toHaveProperty('items');
		expect(result.body).not.toHaveProperty('occurrences');
		expect(result.body).not.toHaveProperty('id');
	});

});

function json(status: number, body: unknown): DownstreamResponse {
	return { status, body: JSON.stringify(body), contentType: 'application/json' };
}

function summary(value: typeof resource, reservations: unknown[] = []): Record<string, unknown> {
	const { enabled: _enabled, ...rest } = value;
	return { ...rest, reservations };
}

function withoutEnabled(value: Record<string, unknown>): Record<string, unknown> {
	const { enabled: _enabled, ...rest } = value;
	return rest;
}
