import type { Request } from 'express';

// OAuth issues the HttpOnly cookie. Domains validate the forwarded access token.
const TOKEN = /^[A-Za-z0-9._~+\/-]+=*$/;
const validToken = (value: unknown): value is string => typeof value === 'string' && TOKEN.test(value);

export function bearerTokenOf(request: Request): string | undefined {
	const authorization = request.headers.authorization;
	if (authorization !== undefined) return /^Bearer ([A-Za-z0-9._~+\/-]+=*)$/i.exec(authorization)?.[1];
	const injected = (request as Request & { bearerToken?: string }).bearerToken;
	if (validToken(injected)) return injected;
	const name = process.env.SESSION_COOKIE_NAME ?? 'closed_cras_session';
	const cookies = request.headers.cookie?.split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`));
	if (cookies?.length !== 1 || cookies[0].length > 16384) return undefined;
	try {
		let value = decodeURIComponent(cookies[0].slice(name.length + 1));
		if (value.startsWith('j:')) value = value.slice(2);
		const session: unknown = JSON.parse(value);
		if (session && typeof session === 'object' && 'access_token' in session && validToken(session.access_token)) return session.access_token;
	} catch { /* Invalid cookies are treated as missing credentials. */ }
	return undefined;
}
