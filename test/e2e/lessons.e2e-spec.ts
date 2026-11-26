import { randomUUID } from 'node:crypto';
import { defaultPassword, http, setting, urls, waitForBff } from './support/e2e-env';

// OAuth obtains the JWT over the internal Keycloak URL, matching the issuer trusted
// by Lessons. Direct login through localhost can produce a different issuer.
async function oauthToken(username: string): Promise<string> {
	const oauth = setting('E2E_OAUTH_URL', `http://localhost:${setting('OAUTH_EXTERNAL_API_PORT', '8181')}`);
	const result = await http('POST', `${oauth}/login`, {
		body: { username, password: defaultPassword() },
	});
	if (result.status !== 201 || typeof result.body?.access_token !== 'string') {
		throw new Error(`OAuth login failed: HTTP ${result.status}`);
	}
	return result.body.access_token;
}

// Stack real: UUIDs inexistentes cobrem as 13 operações sem criar massa de domínio.
// CRUD e geração com sucesso dependem do alinhamento do contrato de Classes.
jest.setTimeout(120_000);

describe('BFF Lessons — autenticação e recusas idempotentes na stack real', () => {
	let token: string;
	const missingClass = randomUUID();
	const lesson = randomUUID();
	const topic = randomUUID();
	const prefix = '/api/v1/lessons';
	const operations: [string, string, unknown, number][] = [
		['GET', '', undefined, 200],
		['POST', '', { classId: missingClass, date: '2026-11-04', timeSlotId: 'H' }, 400],
		['POST', '/generate', { classId: missingClass }, 400],
		['GET', `/${lesson}`, undefined, 404],
		['PUT', `/${lesson}`, { modality: 'REMOTE', hasAssessment: false }, 404],
		['PATCH', `/${lesson}`, { hasAssessment: true }, 404],
		['DELETE', `/${lesson}`, undefined, 404],
		['GET', `/${lesson}/topics`, undefined, 404],
		['POST', `/${lesson}/topics`, { order: 1, statement: 'E2E sem persistência' }, 404],
		['GET', `/${lesson}/topics/${topic}`, undefined, 404],
		['PUT', `/${lesson}/topics/${topic}`, { order: 1, statement: 'E2E' }, 404],
		['PATCH', `/${lesson}/topics/${topic}`, { statement: 'E2E' }, 404],
		['DELETE', `/${lesson}/topics/${topic}`, undefined, 404],
	];

	beforeAll(async () => {
		await waitForBff();
		token = await oauthToken('coordinator@pucrs.br');
	});

	it.each([undefined, 'invalid'])('token ausente/inválido é recusado pelo domínio', async badToken => {
		const result = await http('GET', urls.bff() + prefix, { token: badToken });
		expect(result.status).toBe(401);
	});

	it.each(operations)('%s %s preserva resposta real de Lessons', async (method, suffix, body, status) => {
		const path = prefix + suffix;
		const direct = await http(method, urls.context('lessons', '8185') + path, { token, body });
		const proxied = await http(method, urls.bff() + path, { token, body });
		expect(direct.status).toBe(status);
		expect(proxied.status).toBe(direct.status);
		expect(proxied.body).toEqual(direct.body);
		expect(proxied.contentType.split(';')[0]).toBe(direct.contentType.split(';')[0]);
	});

	it('aluno não pode gerar aulas', async () => {
		const student = await oauthToken('student@pucrs.br');
		const result = await http('POST', urls.bff() + prefix + '/generate', {
			token: student, body: { classId: missingClass },
		});
		expect(result.status).toBe(403);
	});
});
