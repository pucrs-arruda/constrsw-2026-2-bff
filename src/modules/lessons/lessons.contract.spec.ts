import { INestApplication } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { configureApp } from '../../bootstrap';
import { HttpMetrics } from '../../common/health/http-metrics';
import { DownstreamRequest, DownstreamResponse, DownstreamUnavailableError } from '../../common/http/downstream.service';
import { LessonsModule, lessonsDownstream } from './lessons.module';
import { LESSONS_DOWNSTREAM } from './lessons.service';

const PREFIX = '/api/v1/lessons';
const LESSON = '11111111-1111-4111-8111-111111111111';
const TOPIC = '22222222-2222-4222-8222-222222222222';
const OPERATIONS: [string, string][] = [
	['GET', ''], ['POST', ''], ['POST', '/generate'],
	['GET', `/${LESSON}`], ['PUT', `/${LESSON}`], ['PATCH', `/${LESSON}`], ['DELETE', `/${LESSON}`],
	['GET', `/${LESSON}/topics`], ['POST', `/${LESSON}/topics`],
	['GET', `/${LESSON}/topics/${TOPIC}`], ['PUT', `/${LESSON}/topics/${TOPIC}`],
	['PATCH', `/${LESSON}/topics/${TOPIC}`], ['DELETE', `/${LESSON}/topics/${TOPIC}`],
];

describe('Lessons — proxy HTTP', () => {
	let app: INestApplication;
	let sent: DownstreamRequest[];
	let reply: DownstreamResponse | Error;

	beforeEach(async () => {
		sent = [];
		reply = { status: 200, contentType: 'application/json', body: '[]' };
		const module = await Test.createTestingModule({
			imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), LessonsModule],
			providers: [HttpMetrics],
		}).overrideProvider(LESSONS_DOWNSTREAM).useValue({
			send: async (call: DownstreamRequest) => {
				sent.push(call);
				if (reply instanceof Error) throw reply;
				return reply;
			},
		}).compile();
		app = module.createNestApplication({ bodyParser: false });
		configureApp(app);
		await app.init();
	});

	afterEach(async () => { await app.close(); });

	it.each(OPERATIONS)('%s %s chega ao domínio com o mesmo método e path', async (method, suffix) => {
		await request(app.getHttpServer())[method.toLowerCase() as 'get'](PREFIX + suffix)
			.set('Authorization', 'Bearer user-token').expect(200);
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ method, path: PREFIX + suffix, bearerToken: 'user-token' });
	});

	it('preserva filtros e corpo bruto, inclusive JSON inválido para validação no domínio', async () => {
		const query = '?date=%7Bgteq%7D2026-11-01&statement=%7Blike%7D%25a%25';
		await request(app.getHttpServer()).get(PREFIX + query).expect(200);
		expect(sent[0].path).toBe(PREFIX + query);
		const body = '{"classId":';
		await request(app.getHttpServer()).post(PREFIX).set('Content-Type', 'application/json').send(body).expect(200);
		expect(sent[1].body).toBe(body);
	});

	it('preserva merge-patch, sem alterar effectiveRoomId nem tópicos', async () => {
		const body = '{ "hasAssessment": true }';
		reply = { status: 200, contentType: 'application/json', body: '{"effectiveRoomId":"room","topics":[]}' };
		const result = await request(app.getHttpServer()).patch(`${PREFIX}/${LESSON}`)
			.set('Content-Type', 'application/merge-patch+json').send(body).expect(200);
		expect(sent[0]).toMatchObject({ body, contentType: 'application/merge-patch+json' });
		expect(result.text).toBe(reply.body);
	});

	it('encaminha cookie OAuth; Bearer explícito malformado não usa o cookie', async () => {
		const cookie = `${process.env.SESSION_COOKIE_NAME ?? 'closed_cras_session'}=${encodeURIComponent(JSON.stringify({ access_token: 'cookie-token' }))}`;
		await request(app.getHttpServer()).get(PREFIX).set('Cookie', cookie).expect(200);
		expect(sent[0].bearerToken).toBe('cookie-token');
		await request(app.getHttpServer()).get(PREFIX).set('Cookie', cookie).set('Authorization', 'Basic invalid').expect(200);
		expect(sent[1].bearerToken).toBeUndefined();
	});

	it('repassa Location, contagem e metadados da resposta', async () => {
		reply = { status: 201, contentType: 'application/json', body: '{"id":"new"}',
			headers: { location: `${PREFIX}/new`, 'x-total-count': '1', etag: '"v1"', 'retry-after': '5' } };
		const result = await request(app.getHttpServer()).post(PREFIX).send({ classId: LESSON }).expect(201);
		expect(result.text).toBe(reply.body);
		expect(result.headers).toMatchObject({ location: `${PREFIX}/new`, 'x-total-count': '1', etag: '"v1"', 'retry-after': '5' });
	});

	it.each([400, 401, 403, 404, 409, 503])('preserva recusa HTTP %s do domínio', async status => {
		const body = JSON.stringify({ error_code: `LE-${status}`, error_description: 'Recusa do domínio', error_source: 'lessons', error_stack: [] });
		reply = { status, body, contentType: 'application/json', headers: { 'www-authenticate': 'Bearer' } };
		const result = await request(app.getHttpServer()).post(`${PREFIX}/generate`).send({ classId: LESSON }).expect(status);
		expect(result.text).toBe(body);
		expect(result.headers['www-authenticate']).toBe('Bearer');
	});

	it('DELETE 204 não ganha corpo', async () => {
		reply = { status: 204, contentType: null, body: '' };
		const result = await request(app.getHttpServer()).delete(`${PREFIX}/${LESSON}`).expect(204);
		expect(result.text).toBe('');
	});

	it('rede, timeout ou circuito aberto viram LE-503 sem detalhes internos', async () => {
		reply = new DownstreamUnavailableError('lessons', 'secret-internal-host');
		const result = await request(app.getHttpServer()).get(PREFIX).expect(503);
		expect(result.body).toMatchObject({ error_code: 'LE-503', error_source: 'BFF', error_stack: [] });
		expect(result.text).not.toContain('secret-internal-host');
	});

	it('bloqueia dot segments codificados antes de chamar o domínio', async () => {
		await request(app.getHttpServer()).get(`${PREFIX}/%2e%2e/topics/${TOPIC}`).expect(404);
		expect(sent).toHaveLength(0);
	});

	it('uma escrita via cookie de outra origem é recusada', async () => {
		const cookie = `${process.env.SESSION_COOKIE_NAME ?? 'closed_cras_session'}=${encodeURIComponent(JSON.stringify({ access_token: 'cookie-token' }))}`;
		await request(app.getHttpServer()).post(PREFIX).set('Cookie', cookie)
			.set('Origin', 'https://other.invalid').send({}).expect(403);
		expect(sent).toHaveLength(0);
	});
});

describe('Lessons — configuração', () => {
	it.each(['ftp://lessons', 'http://user:password@lessons', 'http://lessons/api/v1'])('recusa origem inválida: %s', url => {
		expect(() => lessonsDownstream(new ConfigService({ LESSONS_BASE_URL: url }))).toThrow();
	});
	it('recusa timeout inválido', () => {
		expect(() => lessonsDownstream(new ConfigService({ BFF_HTTP_TIMEOUT_MS: -1 }))).toThrow();
	});
});
