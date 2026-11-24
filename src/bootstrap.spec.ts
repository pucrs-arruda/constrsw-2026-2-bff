import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';

describe('production application configuration', () => {
	let app: INestApplication;
	beforeEach(async () => {
		const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
		app = module.createNestApplication({ bodyParser: false, logger: false });
		configureApp(app);
		await app.init();
	});
	afterEach(async () => { await app.close(); });
	it('boots and serves anonymous health', async () => {
		const response = await request(app.getHttpServer()).get('/health').expect(200);
		expect(response.body).toEqual({ status: 'UP' });
	});
	it('publishes request metrics without raw URLs or credentials', async () => {
		await request(app.getHttpServer()).get('/health?token=secret-query').set('Authorization', 'Bearer secret-token').expect(200);
		const response = await request(app.getHttpServer()).get('/metrics').expect(200);
		expect(response.text).toContain('bff_http_requests_total{method="GET",route="/health",status="200"} 1');
		expect(response.text).not.toContain('secret-');
	});
	it('exposes pagination headers to the credentialed browser origin', async () => {
		const response = await request(app.getHttpServer()).get('/health').set('Origin', 'http://localhost:4200').expect(200);
		expect(response.headers['access-control-allow-origin']).toBe('http://localhost:4200');
		expect(response.headers['access-control-allow-credentials']).toBe('true');
		expect(response.headers['access-control-expose-headers']).toContain('X-Total-Count');
	});
	it('rejects unsafe cookie requests from an untrusted Origin', async () => {
		await request(app.getHttpServer()).post('/api/v1/courses').set('Origin', 'https://untrusted.invalid')
			.set('Cookie', 'closed_cras_session=' + encodeURIComponent('{"access_token":"session-token"}')).send({}).expect(403);
	});
});
