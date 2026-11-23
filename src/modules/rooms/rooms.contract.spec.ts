import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { DownstreamService, DownstreamUnavailableError } from '../../common/http/downstream.service';
import { RoomsController } from './rooms.controller';
import { ROOMS_DOWNSTREAM, RoomsService } from './rooms.service';

/**
 * Teste de contrato na fronteira **BFF↔rooms** (AD-11, camada 2).
 *
 * O contexto é substituído por um dublê: o que se verifica aqui é o comportamento do proxy, não o
 * do `rooms` — ele já tem a própria auditoria de contrato (História 4.1). O que precisa ser
 * provado deste lado é o que o AD-6 e o AD-10 exigem: repassar sem reinterpretar, e traduzir
 * indisponibilidade em 503 estável.
 */
describe('Proxy de rooms (fronteira BFF↔domínio)', () => {
	let app: INestApplication;
	let sent: Array<Record<string, unknown>>;
	let nextResponse: unknown;

	beforeEach(async () => {
		sent = [];
		nextResponse = { status: 200, body: '[]', contentType: 'application/json' };

		const downstream = {
			send: jest.fn(async (req: Record<string, unknown>) => {
				sent.push(req);
				if (nextResponse instanceof Error) {
					throw nextResponse;
				}
				return nextResponse;
			}),
		} as unknown as DownstreamService;

		const moduleRef = await Test.createTestingModule({
			controllers: [RoomsController],
			providers: [RoomsService, { provide: ROOMS_DOWNSTREAM, useValue: downstream }],
		}).compile();

		app = moduleRef.createNestApplication();
		await app.init();
	});

	afterEach(async () => {
		await app.close();
	});

	it('mapeia /v1/rooms para /api/v1/rooms no contexto', async () => {
		await request(app.getHttpServer()).get('/v1/rooms').expect(200);

		expect(sent[0].path).toBe('/api/v1/rooms');
		expect(sent[0].method).toBe('GET');
	});

	it('preserva a query string de filtro, ordenação e paginação', async () => {
		await request(app.getHttpServer())
			.get('/v1/rooms?building=32&sort=code&page=2')
			.expect(200);

		expect(sent[0].path).toBe('/api/v1/rooms?building=32&sort=code&page=2');
	});

	it('alcança as quatro rotas do contrato, inclusive as aninhadas', async () => {
		const server = app.getHttpServer();
		await request(server).get('/v1/rooms/abc').expect(200);
		await request(server).get('/v1/rooms/abc/accessibility-features').expect(200);
		await request(server).get('/v1/rooms/abc/accessibility-features/def').expect(200);

		expect(sent.map((call) => call.path)).toEqual([
			'/api/v1/rooms/abc',
			'/api/v1/rooms/abc/accessibility-features',
			'/api/v1/rooms/abc/accessibility-features/def',
		]);
	});

	it('propaga o token do usuário como Bearer (AD-4)', async () => {
		await request(app.getHttpServer())
			.get('/v1/rooms')
			.set('authorization', 'Bearer token-do-usuario')
			.expect(200);

		expect(sent[0].bearerToken).toBe('token-do-usuario');
	});

	it('repassa a recusa do domínio sem reinterpretar (AD-6)', async () => {
		const problem = JSON.stringify({ status: 409, code: 'RM-009', title: 'code já usado' });
		nextResponse = { status: 409, body: problem, contentType: 'application/problem+json' };

		const response = await request(app.getHttpServer())
			.post('/v1/rooms')
			.send({ code: 'A/1' })
			.expect(409);

		expect(response.headers['content-type']).toContain('application/problem+json');
		expect(JSON.parse(response.text).code).toBe('RM-009');
	});

	it('encaminha o corpo das escritas', async () => {
		nextResponse = { status: 201, body: '{"id":"1"}', contentType: 'application/json' };

		await request(app.getHttpServer())
			.post('/v1/rooms')
			.send({ code: 'A/1', name: 'Sala' })
			.expect(201);

		expect(JSON.parse(sent[0].body as string)).toEqual({ code: 'A/1', name: 'Sala' });
	});

	it('devolve 204 sem corpo', async () => {
		nextResponse = { status: 204, body: '', contentType: null };

		const response = await request(app.getHttpServer()).delete('/v1/rooms/abc').expect(204);

		expect(response.text).toBe('');
	});

	it('traduz dependência fora do ar em 503 problem+json estável (AD-10)', async () => {
		nextResponse = new DownstreamUnavailableError('rooms', 'circuito aberto');

		const response = await request(app.getHttpServer()).get('/v1/rooms').expect(503);

		expect(response.headers['content-type']).toContain('application/problem+json');
		const body = JSON.parse(response.text);
		expect(body.status).toBe(503);
		expect(body.code).toBe('BFF-DOWNSTREAM-UNAVAILABLE');
	});
});
