import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Ajv from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import request from 'supertest';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { ROOMS_CLOCK } from './modules/rooms/rooms.service';
import { httpFixture, Reply } from './testing/http-fixture';
import { classFixture, classList, roomFixture, roomList } from './testing/rooms-fixtures';
const roomsContract = require('../openapi/domains/rooms.openapi.json');
const classesContract = require('../openapi/domains/classes.openapi.json');

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(classesContract, 'https://bff.invalid/domains/classes.openapi.json');
ajv.addSchema(roomsContract, 'https://bff.invalid/domains/rooms.openapi.json');
const validView = ajv.compile({ $ref: 'https://bff.invalid/domains/rooms.openapi.json#/components/schemas/RoomView' });

describe('Rooms BFF sobre HTTP real', () => {
	const path = '/api/v1/rooms';
	const room = roomFixture();
	const item = `${path}/${room.id}`;
	const features = `${item}/accessibility-features`;
	let app: INestApplication;
	let rooms: Awaited<ReturnType<typeof httpFixture>>;
	let classes: Awaited<ReturnType<typeof httpFixture>>;
	let roomsReply: Reply;
	let classesReply: Reply;
	let now: Date;
	const originalEnv = process.env;

	beforeEach(async () => {
		now = new Date('2026-11-24T12:00:00Z');
		roomsReply = { body: JSON.stringify([room]) };
		classesReply = { body: '[]' };
		rooms = await httpFixture(() => roomsReply);
		classes = await httpFixture(() => classesReply);
		process.env = {
			...originalEnv, ROOMS_BASE_URL: rooms.url, CLASSES_BASE_URL: classes.url,
			BFF_HTTP_RETRIES: '2', BFF_HTTP_TIMEOUT_MS: '500',
			BFF_CIRCUIT_BREAKER_VOLUME_THRESHOLD: '20',
		};
		const module = await Test.createTestingModule({ imports: [AppModule] })
			.overrideProvider(ROOMS_CLOCK).useValue(() => now).compile();
		app = module.createNestApplication({ bodyParser: false, logger: false });
		configureApp(app);
		await app.init();
	});

	afterEach(async () => {
		process.env = originalEnv;
		await Promise.all([
			app?.close(), rooms?.close(), classes?.server.listening ? classes.close() : undefined,
		]);
	});

	const api = () => request(app.getHttpServer());
	const assertView = (view: unknown) => {
		validView(view);
		expect(validView.errors).toBeNull();
	};

	it('compõe três salas em ordem, preserva o total e valida cada RoomView', async () => {
		const [first, second, third] = roomList({ code: 'B' }, { code: 'A' }, { code: 'C' });
		const [a, b, c] = classList({ roomId: first.id }, { roomId: second.id }, { roomId: third.id });
		roomsReply = { body: JSON.stringify([first, second, third]), headers: { 'x-total-count': '7' } };
		classesReply.body = JSON.stringify([c, a, b]);
		const res = await api().get(path).expect(200).expect('x-total-count', '7');
		expect(res.body).toEqual([
			{ ...first, classes: [a] }, { ...second, classes: [b] }, { ...third, classes: [c] },
		]);
		expect(classes.seen.map(call => call.url)).toEqual(['/api/v1/classes?year=2026&semester=2']);
		res.body.forEach(assertView);
	});

	it('consulta o item por sala e semestre e encaminha o mesmo Bearer aos dois serviços', async () => {
		const classItem = classFixture();
		roomsReply.body = JSON.stringify(room);
		classesReply.body = JSON.stringify([classItem]);
		const res = await api().get(item).set('Authorization', 'Bearer caller-access').expect(200);
		expect(res.body).toEqual({ ...room, classes: [classItem] });
		const query = new URL(classes.seen[0].url, classes.url);
		expect(query.pathname).toBe('/api/v1/classes');
		expect(Object.fromEntries(query.searchParams)).toEqual({ roomId: room.id, year: '2026', semester: '2' });
		for (const call of [...rooms.seen, ...classes.seen]) {
			expect(call.headers.authorization).toBe('Bearer caller-access');
		}
		assertView(res.body);
	});

	it('preenche classes com array vazio quando a sala não tem turma', async () => {
		const res = await api().get(path).expect(200);
		expect(res.body).toEqual([{ ...room, classes: [] }]);
	});

	it('não consulta classes para coleção de salas vazia', async () => {
		roomsReply = { body: '[]', headers: { 'x-total-count': '0' } };
		const res = await api().get(path).expect(200).expect('x-total-count', '0');
		expect(res.body).toEqual([]);
		expect(classes.seen).toHaveLength(0);
	});

	it.each([
		['desabilitada', { enabled: false }],
		['de outra sala', { roomId: '44444444-4444-4444-8444-444444444444' }],
		['de outro ano', { year: 2025 }],
		['de outro semestre', { semester: 1 }],
	] as const)('exclui turma %s', async (_, overrides) => {
		const valid = classFixture();
		classesReply.body = JSON.stringify([classFixture(overrides), valid]);
		const res = await api().get(path).expect(200);
		expect(res.body[0].classes).toEqual([valid]);
	});

	it.each([
		['2026-07-31T23:59:59-03:00', 2026, 1],
		['2026-08-01T00:00:00-03:00', 2026, 2],
		['2026-12-31T23:30:00-03:00', 2026, 2],
		['2027-01-01T00:00:00-03:00', 2027, 1],
	])('calcula o semestre em São Paulo para %s', async (instant, year, semester) => {
		now = new Date(instant);
		await api().get(path).expect(200);
		expect(classes.seen[0].url).toBe(`/api/v1/classes?year=${year}&semester=${semester}`);
	});

	async function expectCompositionFailure() {
		const res = await api().get(path).expect(503).expect('Content-Type', /application\/problem\+json/);
		expect(res.body).toMatchObject({
			code: 'BFF-DEPENDENCY', status: 503, type: expect.any(String),
			title: expect.any(String), detail: expect.any(String),
		});
		expect(res.text).not.toContain(room.id);
		expect(res.text).not.toContain(room.name);
		expect(res.body).not.toHaveProperty('classes');
	}

	it('responde 503 sem sala parcial com classes fora do ar', async () => {
		await classes.close();
		await expectCompositionFailure();
	});

	// Pelo contrato, inclusive 401/403 do classes são falhas da composição.
	it.each([{ status: 500 }, { status: 401 }, { status: 403 }, { body: '{}' }])(
		'responde 503 sem sala parcial quando classes retorna %j',
		async reply => {
			classesReply = reply;
			await expectCompositionFailure();
			expect(classes.seen).toHaveLength(1);
		},
	);

	it.each([404, 401, 403, 400])('repassa %s de rooms sem consultar classes', async status => {
		const body = `{ "error_code": "RM-${status}" }\n`;
		roomsReply = { status, body };
		const res = await api().get(`${path}?code=inexistente`).expect(status);
		expect(res.text).toBe(body);
		expect(classes.seen).toHaveLength(0);
	});

	it('rejeita sala sem campo obrigatório antes da composição', async () => {
		roomsReply.body = JSON.stringify([{ ...room, capacity: undefined }]);
		await expectCompositionFailure();
		expect(classes.seen).toHaveLength(0);
	});

	it('remove validadores de cache do downstream ao compor a resposta', async () => {
		roomsReply.headers = { etag: '"writer"', 'last-modified': 'Tue, 24 Nov 2026 12:00:00 GMT' };
		const res = await api().get(path).expect(200).expect('cache-control', 'no-store');
		expect(res.headers.etag).toBeUndefined();
		expect(res.headers['last-modified']).toBeUndefined();
	});

	it.each([
		['post', path, 201], ['put', item, 200], ['patch', item, 200], ['delete', item, 204],
		['get', features, 200], ['post', features, 201],
		['get', `${features}/feature`, 200], ['put', `${features}/feature`, 200],
		['patch', `${features}/feature`, 200], ['delete', `${features}/feature`, 204],
	] as const)('%s %s não consulta classes', async (method, url, status) => {
		roomsReply = { status, body: status === 204 ? '' : '{}' };
		await api()[method](url).expect(status);
		expect(rooms.seen.map(call => [call.method, call.url])).toEqual([[method.toUpperCase(), url]]);
		expect(classes.seen).toHaveLength(0);
	});

	it('envia PUT uma vez ao receber 500 de rooms', async () => {
		roomsReply = { status: 500 };
		await api().put(item).send({ name: 'Sala' }).expect(500);
		expect(rooms.seen).toHaveLength(1);
	});

	it('repete GET conforme BFF_HTTP_RETRIES quando a conexão falha', async () => {
		let attempts = 0;
		rooms.server.prependListener('request', incoming => {
			attempts++;
			incoming.socket.destroy();
		});
		await api().get(path).expect(503);
		expect(attempts).toBe(3);
		expect(classes.seen).toHaveLength(0);
	});

	it('encaminha os bytes do POST malformado ao serviço rooms', async () => {
		const body = '{ "name": "Átrio",\n';
		roomsReply = { status: 400 };
		await api().post(path).set('Content-Type', 'application/json').send(body).expect(400);
		expect(rooms.seen[0].body).toBe(body);
	});
});
