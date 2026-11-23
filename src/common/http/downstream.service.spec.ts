import { httpFixture } from '../../testing/http-fixture';
import { CircuitBreaker } from './circuit-breaker';
import { DownstreamService, DownstreamUnavailableError } from './downstream.service';

function client(baseUrl: string, overrides = {}) {
	const breaker = new CircuitBreaker({ name: 'test', errorThresholdPercentage: 50, resetTimeoutMs: 10000, volumeThreshold: 2, rollingWindowMs: 10000 });
	return { breaker, http: new DownstreamService({ name: 'test', baseUrl, timeoutMs: 1000, retries: 0, breaker, ...overrides }) };
}

describe('HTTP downstream boundary', () => {
	it('does not open a healthy downstream circuit when callers cancel', async () => {
		const fixture = await httpFixture(request => request.url === '/slow' ? { delay: 500 } : {});
		try {
			const { http, breaker } = client(fixture.url);
			for (let i = 0; i < 2; i++) {
				const abort = new AbortController();
				const pending = http.send({ method: 'GET', path: '/slow', signal: abort.signal });
				setTimeout(() => abort.abort(), 30);
				await expect(pending).rejects.toBeInstanceOf(DownstreamUnavailableError);
			}
			expect(breaker.currentState()).toBe('closed');
			expect((await http.send({ method: 'GET', path: '/healthy' })).status).toBe(200);
		} finally { await fixture.close(); }
	});
	it('releases a cancelled half-open probe without recording a dependency failure', async () => {
		const fixture = await httpFixture(request => request.url === '/failure' ? { status: 503 } : request.url === '/slow' ? { delay: 500 } : {});
		try {
			const breaker = new CircuitBreaker({ name: 'test', errorThresholdPercentage: 50, resetTimeoutMs: 10, volumeThreshold: 1, rollingWindowMs: 10000 });
			const { http } = client(fixture.url, { breaker });
			await http.send({ method: 'GET', path: '/failure' });
			await new Promise(resolve => setTimeout(resolve, 20));
			const abort = new AbortController();
			const pending = http.send({ method: 'GET', path: '/slow', signal: abort.signal });
			setTimeout(() => abort.abort(), 30);
			await expect(pending).rejects.toBeInstanceOf(DownstreamUnavailableError);
			expect(breaker.currentState()).toBe('half-open');
			expect((await http.send({ method: 'GET', path: '/healthy' })).status).toBe(200);
			expect(breaker.currentState()).toBe('closed');
		} finally { await fixture.close(); }
	});
	it('preserves Location and pagination totals without leaking Set-Cookie', async () => {
		const fixture = await httpFixture(() => ({ status: 201, body: '{}', headers: { location: '/api/v1/rooms/1', 'x-total-count': '41', 'set-cookie': 'private=secret' } }));
		try {
			const response = await client(fixture.url).http.send({ method: 'POST', path: '/rooms' });
			expect((response as any).headers).toEqual({ location: '/api/v1/rooms/1', 'x-total-count': '41' });
		} finally { await fixture.close(); }
	});
	it('counts HTTP 503 as breaker failures while preserving the original response', async () => {
		const fixture = await httpFixture(() => ({ status: 503, body: '{"down":true}' }));
		try {
			const { http, breaker } = client(fixture.url);
			expect((await http.send({ method: 'GET', path: '/' })).status).toBe(503);
			await http.send({ method: 'GET', path: '/' });
			expect(breaker.currentState()).toBe('open');
			await expect(http.send({ method: 'GET', path: '/' })).rejects.toBeInstanceOf(DownstreamUnavailableError);
			expect(fixture.seen).toHaveLength(2);
		} finally { await fixture.close(); }
	});
	it('does not follow redirects or replay writes after a redirect', async () => {
		const fixture = await httpFixture(request => request.url === '/first' ? { status: 307, headers: { location: '/second' } } : { status: 201 });
		try {
			const response = await client(fixture.url).http.send({ method: 'POST', path: '/first', body: '{}' });
			expect(response.status).toBe(307);
			expect(fixture.seen.map(request => request.url)).toEqual(['/first']);
		} finally { await fixture.close(); }
	});
	it('does not retry PUT or DELETE when restricted to safe retries', async () => {
		const fixture = await httpFixture(() => ({ delay: 70 }));
		try {
			for (const method of ['PUT', 'DELETE']) {
				const { http } = client(fixture.url, { retries: 2, timeoutMs: 25, retryMethods: ['GET', 'HEAD'] });
				await expect(http.send({ method, path: '/' })).rejects.toBeInstanceOf(DownstreamUnavailableError);
			}
			expect(fixture.seen.map(request => request.method)).toEqual(['PUT', 'DELETE']);
		} finally { await fixture.close(); }
	});
	it('bounds safe network retries and times out slow response bodies', async () => {
		const fixture = await httpFixture(() => ({ delay: 70 }));
		try {
			const { http } = client(fixture.url, { retries: 1, timeoutMs: 25, breaker: new CircuitBreaker({ name: 'test', errorThresholdPercentage: 50, resetTimeoutMs: 10000, volumeThreshold: 10, rollingWindowMs: 10000 }) });
			await expect(http.send({ method: 'GET', path: '/' })).rejects.toBeInstanceOf(DownstreamUnavailableError);
			expect(fixture.seen).toHaveLength(2);
		} finally { await fixture.close(); }
	});
	it('honors caller cancellation without retrying', async () => {
		const fixture = await httpFixture(() => ({ delay: 500 }));
		try {
			const abort = new AbortController();
			const { http } = client(fixture.url, { retries: 2 });
			const pending = http.send({ method: 'GET', path: '/', ...{ signal: abort.signal } });
			setTimeout(() => abort.abort(), 40);
			await expect(pending).rejects.toBeInstanceOf(DownstreamUnavailableError);
			expect(fixture.seen).toHaveLength(1);
		} finally { await fixture.close(); }
	});
});
