import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { accessToken, currentSemester, http, setting, urls, waitForBff } from './support/e2e-env';

/**
 * Teste fim a fim do módulo `students` do BFF (Grupo 04), contra a stack real do compose:
 * BFF → students + classes, com token do Keycloak.
 *
 * Roteiro:
 * 1. cria um estudante **pelo BFF** (proxy de POST);
 * 2. cria, direto no classes, três turmas: uma do semestre em curso com o estudante, uma do semestre
 *    em curso sem ele e uma de outro semestre com ele;
 * 3. confere que o GET do item e da coleção no BFF trazem `classes` só com a primeira turma e que o
 *    resto do corpo é o do students;
 * 4. confere o proxy (PATCH, matrículas, 404, 401) e, com `E2E_DOCKER=1`, o 503 `BFF-DEPENDENCY`
 *    parando o container do classes;
 * 5. apaga o que criou.
 *
 * Modelo para os outros grupos: copie como `test/e2e/<contexto>.e2e-spec.ts` e reaproveite
 * `support/e2e-env.ts`.
 *
 * Rodar (com a stack no ar): `npm run test:e2e`.
 */
jest.setTimeout(120_000);

const STUDENTS = '/api/v1/students';

describe('BFF students — fim a fim', () => {
	let token: string;
	let bff: string;
	let studentsUrl: string;
	let classesUrl: string;

	const { year, semester } = currentSemester();
	const stamp = Date.now().toString().slice(-10);
	const student = {
		registration_number: `E2E${stamp}`,
		name: `Estudante E2E ${stamp}`,
		email: `e2e.${stamp}@pucrs.br`,
		birth_date: '2000-01-15',
	};

	let studentId: string;
	const createdClassIds: string[] = [];
	let enrolledClassId: string;
	let otherClassId: string;
	let pastClassId: string;

	beforeAll(async () => {
		bff = urls.bff();
		studentsUrl = urls.context('students', '8190');
		classesUrl = urls.context('classes', '8182');
		await waitForBff();
		token = await accessToken();

		const created = await http('POST', `${bff}${STUDENTS}`, { token, body: student });
		expect(created.status).toBe(201);
		studentId = created.body.id;

		enrolledClassId = await createClass(year, semester, [studentId]);
		otherClassId = await createClass(year, semester, [randomUUID()]);
		pastClassId = await createClass(year - 1, semester, [studentId]);
	});

	afterAll(async () => {
		for (const id of createdClassIds) {
			await http('DELETE', `${classesUrl}/api/v1/classes/${id}`, { token }).catch(() => undefined);
		}
		if (studentId) {
			await http('DELETE', `${bff}${STUDENTS}/${studentId}`, { token }).catch(() => undefined);
		}
	});

	async function createClass(classYear: number, classSemester: number, studentIds: string[]): Promise<string> {
		const [start, end] = classSemester === 1 ? ['03-01', '07-15'] : ['08-01', '12-15'];
		const res = await http('POST', `${classesUrl}/api/v1/classes`, {
			token,
			body: {
				courseId: randomUUID(),
				roomId: randomUUID(),
				professorId: randomUUID(),
				startDate: `${classYear}-${start}`,
				endDate: `${classYear}-${end}`,
				year: classYear,
				semester: classSemester,
				seats: 30,
				studentIds,
				code: `E2E-${stamp}-${createdClassIds.length}`,
				label: 'Turma do teste e2e do BFF',
			},
		});
		if (res.status !== 201) {
			throw new Error(`classes recusou criar a turma de teste: HTTP ${res.status} ${JSON.stringify(res.body)}`);
		}
		createdClassIds.push(res.body.id);
		return res.body.id;
	}

	const classIds = (classes: Array<{ id: string }>) => classes.map((item) => item.id).sort();

	it('GET /health responde UP sem token', async () => {
		const res = await http('GET', `${bff}/health`);

		expect(res.status).toBe(200);
		expect(res.body).toEqual({ status: 'UP' });
	});

	it('POST pelo BFF devolve o estudante do students, sem classes', async () => {
		const direct = await http('GET', `${studentsUrl}${STUDENTS}/${studentId}`, { token });

		expect(direct.status).toBe(200);
		expect(direct.body).toMatchObject(student);
	});

	describe('GET /api/v1/students/{id} (composição T3)', () => {
		it('traz o estudante do students mais as classes do semestre em curso em que está matriculado', async () => {
			const [viaBff, direct] = await Promise.all([
				http('GET', `${bff}${STUDENTS}/${studentId}`, { token }),
				http('GET', `${studentsUrl}${STUDENTS}/${studentId}`, { token }),
			]);

			expect(viaBff.status).toBe(200);
			const { classes, ...rest } = viaBff.body;
			expect(rest).toEqual(direct.body);
			expect(classes).toEqual(expect.any(Array));
			expect(classIds(classes)).toContain(enrolledClassId);
		});

		it('não inclui turma do semestre em curso sem o estudante nem turma de outro semestre', async () => {
			const res = await http('GET', `${bff}${STUDENTS}/${studentId}`, { token });

			const ids = classIds(res.body.classes);
			expect(ids).not.toContain(otherClassId);
			expect(ids).not.toContain(pastClassId);
			for (const item of res.body.classes) {
				expect(item.studentIds).toContain(studentId);
				expect(item.year).toBe(year);
				expect(item.semester).toBe(semester);
			}
		});

		it('coincide com a consulta direta ao classes pelo semestre em curso', async () => {
			const [viaBff, direct] = await Promise.all([
				http('GET', `${bff}${STUDENTS}/${studentId}`, { token }),
				http('GET', `${classesUrl}/api/v1/classes?year=${year}&semester=${semester}`, { token }),
			]);

			const expected = (direct.body as Array<{ id: string; studentIds: string[] }>).filter((item) =>
				item.studentIds.includes(studentId),
			);
			expect(classIds(viaBff.body.classes)).toEqual(classIds(expected));
		});

		it('repassa o 404 do students para id inexistente', async () => {
			const res = await http('GET', `${bff}${STUDENTS}/${randomUUID()}`, { token });

			expect(res.status).toBe(404);
		});

		it('repassa o 401 do students sem token', async () => {
			const res = await http('GET', `${bff}${STUDENTS}/${studentId}`);

			expect(res.status).toBe(401);
		});
	});

	describe('GET /api/v1/students (composição T3)', () => {
		it('aplica os filtros do students e acrescenta classes a cada item', async () => {
			const res = await http(
				'GET',
				`${bff}${STUDENTS}?registration_number=${student.registration_number}`,
				{ token },
			);

			expect(res.status).toBe(200);
			expect(res.body).toHaveLength(1);
			expect(res.body[0].id).toBe(studentId);
			expect(classIds(res.body[0].classes)).toEqual([enrolledClassId]);
		});

		it('todo item da lista sem filtro tem classes', async () => {
			const res = await http('GET', `${bff}${STUDENTS}`, { token });

			expect(res.status).toBe(200);
			for (const item of res.body) {
				expect(item.classes).toEqual(expect.any(Array));
			}
		});

		it('repassa o 401 do students sem token', async () => {
			const res = await http('GET', `${bff}${STUDENTS}`);

			expect(res.status).toBe(401);
		});
	});

	describe('proxy (sem classes)', () => {
		it('PATCH altera pelo students e devolve o corpo sem classes', async () => {
			const res = await http('PATCH', `${bff}${STUDENTS}/${studentId}`, {
				token,
				body: { name: `${student.name} alterado` },
			});

			expect(res.status).toBe(200);
			expect(res.body.name).toBe(`${student.name} alterado`);
			expect(res.body).not.toHaveProperty('classes');
		});

		it('GET de matrículas é proxy e não compõe', async () => {
			const res = await http('GET', `${bff}${STUDENTS}/${studentId}/enrollments`, { token });

			expect(res.status).toBe(200);
			expect(res.body).toEqual(expect.any(Array));
		});
	});

	// Para o container do classes: só com E2E_DOCKER=1, porque mexe na stack local.
	const withDocker = setting('E2E_DOCKER', '0') === '1' ? it : it.skip;

	withDocker('responde 503 BFF-DEPENDENCY quando o classes está fora, sem devolver o estudante', async () => {
		const container = setting('E2E_CLASSES_CONTAINER', 'classes');
		execFileSync('docker', ['stop', container], { stdio: 'ignore' });
		try {
			const res = await http('GET', `${bff}${STUDENTS}/${studentId}`, { token });

			expect(res.status).toBe(503);
			expect(res.contentType).toContain('application/problem+json');
			expect(res.body.code).toBe('BFF-DEPENDENCY');
			expect(JSON.stringify(res.body)).not.toContain(student.registration_number);
		}
		finally {
			execFileSync('docker', ['start', container], { stdio: 'ignore' });
			await waitForClasses();
		}
	});

	/** Depois do `docker start`, espera o classes responder de novo para a limpeza funcionar. */
	async function waitForClasses(): Promise<void> {
		const deadline = Date.now() + 90_000;
		while (Date.now() < deadline) {
			const res = await http('GET', `${classesUrl}/api/v1/classes?year=${year}`, { token }).catch(() => undefined);
			if (res?.status === 200) {
				return;
			}
			await new Promise((done) => setTimeout(done, 2_000));
		}
	}

	it('DELETE pelo BFF faz a exclusão lógica no students', async () => {
		const removed = await http('DELETE', `${bff}${STUDENTS}/${studentId}`, { token });
		expect(removed.status).toBe(204);

		const after = await http('GET', `${bff}${STUDENTS}/${studentId}`, { token });
		expect(after.status).toBe(404);
		studentId = '';
	});
});
