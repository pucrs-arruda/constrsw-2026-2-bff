import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { httpFixture, Reply } from './testing/http-fixture';
import { course, COURSE_ID, currentClass } from './testing/domain-fixtures';

describe('Courses BFF over real HTTP boundaries', () => {
	let app: INestApplication;
	let courses: Awaited<ReturnType<typeof httpFixture>>;
	let classes: Awaited<ReturnType<typeof httpFixture>>;
	let courseReply: Reply;
	let classesReply: Reply;
	let now: Date;
	const originalEnv = { ...process.env };
	beforeEach(async () => {
		now = new Date('2026-08-02T12:00:00Z');
		courseReply = { body: JSON.stringify([course]) };
		classesReply = { body: JSON.stringify([currentClass]) };
		courses = await httpFixture(() => courseReply);
		classes = await httpFixture(() => classesReply);
		Object.assign(process.env, { COURSES_BASE_URL: courses.url, CLASSES_BASE_URL: classes.url, BFF_HTTP_RETRIES: '0', BFF_HTTP_TIMEOUT_MS: '200', BFF_CIRCUIT_BREAKER_VOLUME_THRESHOLD: '2' });
		const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider('COURSES_CLOCK').useValue(() => now).compile();
		app = module.createNestApplication({ bodyParser: false, logger: false });
		configureApp(app);
		await app.init();
	});
	afterEach(async () => {
		await app.close(); await courses.close(); await classes.close();
		for (const key of ['COURSES_BASE_URL', 'CLASSES_BASE_URL', 'BFF_HTTP_RETRIES', 'BFF_HTTP_TIMEOUT_MS', 'BFF_CIRCUIT_BREAKER_VOLUME_THRESHOLD']) {
			if (originalEnv[key] === undefined) delete process.env[key]; else process.env[key] = originalEnv[key];
		}
	});
	const id = COURSE_ID;
	const routes: Array<[string, string, number]> = [
		['get', '', 200], ['post', '', 201], ['get', `/${id}`, 200], ['put', `/${id}`, 200], ['patch', `/${id}`, 200], ['delete', `/${id}`, 204],
		['get', `/${id}/bibliographic-references`, 200], ['post', `/${id}/bibliographic-references`, 201],
		['get', `/${id}/bibliographic-references/ref`, 200], ['put', `/${id}/bibliographic-references/ref`, 200], ['patch', `/${id}/bibliographic-references/ref`, 200], ['delete', `/${id}/bibliographic-references/ref`, 204],
		['get', `/${id}/syllabus-items`, 200], ['post', `/${id}/syllabus-items`, 201],
		['get', `/${id}/syllabus-items/item`, 200], ['put', `/${id}/syllabus-items/item`, 200], ['patch', `/${id}/syllabus-items/item`, 200], ['delete', `/${id}/syllabus-items/item`, 204],
		['get', '/syllabus-items/item', 200],
	];
	it.each(routes)('%s %s forwards the domain method, query, status and headers', async (method, suffix, status) => {
		const compose = method === 'get' && (suffix === '' || suffix === `/${id}`);
		const payload = compose ? (suffix ? course : [course]) : { domain: 'unchanged' };
		courseReply = { status, body: status === 204 ? '' : JSON.stringify(payload), headers: { location: '/api/v1/courses/new', 'x-total-count': '9' } };
		let pending = (request(app.getHttpServer()) as any)[method](`/api/v1/courses${suffix}?name=%7Blike%7D%25SW%25&sort=code&page=2`).set('Authorization', 'Bearer caller-access');
		if (['post', 'put', 'patch'].includes(method)) pending = pending.send({ name: 'Submitted' });
		const response = await pending.expect(status);
		expect(courses.seen[0].method).toBe(method.toUpperCase());
		expect(courses.seen[0].url).toBe(`/api/v1/courses${suffix}?name=%7Blike%7D%25SW%25&sort=code&page=2`);
		expect(courses.seen[0].headers.authorization).toBe('Bearer caller-access');
		expect(response.headers['x-total-count']).toBe('9');
		expect(response.headers.location).toBe('/api/v1/courses/new');
		if (status === 204) expect(response.text).toBe('');
		else if (compose) expect(response.body).toEqual(suffix ? { ...course, classes: [currentClass] } : [{ ...course, classes: [currentClass] }]);
		else expect(response.body).toEqual(payload);
		expect(classes.seen).toHaveLength(compose ? 1 : 0);
		if (['post', 'put', 'patch'].includes(method)) expect(courses.seen[0].body).toBe('{"name":"Submitted"}');
	});
	it('uses one current-semester query and filters disabled, unrelated and old Classes', async () => {
		courseReply.body = JSON.stringify([course, { ...course, id: '66666666-6666-4666-8666-666666666666' }]);
		classesReply.body = JSON.stringify([currentClass, { ...currentClass, enabled: false }, { ...currentClass, year: 2025 }, { ...currentClass, semester: 1 }, { ...currentClass, courseId: 'unrelated' }]);
		const response = await request(app.getHttpServer()).get('/api/v1/courses?year=1900&semester=1').set('Authorization', 'Bearer same-token').expect(200);
		expect(response.body[0]).toEqual({ ...course, classes: [currentClass] });
		expect(response.body[1].classes).toEqual([]);
		expect(classes.seen).toHaveLength(1);
		expect(classes.seen[0].url).toBe('/api/v1/classes?year=2026&semester=2');
		expect(classes.seen[0].headers.authorization).toBe('Bearer same-token');
	});
	it.each([
		['2026-08-01T02:59:59Z', 2026, 1], ['2026-08-01T03:00:00Z', 2026, 2],
		['2027-01-01T02:59:59Z', 2026, 2], ['2027-01-01T03:00:00Z', 2027, 1],
	])('determines semester at Sao Paulo boundary %s', async (instant, year, semester) => {
		now = new Date(instant as string); classesReply.body = '[]';
		await request(app.getHttpServer()).get('/api/v1/courses').expect(200);
		expect(classes.seen[0].url).toBe(`/api/v1/classes?year=${year}&semester=${semester}`);
	});
	it('does not call Classes for an empty course collection', async () => {
		courseReply.body = '[]';
		const response = await request(app.getHttpServer()).get('/api/v1/courses').expect(200);
		expect(response.body).toEqual([]); expect(classes.seen).toHaveLength(0);
	});
	it.each([400, 401, 403, 404, 409, 503])('preserves Courses refusal %s without consulting Classes', async status => {
		const failure = { error_code: `CO-${status}`, error_description: 'Domain refusal', error_source: 'CoursesAPI', error_stack: [] };
		courseReply = { status, body: JSON.stringify(failure) };
		const response = await request(app.getHttpServer()).get(`/api/v1/courses/${id}`).expect(status);
		expect(response.body).toEqual(failure); expect(classes.seen).toHaveLength(0);
	});
	it.each([{ status: 503 }, { status: 401 }, { body: '{bad-json' }, { body: '{}' }, { body: '[{"id":"partial"}]' }])('returns CO-503 without partial resource when Classes fails %j', async failure => {
		classesReply = failure;
		const response = await request(app.getHttpServer()).get('/api/v1/courses').expect(503);
		expect(Object.keys(response.body).sort()).toEqual(['error_code', 'error_description', 'error_source', 'error_stack']);
		expect(response.body.error_code).toBe('CO-503'); expect(response.body).not.toHaveProperty('classes');
	});
	it.each(['{}', '[]', '{broken'])('forwards exact raw body %s to domain validation', async body => {
		courseReply = { status: 400, body: '{"domainValidation":true}' };
		await request(app.getHttpServer()).patch(`/api/v1/courses/${id}`).set('Content-Type', 'application/json').send(body).expect(400);
		expect(courses.seen[0].body).toBe(body);
	});
	it('forwards only the cookie access token to both downstreams', async () => {
		await request(app.getHttpServer()).get('/api/v1/courses').set('Cookie', 'closed_cras_session=' + encodeURIComponent('{"access_token":"cookie-access","refresh_token":"keep-private"}')).expect(200);
		for (const seen of [courses.seen[0], classes.seen[0]]) {
			expect(seen.headers.authorization).toBe('Bearer cookie-access');
			expect(seen.headers.cookie).toBeUndefined();
			expect(JSON.stringify(seen)).not.toContain('keep-private');
		}
	});
	it('keeps percent-encoded delimiters within the identifier', async () => {
		courseReply = { status: 400, body: '{}' };
		await request(app.getHttpServer()).get('/api/v1/courses/a%2Fb%3Fx%3D1').expect(400);
		expect(courses.seen[0].url).toBe('/api/v1/courses/a%2Fb%3Fx%3D1');
	});
	it('keeps Classes circuit failures independent of Courses writes', async () => {
		classesReply = { status: 503 };
		await request(app.getHttpServer()).get('/api/v1/courses').expect(503);
		await request(app.getHttpServer()).get('/api/v1/courses').expect(503);
		await request(app.getHttpServer()).get('/api/v1/courses').expect(503);
		expect(classes.seen).toHaveLength(2);
		courseReply = { status: 201, body: JSON.stringify(course) };
		await request(app.getHttpServer()).post('/api/v1/courses').send({ code: 'NEW' }).expect(201);
		expect(courses.seen).toHaveLength(4);
	});
});
