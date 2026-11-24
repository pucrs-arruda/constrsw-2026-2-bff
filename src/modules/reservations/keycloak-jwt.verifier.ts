import { createPublicKey, verify as verifySignature, type JsonWebKey, type KeyObject } from 'node:crypto';

/**
 * Valida o JWT do usuário **direto no Keycloak** (decisão do Grupo 03): assinatura pelas chaves
 * públicas do realm (JWKS), `iss`, `aud` e validade.
 *
 * O endereço das chaves sai do próprio `JWT_ISSUER` (`<issuer>/protocol/openid-connect/certs`),
 * então não há variável nova no compose do base. Só `node:crypto`, sem dependência extra.
 *
 * As chaves ficam em memória. `kid` desconhecido (o Keycloak girou a chave) busca o JWKS de novo,
 * no máximo uma vez a cada `refreshCooldownMs`, para um token forjado não virar martelo no Keycloak.
 */
export interface KeycloakJwtOptions {
	/** `iss` aceito; também é a base do JWKS. */
	readonly issuer: string;
	/** Valor que precisa estar em `aud`. */
	readonly audience: string;
	/** Timeout da busca do JWKS. */
	readonly timeoutMs: number;
	/** Folga de relógio, em segundos, para `exp` e `nbf`. */
	readonly clockSkewSeconds?: number;
	/** Intervalo mínimo entre duas buscas do JWKS por `kid` desconhecido. */
	readonly refreshCooldownMs?: number;
}

export type JwtCheck =
	| { readonly ok: true; readonly claims: Readonly<Record<string, unknown>> }
	| { readonly ok: false; readonly status: 401 | 503; readonly reason: string };

/** Algoritmos RSA que o Keycloak usa para assinar o access token. */
const HASH_BY_ALG: Readonly<Record<string, string>> = { RS256: 'sha256', RS384: 'sha384', RS512: 'sha512' };

export class KeycloakJwtVerifier {
	readonly jwksUrl: string;
	private readonly issuer: string;
	private readonly realmPath: string;
	private keys = new Map<string, KeyObject>();
	private lastFetchAt = 0;
	private inflight?: Promise<void>;

	constructor(private readonly options: KeycloakJwtOptions) {
		this.issuer = withoutTrailingSlash(options.issuer);
		this.jwksUrl = `${this.issuer}/protocol/openid-connect/certs`;
		this.realmPath = new URL(this.issuer).pathname;
	}

	async verify(token: string | undefined): Promise<JwtCheck> {
		if (!token) {
			return unauthorized('token ausente');
		}

		const parts = token.split('.');
		if (parts.length !== 3) {
			return unauthorized('token mal formado');
		}

		let header: Record<string, unknown>;
		let claims: Record<string, unknown>;
		try {
			header = decodeJson(parts[0]);
			claims = decodeJson(parts[1]);
		}
		catch {
			return unauthorized('token mal formado');
		}

		const hash = typeof header.alg === 'string' ? HASH_BY_ALG[header.alg] : undefined;
		if (!hash || typeof header.kid !== 'string') {
			return unauthorized('algoritmo ou kid não aceito');
		}

		let key: KeyObject | undefined;
		try {
			key = await this.keyFor(header.kid);
		}
		catch (error) {
			return { ok: false, status: 503, reason: `JWKS indisponível: ${messageOf(error)}` };
		}
		if (!key) {
			return unauthorized('kid desconhecido');
		}

		const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
		if (!verifySignature(hash, signed, key, Buffer.from(parts[2], 'base64url'))) {
			return unauthorized('assinatura inválida');
		}

		return this.checkClaims(claims);
	}

	private checkClaims(claims: Record<string, unknown>): JwtCheck {
		const skew = this.options.clockSkewSeconds ?? 30;
		const now = Math.floor(Date.now() / 1000);

		if (typeof claims.iss !== 'string' || !this.acceptsIssuer(claims.iss)) {
			return unauthorized('iss não aceito');
		}
		const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
		if (!aud.includes(this.options.audience)) {
			return unauthorized('aud não aceito');
		}
		if (typeof claims.exp !== 'number' || claims.exp + skew <= now) {
			return unauthorized('token expirado');
		}
		if (typeof claims.nbf === 'number' && claims.nbf - skew > now) {
			return unauthorized('token ainda não vale');
		}
		return { ok: true, claims };
	}

	/**
	 * O Keycloak põe no `iss` o host pelo qual o token foi pedido: `keycloak:8080` (pelo oauth, dentro
	 * do compose) ou `localhost:8081` (direto do host, como no harness e2e do BFF e no Postman). Os dois
	 * são o mesmo realm, então vale o mesmo caminho `/realms/<realm>` em qualquer host. Isso não abre
	 * brecha: a assinatura já foi conferida com as chaves do JWKS de `JWT_ISSUER`, que só esse
	 * Keycloak tem.
	 */
	private acceptsIssuer(iss: string): boolean {
		const candidate = withoutTrailingSlash(iss);
		if (candidate === this.issuer) {
			return true;
		}
		try {
			const url = new URL(candidate);
			return (url.protocol === 'http:' || url.protocol === 'https:') && url.pathname === this.realmPath;
		}
		catch {
			return false;
		}
	}

	private async keyFor(kid: string): Promise<KeyObject | undefined> {
		const cached = this.keys.get(kid);
		if (cached) {
			return cached;
		}
		const cooldown = this.options.refreshCooldownMs ?? 30_000;
		if (this.lastFetchAt > 0 && Date.now() - this.lastFetchAt < cooldown) {
			return undefined;
		}
		await this.refresh();
		return this.keys.get(kid);
	}

	/** Uma busca por vez: requisições simultâneas esperam a mesma. */
	private refresh(): Promise<void> {
		this.inflight ??= this.fetchKeys().finally(() => {
			this.inflight = undefined;
		});
		return this.inflight;
	}

	private async fetchKeys(): Promise<void> {
		const response = await fetch(this.jwksUrl, { signal: AbortSignal.timeout(this.options.timeoutMs) });
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		const body = (await response.json()) as { keys?: Array<JsonWebKey & { kid?: unknown; use?: unknown }> };

		const next = new Map<string, KeyObject>();
		for (const jwk of body.keys ?? []) {
			// O realm publica também a chave de criptografia (use = enc); só a de assinatura interessa.
			if (jwk.kty !== 'RSA' || typeof jwk.kid !== 'string' || (jwk.use !== undefined && jwk.use !== 'sig')) {
				continue;
			}
			try {
				next.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }));
			}
			catch {
				// chave que o Node não entende: ignora e segue com as outras
			}
		}
		this.keys = next;
		this.lastFetchAt = Date.now();
	}
}

function unauthorized(reason: string): JwtCheck {
	return { ok: false, status: 401, reason };
}

function decodeJson(segment: string): Record<string, unknown> {
	const value: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error('não é objeto');
	}
	return value as Record<string, unknown>;
}

function withoutTrailingSlash(url: string): string {
	return url.replace(/\/+$/, '');
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
