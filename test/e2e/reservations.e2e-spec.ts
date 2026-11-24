import { accessToken, http, urls, waitForBff } from './support/e2e-env';

/**
 * Teste fim a fim do módulo `reservations` do BFF (Grupo 03), contra a stack real do compose:
 * BFF → reservations, com token do Keycloak (o mesmo harness do Grupo 04).
 *
 * Usa a massa de demonstração do reservations (ligada por padrão na imagem) e os dados fixos dos
 * outros contextos (`CLIENTS_MODE=stub`):
 * - Lesson `…0004` (12/12, faixa C) do `professor@pucrs.br` e o Resource `…0001`;
 * - a reserva `…0005` da massa, que é de outro professor (para o 403 da regra RN-02).
 *
 * Roteiro: identidade → cria a reserva pelo BFF → compara com o backend direto → ocorrência →
 * 403 do domínio intacto → cancela (merge-patch) → 409 FR-30 intacto → exclui → 404; e 401 sem token.
 * A reserva criada termina cancelada e excluída (exclusão lógica), então o teste pode rodar de novo.
 *
 * Rodar (com a stack no ar): `npm run test:e2e -- reservations`.
 */
jest.setTimeout(120_000);

const RESERVATIONS = '/api/v1/reservations';
const LESSON = '30000000-0000-4000-8000-000000000004';
const RESOURCE = '50000000-0000-4000-8000-000000000001';
const RESERVA_DE_OUTRO_PROFESSOR = '60000000-0000-4000-8000-000000000005';

/** PATCH do contrato é `application/merge-patch+json`; o `http` do harness só manda JSON comum. */
async function mergePatch(url: string, token: string, body: unknown): Promise<{ status: number; contentType: string; body: any }> {
	const response = await fetch(url, {
		method: 'PATCH',
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/merge-patch+json' },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(15_000),
	});
	const text = await response.text();
	return { status: response.status, contentType: response.headers.get('content-type') ?? '', body: text ? JSON.parse(text) : undefined };
}

describe('BFF reservations — fim a fim', () => {
	let token: string;
	let bff: string;
	let reservationsUrl: string;
	let reservationId: string;

	beforeAll(async () => {
		bff = urls.bff();
		reservationsUrl = urls.context('reservations', '8187');
		await waitForBff();
		token = await accessToken('professor@pucrs.br');
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
			body: { lessonId: LESSON, data: '2026-12-12', faixaId: 'C', resourceIds: [RESOURCE], purpose: 'E2E BFF' },
		});
		expect(created.status).toBe(201);
		reservationId = created.body.id;

		const pelaBff = await http('GET', `${bff}${RESERVATIONS}/${reservationId}`, { token });
		const direto = await http('GET', `${reservationsUrl}${RESERVATIONS}/${reservationId}`, { token });

		expect(pelaBff.status).toBe(200);
		expect(pelaBff.body).toEqual(direto.body);
	});

	it('query complexa chega intacta', async () => {
		const res = await http('GET', `${bff}${RESERVATIONS}?purpose={like}%25E2E%20BFF%25&data={gteq}2026-12-12`, { token });

		expect(res.status).toBe(200);
		expect(res.body.map((r: { id: string }) => r.id)).toContain(reservationId);
	});

	it('cria uma ocorrência', async () => {
		const res = await http('POST', `${bff}${RESERVATIONS}/${reservationId}/details`, {
			token,
			body: { description: 'Projetor (e2e)', resourceId: RESOURCE },
		});

		expect(res.status).toBe(201);
		expect(res.body.reservationId).toBe(reservationId);
	});

	it('403 do domínio (reserva de outro professor) passa intacto', async () => {
		const res = await mergePatch(`${bff}${RESERVATIONS}/${RESERVA_DE_OUTRO_PROFESSOR}`, token, { purpose: 'invasão' });

		expect(res.status).toBe(403);
		expect(res.contentType).toContain('application/problem+json');
	});

	it('cancela por merge-patch; cancelar de novo dá 409 FR-30', async () => {
		const cancelada = await mergePatch(`${bff}${RESERVATIONS}/${reservationId}`, token, { status: 'CANCELLED' });
		expect(cancelada.status).toBe(200);
		expect(cancelada.body.status).toBe('CANCELLED');

		const deNovo = await mergePatch(`${bff}${RESERVATIONS}/${reservationId}`, token, { status: 'CANCELLED' });
		expect(deNovo.status).toBe(409);
		expect(deNovo.body.code).toBe('FR-30');
	});

	it('exclui (lógica) e depois o GET dá 404', async () => {
		const excluida = await http('DELETE', `${bff}${RESERVATIONS}/${reservationId}`, { token });
		expect(excluida.status).toBe(204);

		const depois = await http('GET', `${bff}${RESERVATIONS}/${reservationId}`, { token });
		expect(depois.status).toBe(404);
	});
});
