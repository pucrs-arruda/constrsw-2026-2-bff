import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import {
	DownstreamService,
	DownstreamUnavailableError,
} from '../../common/http/downstream.service';
import { RoomsController } from './rooms.controller';
import {
	ROOMS_CLASSES_DOWNSTREAM,
	ROOMS_CLOCK,
	ROOMS_DOWNSTREAM,
	RoomsService,
} from './rooms.service';

const TEST_ROOM_ID = '3f6c2b1e-8a4d-4c1f-9e2b-7d5a6c4b3a21';
const TEST_FEATURE_ID = '5e4f3c2b-1a0d-4e9f-8a7b-6c5d4e3f2a10';

const validRoomFixture = {
	id: TEST_ROOM_ID,
	code: '32/405',
	name: 'Laboratório de Engenharia de Software',
	building: '32',
	capacity: 40,
	active: true,
	enabled: true,
	resourceIds: [],
};

describe('Proxy de rooms (fronteira BFF↔domínio)', () => {
	let app: INestApplication;
	let sentRooms: Array<Record<string, unknown>>;
	let sentClasses: Array<Record<string, unknown>>;
	let nextRoomsResponse: unknown;
	let nextClassesResponse: unknown;

	beforeEach(async () => {
		sentRooms = [];
		sentClasses = [];
		nextRoomsResponse = {
			status: 200,
			body: JSON.stringify([validRoomFixture]),
			contentType: 'application/json',
			headers: { 'x-total-count': '1' },
		};
		nextClassesResponse = {
			status: 200,
			body: '[]',
			contentType: 'application/json',
		};

		const roomsDownstream = {
			send: jest.fn(async (req: Record<string, unknown>) => {
				sentRooms.push(req);
				if (nextRoomsResponse instanceof Error) {
					throw nextRoomsResponse;
				}
				return nextRoomsResponse;
			}),
		} as unknown as DownstreamService;

		const classesDownstream = {
			send: jest.fn(async (req: Record<string, unknown>) => {
				sentClasses.push(req);
				if (nextClassesResponse instanceof Error) {
					throw nextClassesResponse;
				}
				return nextClassesResponse;
			}),
		} as unknown as DownstreamService;

		const moduleRef = await Test.createTestingModule({
			controllers: [RoomsController],
			providers: [
				RoomsService,
				{ provide: ROOMS_DOWNSTREAM, useValue: roomsDownstream },
				{ provide: ROOMS_CLASSES_DOWNSTREAM, useValue: classesDownstream },
				{ provide: ROOMS_CLOCK, useValue: () => new Date('2026-11-24T12:00:00Z') },
			],
		}).compile();

		app = moduleRef.createNestApplication();
		await app.init();
	});

	afterEach(async () => {
		await app.close();
	});

	it('mapeia /api/v1/rooms no contexto', async () => {
		await request(app.getHttpServer()).get('/api/v1/rooms').expect(200);

		expect(sentRooms[0].path).toBe('/api/v1/rooms');
		expect(sentRooms[0].method).toBe('GET');
	});

	it('preserva a query string de filtro, ordenação e paginação', async () => {
		await request(app.getHttpServer())
			.get('/api/v1/rooms?building=32&sort=code&page=2')
			.expect(200);

		expect(sentRooms[0].path).toBe('/api/v1/rooms?building=32&sort=code&page=2');
	});

	it('alcança as quatro rotas do contrato, inclusive as aninhadas com UUID', async () => {
		const server = app.getHttpServer();
		nextRoomsResponse = {
			status: 200,
			body: JSON.stringify(validRoomFixture),
			contentType: 'application/json',
		};

		await request(server).get(`/api/v1/rooms/${TEST_ROOM_ID}`).expect(200);

		nextRoomsResponse = { status: 200, body: '[]', contentType: 'application/json' };
		await request(server)
			.get(`/api/v1/rooms/${TEST_ROOM_ID}/accessibility-features`)
			.expect(200);

		nextRoomsResponse = { status: 200, body: '{}', contentType: 'application/json' };
		await request(server)
			.get(`/api/v1/rooms/${TEST_ROOM_ID}/accessibility-features/${TEST_FEATURE_ID}`)
			.expect(200);

		expect(sentRooms.map((call) => call.path)).toEqual([
			`/api/v1/rooms/${TEST_ROOM_ID}`,
			`/api/v1/rooms/${TEST_ROOM_ID}/accessibility-features`,
			`/api/v1/rooms/${TEST_ROOM_ID}/accessibility-features/${TEST_FEATURE_ID}`,
		]);
	});

	it('propaga o token do usuário como Bearer (AD-4)', async () => {
		await request(app.getHttpServer())
			.get('/api/v1/rooms')
			.set('authorization', 'Bearer token-do-usuario')
			.expect(200);

		expect(sentRooms[0].bearerToken).toBe('token-do-usuario');
	});

	it('repassa a recusa do domínio sem reinterpretar (AD-6)', async () => {
		const problem = JSON.stringify({ status: 409, code: 'RM-409', title: 'code já usado' });
		nextRoomsResponse = { status: 409, body: problem, contentType: 'application/problem+json' };

		const response = await request(app.getHttpServer())
			.post('/api/v1/rooms')
			.send({ code: '32/405' })
			.expect(409);

		expect(response.headers['content-type']).toContain('application/problem+json');
		expect(JSON.parse(response.text).code).toBe('RM-409');
	});

	it('encaminha o corpo das escritas', async () => {
		nextRoomsResponse = {
			status: 201,
			body: JSON.stringify(validRoomFixture),
			contentType: 'application/json',
		};

		await request(app.getHttpServer())
			.post('/api/v1/rooms')
			.send({ code: '32/405', name: 'Sala 405', building: '32' })
			.expect(201);

		expect(JSON.parse(sentRooms[0].body as string)).toEqual({
			code: '32/405',
			name: 'Sala 405',
			building: '32',
		});
	});

	it('devolve 204 sem corpo', async () => {
		nextRoomsResponse = { status: 204, body: '', contentType: null };

		const response = await request(app.getHttpServer())
			.delete(`/api/v1/rooms/${TEST_ROOM_ID}`)
			.expect(204);

		expect(response.text).toBe('');
	});

	it('preserva Location e total de paginação', async () => {
		nextRoomsResponse = {
			status: 201,
			body: JSON.stringify(validRoomFixture),
			contentType: 'application/json',
			headers: { location: `/api/v1/rooms/${TEST_ROOM_ID}`, 'x-total-count': '25' },
		};
		const response = await request(app.getHttpServer())
			.post('/api/v1/rooms')
			.send({ code: '32/405', name: 'Sala', building: '32' })
			.expect(201);
		expect(response.headers.location).toBe(`/api/v1/rooms/${TEST_ROOM_ID}`);
		expect(response.headers['x-total-count']).toBe('25');
	});

	it.each([{}, []])('preserva corpo JSON vazio %j', async (body) => {
		nextRoomsResponse = {
			status: 200,
			body: JSON.stringify(validRoomFixture),
			contentType: 'application/json',
		};
		await request(app.getHttpServer())
			.patch(`/api/v1/rooms/${TEST_ROOM_ID}`)
			.send(body)
			.expect(200);
		expect(sentRooms[0].body).toBe(JSON.stringify(body));
	});

	it('não inventa corpo JSON em GET com Content-Length zero', async () => {
		await request(app.getHttpServer())
			.get('/api/v1/rooms')
			.set('Content-Type', 'application/json')
			.set('Content-Length', '0')
			.expect(200);
		expect(sentRooms[0].body).toBeUndefined();
	});

	it('traduz dependência fora do ar em 503 problem+json com code BFF-DEPENDENCY', async () => {
		nextRoomsResponse = new DownstreamUnavailableError('rooms', 'circuito aberto');

		const response = await request(app.getHttpServer()).get('/api/v1/rooms').expect(503);

		expect(response.headers['content-type']).toContain('application/problem+json');
		const body = JSON.parse(response.text);
		expect(body.status).toBe(503);
		expect(body.code).toBe('BFF-DEPENDENCY');
	});
});
