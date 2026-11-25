import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { DownstreamService, DownstreamUnavailableError } from '../../common/http/downstream.service';
import { EmployeesController } from './employees.controller';
import { EMPLOYEES_DOWNSTREAM, EmployeesService } from './employees.service';

/**
 * Contrato na fronteira BFF↔employees (AD-11): proxy sem reinterpretar; 503 estável.
 */
describe('Proxy de employees (fronteira BFF↔domínio)', () => {
	let app: INestApplication;
	let sent: Array<Record<string, unknown>>;
	let nextResponse: unknown;

	beforeEach(async () => {
		sent = [];
		nextResponse = { status: 200, body: '[]', contentType: 'application/json' };

		const downstream = {
			send: jest.fn(async (req: Record<string, unknown>) => {
				sent.push(req);
				if (nextResponse instanceof Error) {
					throw nextResponse;
				}
				return nextResponse;
			}),
		} as unknown as DownstreamService;

		const moduleRef = await Test.createTestingModule({
			controllers: [EmployeesController],
			providers: [EmployeesService, { provide: EMPLOYEES_DOWNSTREAM, useValue: downstream }],
		}).compile();

		app = moduleRef.createNestApplication();
		await app.init();
	});

	afterEach(async () => {
		await app.close();
	});

	it('mapeia /api/v1/employees para /api/v1/employees no contexto (sem double prefix)', async () => {
		await request(app.getHttpServer()).get('/api/v1/employees').expect(200);

		expect(sent[0].path).toBe('/api/v1/employees');
		expect(sent[0].method).toBe('GET');
	});

	it('preserva a query string', async () => {
		await request(app.getHttpServer())
			.get('/api/v1/employees?status=Active&sort=name')
			.expect(200);

		expect(sent[0].path).toBe('/api/v1/employees?status=Active&sort=name');
	});

	it('alcança as quatro rotas do contrato, inclusive dependents aninhados', async () => {
		const server = app.getHttpServer();
		await request(server).get('/api/v1/employees/abc').expect(200);
		await request(server).get('/api/v1/employees/abc/dependents').expect(200);
		await request(server).get('/api/v1/employees/abc/dependents/def').expect(200);

		expect(sent.map((call) => call.path)).toEqual([
			'/api/v1/employees/abc',
			'/api/v1/employees/abc/dependents',
			'/api/v1/employees/abc/dependents/def',
		]);
	});

	it('propaga o token do usuário como Bearer (AD-4)', async () => {
		await request(app.getHttpServer())
			.get('/api/v1/employees')
			.set('authorization', 'Bearer token-do-usuario')
			.expect(200);

		expect(sent[0].bearerToken).toBe('token-do-usuario');
	});

	it('repassa a recusa do domínio sem reinterpretar (AD-6)', async () => {
		const problem = JSON.stringify({
			status: 409,
			code: 'conflict',
			title: 'E-mail já usado',
		});
		nextResponse = {
			status: 409,
			body: problem,
			contentType: 'application/problem+json',
		};

		const response = await request(app.getHttpServer())
			.post('/api/v1/employees')
			.send({ email: 'helena@pucrs.br' })
			.expect(409);

		expect(response.headers['content-type']).toContain('application/problem+json');
		expect(JSON.parse(response.text).code).toBe('conflict');
	});

	it('encaminha o corpo das escritas e Location no 201', async () => {
		nextResponse = {
			status: 201,
			body: '{"id":"1"}',
			contentType: 'application/json',
			headers: { location: '/api/v1/employees/1' },
			location: '/api/v1/employees/1',
		};

		const response = await request(app.getHttpServer())
			.post('/api/v1/employees')
			.send({
				registrationNumber: '100',
				name: 'Helena Costa',
				salary: 8500.5,
				hireDate: '2020-01-15',
				position: 'Analista',
				status: 'Active',
			})
			.expect(201);

		expect(JSON.parse(sent[0].body as string).name).toBe('Helena Costa');
		expect(response.headers.location).toBe('/api/v1/employees/1');
	});

	it('devolve 204 sem corpo', async () => {
		nextResponse = { status: 204, body: '', contentType: null };

		const response = await request(app.getHttpServer())
			.delete('/api/v1/employees/abc/dependents/def')
			.expect(204);

		expect(response.text).toBe('');
	});

	it('encaminha sem Bearer quando o cliente não envia token', async () => {
		nextResponse = {
			status: 401,
			body: JSON.stringify({ status: 401, code: 'unauthorized' }),
			contentType: 'application/problem+json',
		};

		await request(app.getHttpServer()).get('/api/v1/employees').expect(401);

		expect(sent[0].bearerToken).toBeUndefined();
	});

	it('traduz dependência fora do ar em 503 problem+json estável (AD-10)', async () => {
		nextResponse = new DownstreamUnavailableError('employees', 'circuito aberto');

		const response = await request(app.getHttpServer()).get('/api/v1/employees').expect(503);

		expect(response.headers['content-type']).toContain('application/problem+json');
		const body = JSON.parse(response.text);
		expect(body.status).toBe(503);
		expect(body.code).toBe('BFF-DOWNSTREAM-UNAVAILABLE');
	});
});
