import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { currentSemester } from '../../common/academic/current-semester';
import { DownstreamService, DownstreamUnavailableError } from '../../common/http/downstream.service';
import { StudentsController } from './students.controller';
import { CLASSES_DOWNSTREAM, STUDENTS_DOWNSTREAM, StudentsService } from './students.service';

type Reply = { status: number; body: string; contentType: string | null } | Error;

/** Dublê de um contexto: grava as chamadas e responde o que o teste mandar. */
function fakeDownstream(name: string) {
	const calls: Array<Record<string, unknown>> = [];
	let reply: Reply = { status: 200, body: '[]', contentType: 'application/json' };
	const service = {
		send: jest.fn(async (req: Record<string, unknown>) => {
			calls.push(req);
			if (reply instanceof Error) {
				throw reply;
			}
			return reply;
		}),
	} as unknown as DownstreamService;
	return {
		name,
		calls,
		service,
		reply(next: Reply) {
			reply = next;
		},
	};
}

const json = (status: number, body: unknown): Reply => ({
	status,
	body: JSON.stringify(body),
	contentType: 'application/json',
});

const ANA = { id: 'a1', name: 'Ana', enabled: true };
const BRUNO = { id: 'b2', name: 'Bruno', enabled: true };
const CLASS_ANA = { id: 'c1', studentIds: ['a1'] };
const CLASS_BOTH = { id: 'c2', studentIds: ['a1', 'b2'] };
const CLASS_NOBODY = { id: 'c3', studentIds: [] };

describe('BFF students (proxy + composição T3 com classes)', () => {
	let app: INestApplication;
	let students: ReturnType<typeof fakeDownstream>;
	let classes: ReturnType<typeof fakeDownstream>;

	beforeEach(async () => {
		students = fakeDownstream('students');
		classes = fakeDownstream('classes');

		const moduleRef = await Test.createTestingModule({
			controllers: [StudentsController],
			providers: [
				StudentsService,
				{ provide: STUDENTS_DOWNSTREAM, useValue: students.service },
				{ provide: CLASSES_DOWNSTREAM, useValue: classes.service },
			],
		}).compile();

		app = moduleRef.createNestApplication();
		await app.init();
	});

	afterEach(async () => {
		await app.close();
	});

	describe('GET /api/v1/students', () => {
		it('acrescenta a cada estudante as classes em que está matriculado', async () => {
			students.reply(json(200, [ANA, BRUNO]));
			classes.reply(json(200, [CLASS_ANA, CLASS_BOTH, CLASS_NOBODY]));

			const res = await request(app.getHttpServer()).get('/api/v1/students').expect(200);

			expect(res.body).toEqual([
				{ ...ANA, classes: [CLASS_ANA, CLASS_BOTH] },
				{ ...BRUNO, classes: [CLASS_BOTH] },
			]);
		});

		it('consulta o classes pelo semestre em curso, sem o cliente enviar year/semester', async () => {
			students.reply(json(200, []));
			const { year, semester } = currentSemester();

			await request(app.getHttpServer()).get('/api/v1/students').expect(200);

			expect(classes.calls[0].path).toBe(`/api/v1/classes?year=${year}&semester=${semester}`);
			expect(classes.calls[0].method).toBe('GET');
		});

		it('repassa os filtros do cliente ao students sem alterar', async () => {
			students.reply(json(200, []));

			await request(app.getHttpServer())
				.get('/api/v1/students?name={like}%25silva%25&honors={neq}cum laude')
				.expect(200);

			expect(students.calls[0].path).toBe(
				'/api/v1/students?name={like}%25silva%25&honors={neq}cum%20laude',
			);
		});

		it('devolve classes vazio quando não há turma do estudante', async () => {
			students.reply(json(200, [BRUNO]));
			classes.reply(json(200, [CLASS_ANA]));

			const res = await request(app.getHttpServer()).get('/api/v1/students').expect(200);

			expect(res.body).toEqual([{ ...BRUNO, classes: [] }]);
		});

		it('responde 503 BFF-DEPENDENCY quando o classes está fora, sem devolver os estudantes', async () => {
			students.reply(json(200, [ANA]));
			classes.reply(new DownstreamUnavailableError('classes', 'timeout'));

			const res = await request(app.getHttpServer()).get('/api/v1/students').expect(503);

			expect(res.headers['content-type']).toContain('application/problem+json');
			expect(res.body.code).toBe('BFF-DEPENDENCY');
			expect(res.body.status).toBe(503);
			expect(JSON.stringify(res.body)).not.toContain('Ana');
		});

		it('responde 503 quando o classes recusa a consulta (status não 2xx)', async () => {
			students.reply(json(200, [ANA]));
			classes.reply(json(500, { title: 'erro' }));

			const res = await request(app.getHttpServer()).get('/api/v1/students').expect(503);

			expect(res.body.code).toBe('BFF-DEPENDENCY');
		});

		it('repassa o erro do students (ex.: 400 de filtro inválido) mesmo com o classes fora', async () => {
			students.reply({
				status: 400,
				body: '{"title":"filtro inválido"}',
				contentType: 'application/problem+json',
			});
			classes.reply(new DownstreamUnavailableError('classes', 'timeout'));

			const res = await request(app.getHttpServer()).get('/api/v1/students?x=1').expect(400);

			expect(res.body).toEqual({ title: 'filtro inválido' });
		});

		it('propaga o token do usuário aos dois contextos (AD-4)', async () => {
			students.reply(json(200, []));

			await request(app.getHttpServer())
				.get('/api/v1/students')
				.set('authorization', 'Bearer token-do-usuario')
				.expect(200);

			expect(students.calls[0].bearerToken).toBe('token-do-usuario');
			expect(classes.calls[0].bearerToken).toBe('token-do-usuario');
		});
	});

	describe('GET /api/v1/students/:id', () => {
		it('devolve o estudante com as classes do semestre em curso', async () => {
			students.reply(json(200, ANA));
			classes.reply(json(200, [CLASS_ANA, CLASS_NOBODY]));

			const res = await request(app.getHttpServer()).get('/api/v1/students/a1').expect(200);

			expect(students.calls[0].path).toBe('/api/v1/students/a1');
			expect(res.body).toEqual({ ...ANA, classes: [CLASS_ANA] });
		});

		it('repassa o 404 do students', async () => {
			students.reply({ status: 404, body: '{"title":"não encontrado"}', contentType: 'application/problem+json' });

			await request(app.getHttpServer()).get('/api/v1/students/zzz').expect(404);
		});

		it('responde 503 BFF-DEPENDENCY quando o classes está fora', async () => {
			students.reply(json(200, ANA));
			classes.reply(new DownstreamUnavailableError('classes', 'circuito aberto'));

			const res = await request(app.getHttpServer()).get('/api/v1/students/a1').expect(503);

			expect(res.body.code).toBe('BFF-DEPENDENCY');
		});

		it('responde 503 estável quando o próprio students está fora', async () => {
			students.reply(new DownstreamUnavailableError('students', 'timeout'));

			const res = await request(app.getHttpServer()).get('/api/v1/students/a1').expect(503);

			expect(res.body.code).toBe('BFF-DOWNSTREAM-UNAVAILABLE');
		});
	});

	describe('proxy (escritas e matrículas, sem classes)', () => {
		it('repassa POST com corpo e devolve a resposta do students sem classes', async () => {
			students.reply(json(201, ANA));

			const res = await request(app.getHttpServer())
				.post('/api/v1/students')
				.send({ name: 'Ana' })
				.expect(201);

			expect(students.calls[0]).toMatchObject({
				method: 'POST',
				path: '/api/v1/students',
				body: '{"name":"Ana"}',
			});
			expect(res.body).toEqual(ANA);
			expect(classes.calls).toHaveLength(0);
		});

		it('repassa PUT, PATCH e DELETE do item', async () => {
			const server = app.getHttpServer();
			students.reply(json(200, ANA));
			await request(server).put('/api/v1/students/a1').send({ name: 'Ana' }).expect(200);
			await request(server).patch('/api/v1/students/a1').send({ name: 'Ana' }).expect(200);
			students.reply({ status: 204, body: '', contentType: null });
			await request(server).delete('/api/v1/students/a1').expect(204);

			expect(students.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
				'PUT /api/v1/students/a1',
				'PATCH /api/v1/students/a1',
				'DELETE /api/v1/students/a1',
			]);
			expect(classes.calls).toHaveLength(0);
		});

		it('repassa as rotas de matrículas, inclusive o GET, sem compor', async () => {
			const server = app.getHttpServer();
			students.reply(json(200, []));
			await request(server).get('/api/v1/students/a1/enrollments').expect(200);
			await request(server).get('/api/v1/students/a1/enrollments/e9').expect(200);

			expect(students.calls.map((call) => call.path)).toEqual([
				'/api/v1/students/a1/enrollments',
				'/api/v1/students/a1/enrollments/e9',
			]);
			expect(classes.calls).toHaveLength(0);
		});

		it('repassa a recusa do students intacta', async () => {
			students.reply({
				status: 409,
				body: '{"code":"FR-7"}',
				contentType: 'application/problem+json',
			});

			const res = await request(app.getHttpServer())
				.post('/api/v1/students')
				.send({ name: 'Ana' })
				.expect(409);

			expect(res.body).toEqual({ code: 'FR-7' });
		});
	});
});

describe('currentSemester', () => {
	it('é o semestre 1 até julho e o 2 a partir de agosto, no fuso de São Paulo', () => {
		expect(currentSemester(new Date('2026-07-31T12:00:00-03:00'))).toEqual({ year: 2026, semester: 1 });
		expect(currentSemester(new Date('2026-08-01T00:30:00-03:00'))).toEqual({ year: 2026, semester: 2 });
	});

	it('usa o fuso de São Paulo, não UTC, na virada do mês e do ano', () => {
		// 01/08 02:00 UTC ainda é 31/07 23:00 em São Paulo.
		expect(currentSemester(new Date('2026-08-01T02:00:00Z'))).toEqual({ year: 2026, semester: 1 });
		// 01/01/2027 01:00 UTC ainda é 31/12/2026 em São Paulo.
		expect(currentSemester(new Date('2027-01-01T01:00:00Z'))).toEqual({ year: 2026, semester: 2 });
	});
});
