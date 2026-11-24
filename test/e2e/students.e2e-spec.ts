import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { accessToken, currentSemester, http, setting, urls, waitForBff } from './support/e2e-env';

/**
 * E2E completo do módulo `students` (Grupo 04) contra a stack real do compose.
 *
 * Ciclo: cria estudante → composição T3 → PUT/PATCH → CRUD de enrollments → DELETE
 * (e limpa turmas auxiliares). Volta ao estado inicial.
 *
 * Rodar: `npm run test:e2e -- students`
 */
jest.setTimeout(120_000);

const STUDENTS = '/api/v1/students';

describe('BFF students — fim a fim completo', () => {
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
	let enrollmentId: string;
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

	describe('proxy do estudante (PUT/PATCH)', () => {
		it('PUT substitui o estudante e devolve o corpo sem classes', async () => {
			const replaced = {
				registration_number: student.registration_number,
				name: `${student.name} substituído`,
				email: student.email,
				birth_date: student.birth_date,
				phone: '+5551999990000',
			};
			const res = await http('PUT', `${bff}${STUDENTS}/${studentId}`, { token, body: replaced });
			expect(res.status).toBe(200);
			expect(res.body).toMatchObject(replaced);
			expect(res.body).not.toHaveProperty('classes');
		});

		it('PATCH altera pelo students e devolve o corpo sem classes', async () => {
			const res = await http('PATCH', `${bff}${STUDENTS}/${studentId}`, {
				token,
				body: { name: `${student.name} alterado` },
			});
			expect(res.status).toBe(200);
			expect(res.body.name).toBe(`${student.name} alterado`);
			expect(res.body).not.toHaveProperty('classes');
		});
	});

	describe('proxy de enrollments (CRUD completo)', () => {
		const enrollment = {
			course_code: `E2E${stamp.slice(-4)}`,
			course_name: 'Engenharia de Software E2E',
			admission_term: '2024/1',
			status: 'active',
			start_date: '2024-03-04',
			end_date: null as string | null,
		};

		it('POST cria vínculo acadêmico', async () => {
			const res = await http('POST', `${bff}${STUDENTS}/${studentId}/enrollments`, {
				token,
				body: enrollment,
			});
			expect(res.status).toBe(201);
			expect(res.body).toMatchObject({
				course_code: enrollment.course_code,
				course_name: enrollment.course_name,
				status: 'active',
			});
			enrollmentId = res.body.id;
			expect(enrollmentId).toEqual(expect.any(String));
		});

		it('GET coleção lista o vínculo criado', async () => {
			const res = await http('GET', `${bff}${STUDENTS}/${studentId}/enrollments`, { token });
			expect(res.status).toBe(200);
			expect(res.body).toEqual(expect.any(Array));
			expect(res.body.map((item: { id: string }) => item.id)).toContain(enrollmentId);
		});

		it('GET item coincide com o students direto', async () => {
			const suffix = `${STUDENTS}/${studentId}/enrollments/${enrollmentId}`;
			const [viaBff, direct] = await Promise.all([
				http('GET', `${bff}${suffix}`, { token }),
				http('GET', `${studentsUrl}${suffix}`, { token }),
			]);
			expect(viaBff.status).toBe(200);
			expect(viaBff.body).toEqual(direct.body);
		});

		it('PUT substitui o vínculo', async () => {
			const replaced = {
				...enrollment,
				course_name: 'Engenharia de Software E2E substituído',
				status: 'suspended',
			};
			const res = await http('PUT', `${bff}${STUDENTS}/${studentId}/enrollments/${enrollmentId}`, {
				token,
				body: replaced,
			});
			expect(res.status).toBe(200);
			expect(res.body.course_name).toBe(replaced.course_name);
			expect(res.body.status).toBe('suspended');
		});

		it('PATCH altera parcialmente o vínculo', async () => {
			const res = await http('PATCH', `${bff}${STUDENTS}/${studentId}/enrollments/${enrollmentId}`, {
				token,
				body: { status: 'active' },
			});
			expect(res.status).toBe(200);
			expect(res.body.status).toBe('active');
		});

		it('DELETE remove o vínculo e o GET passa a 404', async () => {
			const removed = await http('DELETE', `${bff}${STUDENTS}/${studentId}/enrollments/${enrollmentId}`, {
				token,
			});
			expect(removed.status).toBe(204);

			const after = await http('GET', `${bff}${STUDENTS}/${studentId}/enrollments/${enrollmentId}`, {
				token,
			});
			expect(after.status).toBe(404);
		});
	});

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
