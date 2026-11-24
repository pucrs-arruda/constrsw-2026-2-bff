import type { Request } from 'express';
import { bearerTokenOf } from './bearer-token';

describe('browser OAuth session bridge', () => {
	const cookie = `closed_cras_session=${encodeURIComponent(JSON.stringify({ access_token: 'access-only', refresh_token: 'never-forward' }))}`;
	const req = (headers: object, method = 'GET') => ({ headers, method } as Request);
	it('extracts only the access token from the OAuth session cookie', () => {
		expect(bearerTokenOf(req({ cookie }))).toBe('access-only');
	});
	it('supports Express j: prefixed JSON cookies', () => {
		expect(bearerTokenOf(req({ cookie: 'closed_cras_session=' + encodeURIComponent('j:{"access_token":"express-access","refresh_token":"hidden"}') }))).toBe('express-access');
	});
	it('prefers explicit Bearer to cookie credentials', () => {
		expect(bearerTokenOf(req({ cookie, authorization: 'Bearer api-client' }))).toBe('api-client');
	});
	it.each(['Basic something', 'Bearer ', 'Bearer one two'])('does not fall back from malformed Authorization %s', authorization => {
		expect(bearerTokenOf(req({ cookie, authorization }))).toBeUndefined();
	});
	it.each(['%not-encoded', '{"refresh_token":"not-access"}', '{"access_token":23}', '{"access_token":"a\\r\\nb"}'])('rejects malformed cookie %s', value => {
		expect(bearerTokenOf(req({ cookie: 'closed_cras_session=' + value }))).toBeUndefined();
	});
	it('uses the configured OAuth cookie name', () => {
		const previous = process.env.SESSION_COOKIE_NAME;
		process.env.SESSION_COOKIE_NAME = 'custom-session';
		try { expect(bearerTokenOf(req({ cookie: 'custom-session=' + encodeURIComponent('{"access_token":"configured"}') }))).toBe('configured'); }
		finally { if (previous === undefined) delete process.env.SESSION_COOKIE_NAME; else process.env.SESSION_COOKIE_NAME = previous; }
	});
});
