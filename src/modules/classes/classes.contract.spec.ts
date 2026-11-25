import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import {
	DownstreamRequest,
	DownstreamResponse,
	DownstreamService,
	DownstreamUnavailableError,
} from '../../common/http/downstream.service';
import { ClassesController } from './classes.controller';
import { CLASSES_DOWNSTREAM, ClassesService } from './classes.service';

const CLASS_ID = '550e8400-e29b-41d4-a716-446655440001';
const REVIEW_ID = '550e8400-e29b-41d4-a716-446655440099';

const SAMPLE_CLASS = {
	id: CLASS_ID,
	enabled: true,
	courseId: '550e8400-e29b-41d4-a716-446655440010',
	startDate: '2026-08-01',
	endDate: '2026-12-10',
	year: 2026,
	semester: 2,
	seats: 40,
	roomId: '550e8400-e29b-41d4-a716-446655440020',
	professorId: '550e8400-e29b-41d4-a716-446655440030',
	studentIds: ['550e8400-e29b-41d4-a716-446655440040'],
	code: 'CS-101-A',
	label: 'Banco de Dados',
	status: 'active',
	modality: 'presencial',
	averageRating: 4.5,
};

const SAMPLE_REVIEW = {
	id: REVIEW_ID,
	enabled: true,
	classId: CLASS_ID,
	ordinalRating: 'very_good',
	text: 'Excelente turma',
	createdAt: '2026-09-10T14:00:00Z',
};

function json(status: number, body: unknown): DownstreamResponse {
	return { status, body: JSON.stringify(body), contentType: 'application/json' };
}

/**
 * Teste de contrato na fronteira **BFF↔classes** (AD-11, camada 2).
 *
 * O contexto é substituído por um dublê de {@link DownstreamService}: verifica o proxy fiel das
 * cinco rotas (treze operações) de `docs/open-api/bff.yaml` e `grupo01-classes-api.yaml`, a
 * propagação de Bearer e filtros `{op}`, e a tradução de indisponibilidade em 503 estável.
 */
describe('Proxy de classes (fronteira BFF↔domínio)', () => {
	let app: INestApplication;
	let sent: DownstreamRequest[];
	let nextResponse: DownstreamResponse | Error;

	beforeEach(async () => {
		sent = [];
		nextResponse = json(200, []);

		const downstream = {
			send: jest.fn(async (req: DownstreamRequest) => {
				sent.push(req);
				if (nextResponse instanceof Error) {
					throw nextResponse;
				}
				return nextResponse;
			}),
		} as unknown as DownstreamService;

		const moduleRef = await Test.createTestingModule({
			controllers: [ClassesController],
			providers: [ClassesService, { provide: CLASSES_DOWNSTREAM, useValue: downstream }],
		}).compile();

		app = moduleRef.createNestApplication();
		await app.init();
	});

	afterEach(async () => {
		await app.close();
	});

	it('mapeia GET /api/v1/classes preservando query string crua com operadores {op}', async () => {
		nextResponse = json(200, [SAMPLE_CLASS]);

		const res = await request(app.getHttpServer())
			.get('/api/v1/classes?status=%7Bneq%7Dclosed&seats=%7Bgteq%7D30&label=%7Blike%7D%25BD%25')
			.expect(200);

		expect(res.body).toEqual([SAMPLE_CLASS]);
		expect(sent[0].method).toBe('GET');
		expect(sent[0].path).toBe(
			'/api/v1/classes?status=%7Bneq%7Dclosed&seats=%7Bgteq%7D30&label=%7Blike%7D%25BD%25',
		);
	});

	it('encaminha POST /api/v1/classes com corpo e devolve 201 com Location', async () => {
		nextResponse = {
			...json(201, SAMPLE_CLASS),
			location: `/api/v1/classes/${CLASS_ID}`,
		};
		const payload = {
			courseId: SAMPLE_CLASS.courseId,
			startDate: SAMPLE_CLASS.startDate,
			endDate: SAMPLE_CLASS.endDate,
			year: 2026,
			semester: 2,
			seats: 40,
			roomId: SAMPLE_CLASS.roomId,
			professorId: SAMPLE_CLASS.professorId,
		};

		const res = await request(app.getHttpServer())
			.post('/api/v1/classes')
			.send(payload)
			.expect(201);

		expect(res.headers['location']).toBe(`/api/v1/classes/${CLASS_ID}`);
		expect(res.body).toEqual(SAMPLE_CLASS);
		expect(sent[0].method).toBe('POST');
		expect(sent[0].path).toBe('/api/v1/classes');
		expect(JSON.parse(sent[0].body as string)).toEqual(payload);
	});

	it('roteia POST /api/v1/classes/import antes de :classId e preserva corpo array JSON', async () => {
		nextResponse = json(200, [SAMPLE_CLASS]);
		const batch = [
			{
				courseId: SAMPLE_CLASS.courseId,
				startDate: SAMPLE_CLASS.startDate,
				endDate: SAMPLE_CLASS.endDate,
				year: 2026,
				semester: 2,
				seats: 40,
				roomId: SAMPLE_CLASS.roomId,
				professorId: SAMPLE_CLASS.professorId,
			},
		];

		const res = await request(app.getHttpServer())
			.post('/api/v1/classes/import')
			.send(batch)
			.expect(200);

		expect(res.body).toEqual([SAMPLE_CLASS]);
		expect(sent[0].method).toBe('POST');
		expect(sent[0].path).toBe('/api/v1/classes/import');
		expect(JSON.parse(sent[0].body as string)).toEqual(batch);
	});

	it('repassa GET, PUT, PATCH e DELETE de /api/v1/classes/:classId (com 204 sem corpo)', async () => {
		const server = app.getHttpServer();
		nextResponse = json(200, SAMPLE_CLASS);

		await request(server).get(`/api/v1/classes/${CLASS_ID}`).expect(200);
		await request(server)
			.put(`/api/v1/classes/${CLASS_ID}`)
			.send({ ...SAMPLE_CLASS, seats: 45 })
			.expect(200);
		await request(server)
			.patch(`/api/v1/classes/${CLASS_ID}`)
			.send({ status: 'closed' })
			.expect(200);

		nextResponse = { status: 204, body: '', contentType: null };
		const delRes = await request(server).delete(`/api/v1/classes/${CLASS_ID}`).expect(204);
		expect(delRes.text).toBe('');

		expect(sent.map((call) => `${call.method} ${call.path}`)).toEqual([
			`GET /api/v1/classes/${CLASS_ID}`,
			`PUT /api/v1/classes/${CLASS_ID}`,
			`PATCH /api/v1/classes/${CLASS_ID}`,
			`DELETE /api/v1/classes/${CLASS_ID}`,
		]);
	});

	it('repassa as seis operações de reviews preservando filtros e aliases em português', async () => {
		const server = app.getHttpServer();

		nextResponse = json(200, [SAMPLE_REVIEW]);
		await request(server)
			.get(`/api/v1/classes/${CLASS_ID}/reviews?notaOrdinal=very_good`)
			.expect(200);

		nextResponse = json(201, SAMPLE_REVIEW);
		const createBody = { notaOrdinal: 'muito_bom', texto: 'Ótima aula' };
		await request(server)
			.post(`/api/v1/classes/${CLASS_ID}/reviews`)
			.send(createBody)
			.expect(201);
		expect(JSON.parse(sent[1].body as string)).toEqual(createBody);

		nextResponse = json(200, SAMPLE_REVIEW);
		await request(server)
			.get(`/api/v1/classes/${CLASS_ID}/reviews/${REVIEW_ID}`)
			.expect(200);
		await request(server)
			.put(`/api/v1/classes/${CLASS_ID}/reviews/${REVIEW_ID}`)
			.send({ ordinalRating: 'good', text: 'Atualizado' })
			.expect(200);
		await request(server)
			.patch(`/api/v1/classes/${CLASS_ID}/reviews/${REVIEW_ID}`)
			.send({ texto: null })
			.expect(200);

		nextResponse = { status: 204, body: '', contentType: null };
		const delRes = await request(server)
			.delete(`/api/v1/classes/${CLASS_ID}/reviews/${REVIEW_ID}`)
			.expect(204);
		expect(delRes.text).toBe('');

		expect(sent.map((call) => `${call.method} ${call.path}`)).toEqual([
			`GET /api/v1/classes/${CLASS_ID}/reviews?notaOrdinal=very_good`,
			`POST /api/v1/classes/${CLASS_ID}/reviews`,
			`GET /api/v1/classes/${CLASS_ID}/reviews/${REVIEW_ID}`,
			`PUT /api/v1/classes/${CLASS_ID}/reviews/${REVIEW_ID}`,
			`PATCH /api/v1/classes/${CLASS_ID}/reviews/${REVIEW_ID}`,
			`DELETE /api/v1/classes/${CLASS_ID}/reviews/${REVIEW_ID}`,
		]);
	});

	it('propaga o token do usuário como Bearer (AD-4)', async () => {
		await request(app.getHttpServer())
			.get('/api/v1/classes')
			.set('authorization', 'Bearer token-do-usuario')
			.expect(200);

		expect(sent[0].bearerToken).toBe('token-do-usuario');
	});

	it('repassa recusas do domínio (400/401/403/404/409/422) sem reinterpretar (AD-6)', async () => {
		for (const status of [400, 401, 403, 404, 409, 422]) {
			const problem = JSON.stringify({
				type: 'urn:closed-cras:recusa:FR-6',
				title: 'Recusa de domínio',
				status,
				code: 'FR-6',
			});
			nextResponse = { status, body: problem, contentType: 'application/problem+json' };

			const response = await request(app.getHttpServer())
				.get(`/api/v1/classes/${CLASS_ID}`)
				.expect(status);

			expect(response.headers['content-type']).toContain('application/problem+json');
			expect(JSON.parse(response.text).code).toBe('FR-6');
		}
	});

	it('bloqueia path traversal (%2e%2e) com 400 sem acionar o downstream', async () => {
		const response = await request(app.getHttpServer())
			.get('/api/v1/classes/%2e%2e')
			.expect(400);

		expect(response.headers['content-type']).toContain('application/problem+json');
		expect(sent).toHaveLength(0);
	});

	it('não expõe o alias /avaliacoes fora do contrato bff.yaml', async () => {
		await request(app.getHttpServer())
			.get(`/api/v1/classes/${CLASS_ID}/avaliacoes`)
			.expect(404);

		expect(sent).toHaveLength(0);
	});

	it('traduz dependência fora do ar em 503 problem+json estável (AD-10)', async () => {
		nextResponse = new DownstreamUnavailableError('classes', 'circuito aberto');

		const response = await request(app.getHttpServer())
			.get('/api/v1/classes')
			.expect(503);

		expect(response.headers['content-type']).toContain('application/problem+json');
		const body = JSON.parse(response.text);
		expect(body.status).toBe(503);
		expect(body.code).toBe('BFF-DOWNSTREAM-UNAVAILABLE');
	});
});
