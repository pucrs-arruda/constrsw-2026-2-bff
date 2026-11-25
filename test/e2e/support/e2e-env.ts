import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Apoio compartilhado dos testes fim a fim do BFF (`test/e2e/<contexto>.e2e-spec.ts`).
 *
 * O teste e2e fala com a stack **de verdade**, subida pelo `docker-compose.yml` do repositório
 * base: o BFF, os contextos e o Keycloak. Nada é dublado. Cada grupo escreve o próprio
 * `<contexto>.e2e-spec.ts` e reaproveita daqui a configuração, o token e o cliente HTTP.
 *
 * Configuração por variável de ambiente. Os defaults são as portas externas do `.env` do base, e o
 * que faltar (por exemplo `KEYCLOAK_CLIENT_SECRET`) é lido do próprio `.env` do base quando o BFF
 * está como submódulo em `backend/bff`. Nenhum valor é impresso.
 */
const BASE_ENV = loadBaseEnv();

export function setting(name: string, fallback?: string): string {
	const value = process.env[name] ?? BASE_ENV[name] ?? fallback;
	if (value === undefined || value === '') {
		throw new Error(`Defina a variável ${name} para rodar o teste e2e.`);
	}
	return value;
}

/** URLs vistas da máquina que roda o teste (portas externas do compose). */
export const urls = {
	bff: () => setting('E2E_BFF_URL', `http://localhost:${setting('BFF_EXTERNAL_API_PORT', '8180')}`),
	keycloak: () =>
		setting('E2E_KEYCLOAK_URL', `http://localhost:${setting('KEYCLOAK_EXTERNAL_API_PORT', '8081')}`),
	/** URL direta de um contexto, para comparar a resposta do BFF com a do dono do dado. */
	context: (name: string, defaultPort: string) =>
		setting(
			`E2E_${name.toUpperCase()}_URL`,
			`http://localhost:${setting(`${name.toUpperCase()}_EXTERNAL_API_PORT`, defaultPort)}`,
		),
};

/**
 * Senha dos usuários do realm de desenvolvimento. É o mesmo valor que o `accessToken()` abaixo já
 * usava como padrão; fica exportado para os specs de domínio não repetirem o literal nem exigirem
 * `E2E_PASSWORD` só para rodar contra o compose de desenvolvimento.
 */
export const defaultPassword = (): string => setting('E2E_PASSWORD', 'a12345678');

const tokenCache = new Map<string, string>();

/**
 * Access token do Keycloak pelo Direct Access Grant do client do realm (o mesmo que o oauth usa).
 * O usuário padrão é o `admin@pucrs.br` do realm de desenvolvimento.
 */
export async function accessToken(
	username = setting('E2E_USERNAME', 'admin@pucrs.br'),
	password = defaultPassword(),
): Promise<string> {
	const cached = tokenCache.get(username);
	if (cached) {
		return cached;
	}

	const realm = setting('KEYCLOAK_REALM', 'constrsw');
	const response = await fetch(`${urls.keycloak()}/realms/${realm}/protocol/openid-connect/token`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'password',
			client_id: setting('KEYCLOAK_CLIENT_ID', 'oauth'),
			client_secret: setting('KEYCLOAK_CLIENT_SECRET'),
			username,
			password,
		}),
	});
	if (!response.ok) {
		throw new Error(`Keycloak recusou o login de ${username}: HTTP ${response.status}`);
	}

	const token = ((await response.json()) as { access_token: string }).access_token;
	tokenCache.set(username, token);
	return token;
}

export interface HttpResult<T = any> {
	readonly status: number;
	readonly contentType: string;
	readonly body: T;
}

/** Chamada HTTP com corpo JSON opcional; devolve status, content-type e corpo já parseado. */
export async function http<T = any>(
	method: string,
	url: string,
	options: { token?: string; body?: unknown } = {},
): Promise<HttpResult<T>> {
	const headers: Record<string, string> = { accept: 'application/json' };
	if (options.token) {
		headers.authorization = `Bearer ${options.token}`;
	}
	if (options.body !== undefined) {
		headers['content-type'] = 'application/json';
	}

	const response = await fetch(url, {
		method,
		headers,
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
		signal: AbortSignal.timeout(15_000),
	});

	const text = await response.text();
	let body: unknown = text;
	try {
		body = text ? JSON.parse(text) : undefined;
	}
	catch {
		// corpo não JSON fica como texto
	}
	return { status: response.status, contentType: response.headers.get('content-type') ?? '', body: body as T };
}

/** Espera o BFF responder `GET /health`, para o teste não falhar enquanto o compose sobe. */
export async function waitForBff(timeoutMs = 60_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastError = '';
	while (Date.now() < deadline) {
		try {
			const res = await http('GET', `${urls.bff()}/health`);
			if (res.status === 200) {
				return;
			}
			lastError = `HTTP ${res.status}`;
		}
		catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
		await new Promise((done) => setTimeout(done, 2_000));
	}
	throw new Error(`BFF não respondeu /health em ${urls.bff()}: ${lastError}`);
}

/** Semestre em curso pela mesma regra do BFF, para montar dados e conferir a composição. */
export { currentSemester } from '../../../src/common/academic/current-semester';

function loadBaseEnv(): Record<string, string> {
	const path = process.env.E2E_BASE_ENV_FILE ?? resolve(__dirname, '../../../../../.env');
	let text: string;
	try {
		text = readFileSync(path, 'utf8');
	}
	catch {
		return {};
	}

	const raw: Record<string, string> = {};
	for (const line of text.split(/\r?\n/)) {
		const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
		if (match) {
			raw[match[1]] = match[2].replace(/^["']|["']$/g, '');
		}
	}
	// Resolve ${VAR} como o compose faz.
	const expand = (value: string, depth = 0): string =>
		depth > 10 ? value : value.replace(/\$\{([^}]+)\}/g, (_, key: string) => expand(raw[key] ?? '', depth + 1));
	return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, expand(value)]));
}
