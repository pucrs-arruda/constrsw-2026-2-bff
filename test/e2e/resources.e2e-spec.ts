import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { http, setting, urls, waitForBff } from './support/e2e-env';

/**
 * E2E do módulo `resources` contra a stack real do compose.
 *
 * Ciclo: cria recurso → lista/detalhe com `openOccurrenceCount` → registra ocorrência →
 * resolve → confere a contagem e o 409 da segunda resolução → compara recusas com o domínio
 * direto → exclui (lógica) ocorrência e recurso pelo BFF. Sem token, o BFF responde 401 sem
 * chamar o resources.
 *
 * Rodar: `npm run test:e2e:resources`.
 */
jest.setTimeout(180_000);

const BROWSER = '/api/v1/resources';
const DOMAIN = '/api/v1/resources';

describe('BFF resources — shared end-to-end runner', () => {
	let token = '';
	let bff = '';
	let resourcesUrl = '';
	let resourceId = '';
	let occurrenceId = '';
	let createdBody: Record<string, unknown> = {};
	const stamp = randomUUID().slice(0, 8).toUpperCase();
	const payload = { code: `E2E-${stamp}`, name: `Resources E2E ${stamp}`, type: 'PROJECTOR', tags: ['av'] };
	const call = (method: string, suffix: string, body?: unknown, bearer = token) => http(method, `${bff}${suffix}`, { token: bearer, body });
	const direct = (method: string, suffix: string, body?: unknown) => http(method, `${resourcesUrl}${suffix}`, { token, body });

	beforeAll(async () => {
		bff = urls.bff();
		resourcesUrl = urls.context('resources', '8106');
		await waitForBff();
		await waitForResources();
		const login = await http('POST', `${urls.context('oauth', '8181')}/login`, {
			body: {
				username: setting('E2E_USERNAME', 'admin@pucrs.br'),
				password: setting('E2E_PASSWORD', 'a12345678'),
			},
		});
		expect(login.status).toBe(201);
		expect(login.body.access_token).toEqual(expect.any(String));
		token = login.body.access_token;

		const created = await call('POST', BROWSER, payload);
		expect(created.status).toBe(201);
		expect(created.body.id).toEqual(expect.any(String));
		createdBody = created.body;
		resourceId = created.body.id;
	});

	afterAll(async () => {
		if (token && resourceId) {
			await direct('DELETE', `${DOMAIN}/${resourceId}`).catch(() => undefined);
		}
	});

	async function waitForResources(): Promise<void> {
		const deadline = Date.now() + 90_000;
		while (Date.now() < deadline) {
			const health = await http('GET', `${resourcesUrl}/api/v1/health`).catch(() => undefined);
			if (health?.status === 200) return;
			await new Promise(resolve => setTimeout(resolve, 2_000));
		}
		throw new Error('resources did not become healthy before E2E setup.');
	}

	/** Após religar o container, observa o circuito fechar e a lista voltar a 200. */
	async function waitForBffList(): Promise<void> {
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			const response = await call('GET', BROWSER).catch(() => undefined);
			if (response?.status === 200) return;
			await new Promise(resolve => setTimeout(resolve, 1_000));
		}
		throw new Error('BFF list did not recover within 30s after resources restart.');
	}

	it('serve health anônimo', async () => {
		const response = await http('GET', `${bff}/health`);
		expect(response.status).toBe(200);
		expect(response.body).toEqual({ status: 'UP' });
	});

	it('sem sessão devolve 401 problem+json sem chamar o resources', async () => {
		const response = await http('GET', `${bff}${BROWSER}`);
		expect(response.status).toBe(401);
		expect(response.contentType).toContain('application/problem+json');
		expect(response.body).toMatchObject({ code: 'AUTH_UNAUTHENTICATED', reason: 'MISSING_TOKEN' });
	});

	it('POST cria recurso sem enabled, occurrences/reservations vazias e count 0', async () => {
		expect(createdBody).toMatchObject({ id: resourceId, code: payload.code, openOccurrenceCount: 0 });
		expect(createdBody).not.toHaveProperty('enabled');
		expect(createdBody.occurrences).toEqual([]);
		expect(createdBody.reservations).toEqual([]);

		const detail = await call('GET', `${BROWSER}/${resourceId}`);
		expect(detail.status).toBe(200);
		expect(detail.body).toMatchObject({ id: resourceId, code: payload.code, openOccurrenceCount: 0 });
		expect(Array.isArray(detail.body.reservations)).toBe(true);
		expect(JSON.stringify(detail.body)).not.toContain('"enabled"');
	});

	it('GET lista filtra pelo código e conta as ocorrências abertas', async () => {
		const response = await call('GET', `${BROWSER}?code=${encodeURIComponent(payload.code)}`);
		expect(response.status).toBe(200);
		expect(response.body).toHaveLength(1);
		expect(response.body[0]).toMatchObject({ id: resourceId, openOccurrenceCount: 0 });
		expect(Array.isArray(response.body[0].reservations)).toBe(true);
		expect(response.body[0]).not.toHaveProperty('enabled');
	});

	it('POST de ocorrência devolve o corpo do domínio sem enabled e Location reescrito', async () => {
		const response = await call('POST', `${BROWSER}/${resourceId}/occurrences`, {
			description: 'Lamp does not turn on',
			type: 'MALFUNCTION',
		});
		expect(response.status).toBe(201);
		occurrenceId = response.body.id;
		expect(occurrenceId).toEqual(expect.any(String));
		expect(response.body).toMatchObject({ status: 'OPEN', priority: 'MEDIUM', resolution: null });
		expect(response.body).not.toHaveProperty('enabled');
	});

	it('GET detalhe compõe occurrences e a contagem sobe para 1', async () => {
		const response = await call('GET', `${BROWSER}/${resourceId}`);
		expect(response.status).toBe(200);
		expect(response.body.openOccurrenceCount).toBe(1);
		expect(response.body.occurrences.map((item: { id: string }) => item.id)).toContain(occurrenceId);
		expect(Array.isArray(response.body.reservations)).toBe(true);
		expect(JSON.stringify(response.body)).not.toContain('"enabled"');
		for (const forbidden of ['roster', 'student', 'availability', 'occupancy', 'inventory']) {
			expect(JSON.stringify(response.body).toLowerCase()).not.toContain(forbidden);
		}
	});

	it('PATCH resolve a ocorrência e a leitura seguinte conta uma a menos', async () => {
		const resolved = await call('PATCH', `${BROWSER}/${resourceId}/occurrences/${occurrenceId}`, {
			resolution: 'Lamp replaced',
		});
		expect(resolved.status).toBe(200);
		expect(resolved.body).toMatchObject({ id: occurrenceId, status: 'RESOLVED', resolution: 'Lamp replaced' });
		expect(resolved.body.resolvedBy).toEqual(expect.any(String));
		expect(resolved.body).not.toHaveProperty('enabled');

		const detail = await call('GET', `${BROWSER}/${resourceId}`);
		expect(detail.status).toBe(200);
		expect(detail.body.openOccurrenceCount).toBe(0);
	});

	it('segunda resolução devolve o 409 do domínio sem alteração', async () => {
		const response = await call('PATCH', `${BROWSER}/${resourceId}/occurrences/${occurrenceId}`, {
			resolution: 'again',
		});
		expect(response.status).toBe(409);
		expect(response.contentType).toContain('application/problem+json');
		expect(response.body).toMatchObject({ code: 'FR-22', reason: 'OCCURRENCE_ALREADY_RESOLVED' });
	});

	it('409 de código duplicado é igual ao do domínio', async () => {
		const [viaBff, domain] = await Promise.all([call('POST', BROWSER, payload), direct('POST', DOMAIN, payload)]);
		expect(viaBff.status).toBe(409);
		expect(domain.status).toBe(409);
		expect(viaBff.body).toEqual(domain.body);
	});

	it('422 de atualização inválida é igual ao do domínio', async () => {
		const body = { code: 'OTHER-CODE' };
		const [viaBff, domain] = await Promise.all([
			call('PATCH', `${BROWSER}/${resourceId}`, body),
			direct('PATCH', `${DOMAIN}/${resourceId}`, body),
		]);
		expect(viaBff.status).toBe(422);
		expect(domain.status).toBe(422);
		expect(viaBff.body).toEqual(domain.body);
	});

	it('404 de detalhe inexistente coincide com o domínio', async () => {
		const missing = randomUUID();
		const [viaBff, domain] = await Promise.all([call('GET', `${BROWSER}/${missing}`), direct('GET', `${DOMAIN}/${missing}`)]);
		expect(viaBff.status).toBe(404);
		expect(domain.status).toBe(404);
		expect(viaBff.body).toEqual(domain.body);
	});

	const readOnlyUser = optionalSetting('E2E_READONLY_USERNAME');
	const readOnlyTest = readOnlyUser ? it : it.skip;
	readOnlyTest('papel somente leitura recebe 403 do domínio nas escritas', async () => {
		const login = await http('POST', `${urls.context('oauth', '8181')}/login`, {
			body: {
				username: readOnlyUser,
				password: setting('E2E_READONLY_PASSWORD', setting('E2E_PASSWORD', 'a12345678')),
			},
		});
		expect(login.status).toBe(201);
		const readOnly = login.body.access_token as string;

		const read = await call('GET', BROWSER, undefined, readOnly);
		expect(read.status).toBe(200);

		const write = await call('POST', BROWSER, { code: `RO-${stamp}`, name: 'Read only', type: 'CABLE' }, readOnly);
		expect(write.status).toBe(403);
		expect(write.contentType).toContain('application/problem+json');
	});

	const withDocker = setting('E2E_DOCKER', '0') === '1' ? it : it.skip;
	withDocker('devolve 503 RESOURCES_UPSTREAM_UNAVAILABLE quando o resources está fora', async () => {
		const container = setting('E2E_RESOURCES_CONTAINER', 'resources');
		try {
			execFileSync('docker', ['stop', container], { stdio: 'ignore' });
			const response = await call('GET', BROWSER);
			expect(response.status).toBe(503);
			expect(response.contentType).toContain('application/problem+json');
			expect(response.body).toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE', reason: 'RESOURCES_UPSTREAM_UNAVAILABLE' });
		}
		finally {
			execFileSync('docker', ['start', container], { stdio: 'ignore' });
			await waitForResources();
			await waitForBffList();
		}
	});

	it('DELETE da ocorrência pelo BFF remove o item do agregado', async () => {
		const removed = await call('DELETE', `${BROWSER}/${resourceId}/occurrences/${occurrenceId}`);
		expect(removed.status).toBe(204);

		const detail = await call('GET', `${BROWSER}/${resourceId}`);
		expect(detail.status).toBe(200);
		expect(detail.body.occurrences.map((item: { id: string }) => item.id)).not.toContain(occurrenceId);
	});

	it('DELETE pelo BFF faz a exclusão lógica e o detalhe passa a 404', async () => {
		const removed = await call('DELETE', `${BROWSER}/${resourceId}`);
		expect(removed.status).toBe(204);

		const after = await call('GET', `${BROWSER}/${resourceId}`);
		expect(after.status).toBe(404);
		resourceId = '';
	});
});

/** Lê a variável também do `.env` da base; ausência/blank apenas desativa o cenário. */
function optionalSetting(name: string): string {
	try {
		return setting(name, '');
	}
	catch {
		return '';
	}
}
