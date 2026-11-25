import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { accessToken, currentSemester, http, setting, urls, waitForBff } from './support/e2e-env';

/**
 * E2E completo do módulo `classes` (Grupo 01) contra a stack real do compose:
 * BFF → classes, autenticado no Keycloak real (sem dublês).
 *
 * Ciclo coberto:
 * 1. `GET /health` anônimo e `401` sem token em `/api/v1/classes`;
 * 2. `POST /api/v1/classes` (coordenador) e comparação direta com o serviço `classes`;
 * 3. `GET /api/v1/classes` com filtros simples e operadores `{op}` (`{neq}`, `{gteq}`, `{like}`);
 * 4. `POST /api/v1/classes/import` (array JSON) e limpeza no `afterAll`;
 * 5. `PUT` (substituição total + `422` ao tentar alterar campo imutável) e `PATCH` parcial;
 * 6. CRUD completo de `reviews` (`POST`, `409` duplicada, `GET` coleção com filtro, `GET` item
 *    comparado ao backend direto, `PUT`, `PATCH`, `DELETE` + `404`), sem vazar `autorId`;
 * 7. `403` do domínio quando `student` tenta criar turma e `422` ao avaliar turma `closed`;
 * 8. `DELETE` lógico da turma (`204`) e `GET` posterior `404`;
 * 9. Com `E2E_DOCKER=1`, para o container `classes` e confirma `503 BFF-DOWNSTREAM-UNAVAILABLE`.
 *
 * Rodar: `npm run test:e2e:classes` (ou `E2E_DOCKER=1 npm run test:e2e:classes`).
 */
jest.setTimeout(120_000);

const CLASSES = '/api/v1/classes';

function decodeJwtPayload(jwt: string): Record<string, unknown> {
	const [, payload] = jwt.split('.');
	return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('BFF classes — fim a fim completo', () => {
	let adminToken: string;
	let studentToken: string;
	let studentRosterId: string;
	let bff: string;
	let classesUrl: string;

	const { year, semester } = currentSemester();
	const [startMd, endMd] = semester === 1 ? ['03-01', '07-15'] : ['08-01', '12-15'];
	const startDate = `${year}-${startMd}`;
	const endDate = `${year}-${endMd}`;
	const stamp = randomUUID().slice(0, 8);
	const courseId = randomUUID();
	const roomId = randomUUID();
	const professorId = randomUUID();

	let classId: string;
	let importedClassId: string;
	let reviewId: string;

	beforeAll(async () => {
		bff = urls.bff();
		classesUrl = urls.context('classes', '8182');
		await waitForBff();
		await waitForClasses();

		adminToken = await accessToken(
			setting('E2E_USERNAME', 'admin@pucrs.br'),
			setting('E2E_PASSWORD', 'a12345678'),
		);
		studentToken = await accessToken(
			setting('E2E_STUDENT_USERNAME', 'student@pucrs.br'),
			setting('E2E_STUDENT_PASSWORD', 'a12345678'),
		);

		const claims = decodeJwtPayload(studentToken);
		studentRosterId = String(claims.studentId ?? claims.sub);
	});

	afterAll(async () => {
		for (const id of [classId, importedClassId]) {
			if (id) {
				await http('DELETE', `${classesUrl}${CLASSES}/${id}`, { token: adminToken }).catch(
					() => undefined,
				);
			}
		}
	});

	async function waitForClasses(timeoutMs = 60_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const res = await http('GET', `${classesUrl}/api/v1/health`).catch(() => undefined);
			if (res?.status === 200) {
				return;
			}
			await new Promise((done) => setTimeout(done, 1_000));
		}
		throw new Error(`Serviço classes não respondeu /api/v1/health em ${classesUrl}`);
	}

	it('GET /health anônimo responde 200 UP', async () => {
		const res = await http('GET', `${bff}/health`);
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ status: 'UP' });
	});

	it('401 sem token ao listar classes', async () => {
		const res = await http('GET', `${bff}${CLASSES}`);
		expect(res.status).toBe(401);
	});

	it('403 do domínio quando student tenta criar turma', async () => {
		const res = await http('POST', `${bff}${CLASSES}`, {
			token: studentToken,
			body: {
				courseId,
				roomId,
				professorId,
				startDate,
				endDate,
				year,
				semester,
				seats: 25,
				studentIds: [studentRosterId],
				code: `CLS-FORBID-${stamp}`,
				label: 'Tentativa sem papel',
			},
		});
		expect(res.status).toBe(403);
	});

	it('POST cria turma pelo BFF e GET coincide com o serviço classes direto', async () => {
		const created = await http('POST', `${bff}${CLASSES}`, {
			token: adminToken,
			body: {
				courseId,
				roomId,
				professorId,
				startDate,
				endDate,
				year,
				semester,
				seats: 35,
				studentIds: [studentRosterId],
				code: `CLS-E2E-${stamp}`,
				label: `Turma E2E BFF ${stamp}`,
				modality: 'presencial',
			},
		});

		expect(created.status).toBe(201);
		expect(created.body.id).toEqual(expect.any(String));
		expect(created.body.enabled).toBe(true);
		expect(created.body.status).toBe('active');
		classId = created.body.id;

		const [viaBff, direto] = await Promise.all([
			http('GET', `${bff}${CLASSES}/${classId}`, { token: adminToken }),
			http('GET', `${classesUrl}${CLASSES}/${classId}`, { token: adminToken }),
		]);
		expect(viaBff.status).toBe(200);
		expect(viaBff.body).toEqual(direto.body);
	});

	it('GET coleção preserva filtros com operadores {op} ({neq}, {gteq}, {like})', async () => {
		const query = `code=CLS-E2E-${stamp}&status={neq}closed&seats={gteq}30&label={like}%25${stamp}%25`;
		const res = await http('GET', `${bff}${CLASSES}?${query}`, { token: adminToken });

		expect(res.status).toBe(200);
		expect(Array.isArray(res.body)).toBe(true);
		expect(res.body.map((c: { id: string }) => c.id)).toContain(classId);
	});

	it('POST /api/v1/classes/import importa lote em array JSON', async () => {
		const imported = await http('POST', `${bff}${CLASSES}/import`, {
			token: adminToken,
			body: [
				{
					courseId: randomUUID(),
					roomId: randomUUID(),
					professorId: randomUUID(),
					startDate,
					endDate,
					year,
					semester,
					seats: 20,
					studentIds: [],
					code: `CLS-IMP-${stamp}`,
					label: `Import E2E ${stamp}`,
				},
			],
		});

		expect(imported.status).toBe(200);
		expect(Array.isArray(imported.body)).toBe(true);
		expect(imported.body).toHaveLength(1);
		importedClassId = imported.body[0].id;
		expect(importedClassId).toEqual(expect.any(String));
	});

	it('PUT substitui turma e repassa 422 ao alterar campo imutável (year)', async () => {
		const replaced = await http('PUT', `${bff}${CLASSES}/${classId}`, {
			token: adminToken,
			body: {
				courseId,
				roomId,
				professorId,
				startDate,
				endDate,
				year,
				semester,
				seats: 45,
				studentIds: [studentRosterId],
				code: `CLS-E2E-${stamp}`,
				label: `Turma E2E BFF ${stamp} PUT`,
				status: 'active',
				modality: 'hibrida',
			},
		});
		expect(replaced.status).toBe(200);
		expect(replaced.body.seats).toBe(45);
		expect(replaced.body.modality).toBe('hibrida');

		const immutable = await http('PUT', `${bff}${CLASSES}/${classId}`, {
			token: adminToken,
			body: {
				courseId,
				roomId,
				professorId,
				startDate,
				endDate,
				year: year - 1,
				semester,
				seats: 45,
				studentIds: [studentRosterId],
				code: `CLS-E2E-${stamp}`,
				label: `Turma E2E BFF ${stamp} PUT`,
				status: 'active',
				modality: 'hibrida',
			},
		});
		expect(immutable.status).toBe(422);
		expect(immutable.contentType).toContain('application/problem+json');
	});

	it('PATCH altera parcialmente a turma', async () => {
		const patched = await http('PATCH', `${bff}${CLASSES}/${classId}`, {
			token: adminToken,
			body: { seats: 50, label: `Turma E2E BFF ${stamp} PATCH` },
		});
		expect(patched.status).toBe(200);
		expect(patched.body.seats).toBe(50);
		expect(patched.body.label).toBe(`Turma E2E BFF ${stamp} PATCH`);
	});

	describe('reviews (CRUD completo pelo estudante no roster)', () => {
		it('POST cria avaliação anônima (sem autorId) e duplicata retorna 409', async () => {
			const created = await http('POST', `${bff}${CLASSES}/${classId}/reviews`, {
				token: studentToken,
				body: { ordinalRating: 'very_good', text: 'Turma excelente (e2e)' },
			});
			expect(created.status).toBe(201);
			expect(created.body.classId).toBe(classId);
			expect(created.body.ordinalRating).toBe('very_good');
			expect(created.body.autorId).toBeUndefined();
			reviewId = created.body.id;

			const duplicate = await http('POST', `${bff}${CLASSES}/${classId}/reviews`, {
				token: studentToken,
				body: { ordinalRating: 'good', text: 'Duplicada' },
			});
			expect(duplicate.status).toBe(409);
			expect(duplicate.contentType).toContain('application/problem+json');
		});

		it('GET coleção lista avaliação com filtro e GET item coincide com backend direto', async () => {
			const list = await http(
				'GET',
				`${bff}${CLASSES}/${classId}/reviews?ordinalRating=very_good`,
				{ token: adminToken },
			);
			expect(list.status).toBe(200);
			expect(Array.isArray(list.body)).toBe(true);
			expect(list.body.map((r: { id: string }) => r.id)).toContain(reviewId);
			expect(list.body[0].autorId).toBeUndefined();

			const suffix = `${CLASSES}/${classId}/reviews/${reviewId}`;
			const [viaBff, direto] = await Promise.all([
				http('GET', `${bff}${suffix}`, { token: adminToken }),
				http('GET', `${classesUrl}${suffix}`, { token: adminToken }),
			]);
			expect(viaBff.status).toBe(200);
			expect(viaBff.body).toEqual(direto.body);
		});

		it('PUT substitui avaliação e PATCH atualiza parcialmente', async () => {
			const replaced = await http('PUT', `${bff}${CLASSES}/${classId}/reviews/${reviewId}`, {
				token: studentToken,
				body: { ordinalRating: 'good', text: 'Atualizada via PUT' },
			});
			expect(replaced.status).toBe(200);
			expect(replaced.body.ordinalRating).toBe('good');
			expect(replaced.body.text).toBe('Atualizada via PUT');

			const patched = await http('PATCH', `${bff}${CLASSES}/${classId}/reviews/${reviewId}`, {
				token: studentToken,
				body: { text: 'Atualizada via PATCH' },
			});
			expect(patched.status).toBe(200);
			expect(patched.body.text).toBe('Atualizada via PATCH');
		});

		it('DELETE exclui logicamente a avaliação e GET seguinte dá 404', async () => {
			const removed = await http('DELETE', `${bff}${CLASSES}/${classId}/reviews/${reviewId}`, {
				token: studentToken,
			});
			expect(removed.status).toBe(204);

			const after = await http('GET', `${bff}${CLASSES}/${classId}/reviews/${reviewId}`, {
				token: adminToken,
			});
			expect(after.status).toBe(404);
		});
	});

	it('encerrar turma (status=closed) recusa nova avaliação com 422', async () => {
		const closed = await http('PATCH', `${bff}${CLASSES}/${classId}`, {
			token: adminToken,
			body: { status: 'closed' },
		});
		expect(closed.status).toBe(200);
		expect(closed.body.status).toBe('closed');

		const blocked = await http('POST', `${bff}${CLASSES}/${classId}/reviews`, {
			token: studentToken,
			body: { ordinalRating: 'fair', text: 'Após encerramento' },
		});
		expect(blocked.status).toBe(422);
		expect(blocked.contentType).toContain('application/problem+json');
	});

	it('DELETE exclui logicamente a turma e GET seguinte dá 404', async () => {
		const removed = await http('DELETE', `${bff}${CLASSES}/${classId}`, { token: adminToken });
		expect(removed.status).toBe(204);

		const after = await http('GET', `${bff}${CLASSES}/${classId}`, { token: adminToken });
		expect(after.status).toBe(404);
		classId = '';
	});

	const dockerTest = process.env.E2E_DOCKER === '1' ? it : it.skip;
	dockerTest('responde 503 BFF-DOWNSTREAM-UNAVAILABLE quando o container classes para', async () => {
		const container = setting('E2E_CLASSES_CONTAINER', 'classes');
		execFileSync('docker', ['stop', container], { stdio: 'ignore' });
		try {
			const res = await http('GET', `${bff}${CLASSES}`, { token: adminToken });
			expect(res.status).toBe(503);
			expect(res.contentType).toContain('application/problem+json');
			expect(res.body.code).toBe('BFF-DOWNSTREAM-UNAVAILABLE');
		}
		finally {
			execFileSync('docker', ['start', container], { stdio: 'ignore' });
			await waitForClasses();
		}
	});
});
