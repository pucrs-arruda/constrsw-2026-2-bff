import { accessToken, http, urls, waitForBff } from './support/e2e-env';

/**
 * E2E completo do módulo `reservations` (Grupo 03) contra a stack real do compose.
 *
 * Usa a massa stub do reservations (ligada por padrão):
 * - Lesson `…0004` (2026-12-12, faixa C) do `professor@pucrs.br` e Resource `…0001`/`…0002`;
 * - a reserva `…0005` da massa, de outro professor (403 RN-02).
 *
 * Ciclo: identidade → cria → consulta/ocupação → PUT → CRUD de details → cancel/409 → DELETE.
 * A reserva criada termina excluída (lógica), então o teste pode rodar de novo.
 *
 * Rodar: `npm run test:e2e -- reservations`
 */
jest.setTimeout(120_000);

const RESERVATIONS = '/api/v1/reservations';
const LESSON = '30000000-0000-4000-8000-000000000004';
const RESOURCE = '50000000-0000-4000-8000-000000000001';
const RESOURCE_ALT = '50000000-0000-4000-8000-000000000002';
const RESERVA_DE_OUTRO_PROFESSOR = '60000000-0000-4000-8000-000000000005';
/** Data coerente com a Lesson …0004 da massa stub (dezembro). */
const DATA = '2026-12-12';
const FAIXA = 'C';

/** PATCH do contrato é `application/merge-patch+json`; o `http` do harness só manda JSON comum. */
async function mergePatch(
	url: string,
	token: string,
	body: unknown,
): Promise<{ status: number; contentType: string; body: any }> {
	const response = await fetch(url, {
		method: 'PATCH',
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/merge-patch+json' },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(15_000),
	});
	const text = await response.text();
	return {
		status: response.status,
		contentType: response.headers.get('content-type') ?? '',
		body: text ? JSON.parse(text) : undefined,
	};
}

describe('BFF reservations — fim a fim completo', () => {
	let token: string;
	let bff: string;
	let reservationsUrl: string;
	let reservationId: string;
	let detailId: string;

	beforeAll(async () => {
		bff = urls.bff();
		reservationsUrl = urls.context('reservations', '8187');
		await waitForBff();
		token = await accessToken('professor@pucrs.br');
	});

	afterAll(async () => {
		if (reservationId) {
			await http('DELETE', `${bff}${RESERVATIONS}/${reservationId}`, { token }).catch(() => undefined);
		}
	});

	it('401 sem token, em problem+json', async () => {
		const res = await http('GET', `${bff}${RESERVATIONS}`);
		expect(res.status).toBe(401);
		expect(res.contentType).toContain('application/problem+json');
	});

	it('identidade do professor', async () => {
		const res = await http('GET', `${bff}/api/v1/identidade/me`, { token });
		expect(res.status).toBe(200);
		expect(res.body.professorId).toBe(res.body.sub);
	});

	it('cria a reserva pelo BFF e o corpo é o mesmo do backend', async () => {
		const created = await http('POST', `${bff}${RESERVATIONS}`, {
			token,
			body: {
				lessonId: LESSON,
				data: DATA,
				faixaId: FAIXA,
				resourceIds: [RESOURCE],
				purpose: 'E2E BFF completo',
			},
		});
		expect(created.status).toBe(201);
		reservationId = created.body.id;

		const pelaBff = await http('GET', `${bff}${RESERVATIONS}/${reservationId}`, { token });
		const direto = await http('GET', `${reservationsUrl}${RESERVATIONS}/${reservationId}`, { token });
		expect(pelaBff.status).toBe(200);
		expect(pelaBff.body).toEqual(direto.body);
	});

	it('query complexa chega intacta', async () => {
		const res = await http(
			'GET',
			`${bff}${RESERVATIONS}?purpose={like}%25E2E%20BFF%20completo%25&data={gteq}${DATA}`,
			{ token },
		);
		expect(res.status).toBe(200);
		expect(res.body.map((r: { id: string }) => r.id)).toContain(reservationId);
	});

	it('ocupacao lista o recurso da reserva ACTIVE', async () => {
		const res = await http(
			'GET',
			`${bff}${RESERVATIONS}/ocupacao?data=${DATA}&faixaId=${FAIXA}`,
			{ token },
		);
		expect(res.status).toBe(200);
		expect(res.body).toEqual(expect.any(Array));
		const resourceIds = res.body.map((item: { resourceId?: string; id?: string }) => item.resourceId ?? item.id);
		expect(resourceIds).toContain(RESOURCE);
	});

	it('PUT substitui a reserva (purpose e resourceIds)', async () => {
		const replaced = await http('PUT', `${bff}${RESERVATIONS}/${reservationId}`, {
			token,
			body: {
				lessonId: LESSON,
				data: DATA,
				faixaId: FAIXA,
				resourceIds: [RESOURCE, RESOURCE_ALT],
				purpose: 'E2E BFF substituído',
			},
		});
		expect(replaced.status).toBe(200);
		expect(replaced.body.purpose).toBe('E2E BFF substituído');
		expect(replaced.body.resourceIds.sort()).toEqual([RESOURCE, RESOURCE_ALT].sort());
	});

	describe('details (CRUD completo, enquanto ACTIVE)', () => {
		it('POST cria ocorrência', async () => {
			const res = await http('POST', `${bff}${RESERVATIONS}/${reservationId}/details`, {
				token,
				body: { description: 'Projetor (e2e)', resourceId: RESOURCE },
			});
			expect(res.status).toBe(201);
			expect(res.body.reservationId).toBe(reservationId);
			detailId = res.body.id;
			expect(detailId).toEqual(expect.any(String));
		});

		it('GET coleção lista a ocorrência', async () => {
			const res = await http('GET', `${bff}${RESERVATIONS}/${reservationId}/details`, { token });
			expect(res.status).toBe(200);
			expect(res.body.map((d: { id: string }) => d.id)).toContain(detailId);
		});

		it('GET item coincide com o backend direto', async () => {
			const suffix = `${RESERVATIONS}/${reservationId}/details/${detailId}`;
			const [viaBff, direto] = await Promise.all([
				http('GET', `${bff}${suffix}`, { token }),
				http('GET', `${reservationsUrl}${suffix}`, { token }),
			]);
			expect(viaBff.status).toBe(200);
			expect(viaBff.body).toEqual(direto.body);
		});

		it('PUT substitui a ocorrência', async () => {
			const res = await http('PUT', `${bff}${RESERVATIONS}/${reservationId}/details/${detailId}`, {
				token,
				body: {
					description: 'Projetor (e2e) substituído',
					status: 'RESOLVIDA',
					resourceId: RESOURCE_ALT,
				},
			});
			expect(res.status).toBe(200);
			expect(res.body.description).toBe('Projetor (e2e) substituído');
			expect(res.body.status).toBe('RESOLVIDA');
			expect(res.body.resourceId).toBe(RESOURCE_ALT);
		});

		it('PATCH altera parcialmente a ocorrência', async () => {
			const res = await mergePatch(
				`${bff}${RESERVATIONS}/${reservationId}/details/${detailId}`,
				token,
				{ description: 'Projetor (e2e) patch' },
			);
			expect(res.status).toBe(200);
			expect(res.body.description).toBe('Projetor (e2e) patch');
		});

		it('DELETE remove a ocorrência e o GET passa a 404', async () => {
			const removed = await http('DELETE', `${bff}${RESERVATIONS}/${reservationId}/details/${detailId}`, {
				token,
			});
			expect(removed.status).toBe(204);

			const after = await http('GET', `${bff}${RESERVATIONS}/${reservationId}/details/${detailId}`, {
				token,
			});
			expect(after.status).toBe(404);
		});
	});

	it('403 do domínio (reserva de outro professor) passa intacto', async () => {
		const res = await mergePatch(`${bff}${RESERVATIONS}/${RESERVA_DE_OUTRO_PROFESSOR}`, token, {
			purpose: 'invasão',
		});
		expect(res.status).toBe(403);
		expect(res.contentType).toContain('application/problem+json');
	});

	it('cancela por merge-patch; cancelar de novo dá 409 FR-30', async () => {
		const cancelada = await mergePatch(`${bff}${RESERVATIONS}/${reservationId}`, token, {
			status: 'CANCELLED',
		});
		expect(cancelada.status).toBe(200);
		expect(cancelada.body.status).toBe('CANCELLED');

		const deNovo = await mergePatch(`${bff}${RESERVATIONS}/${reservationId}`, token, {
			status: 'CANCELLED',
		});
		expect(deNovo.status).toBe(409);
		expect(deNovo.body.code).toBe('FR-30');
	});

	it('exclui (lógica) e depois o GET dá 404', async () => {
		const excluida = await http('DELETE', `${bff}${RESERVATIONS}/${reservationId}`, { token });
		expect(excluida.status).toBe(204);

		const depois = await http('GET', `${bff}${RESERVATIONS}/${reservationId}`, { token });
		expect(depois.status).toBe(404);
		reservationId = '';
	});
});
