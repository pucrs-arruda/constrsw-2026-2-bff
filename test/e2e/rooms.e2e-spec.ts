import { randomUUID } from 'node:crypto';
import { currentSemester, defaultPassword, http, setting, urls, waitForBff } from './support/e2e-env';

jest.setTimeout(120_000);

describe('BFF rooms — fim a fim', () => {
	const path = '/api/v1/rooms';
	const stamp = randomUUID().replace(/-/g, '').slice(0, 14);
	const room = {
		code: `E2E-${stamp}-A`, name: `Sala E2E ${stamp}`, building: `E2E-${stamp}`,
		capacity: 40, active: true, resourceIds: [],
	};
	const secondRoom = { ...room, code: `E2E-${stamp}-B` };
	const feature = { code: 'RAMP', description: 'Rampa de teste', present: true };
	const created = { classes: new Set<string>(), features: new Set<string>(), rooms: new Set<string>() };
	let token: string;
	let studentToken: string;
	let bff: string;
	let classesUrl: string;
	let roomId: string;
	let secondRoomId: string;
	let classId: string;
	let featureId: string;

	const roomPath = () => `${path}/${roomId}`;
	const featuresPath = () => `${roomPath()}/accessibility-features`;
	const featurePath = () => `${featuresPath()}/${featureId}`;
	const api = (method: string, suffix: string, body?: unknown, bearer = token) =>
		http(method, `${bff}${suffix}`, { token: bearer, body });

	async function login(username: string, password: string): Promise<string> {
		const result = await http<{ access_token: string }>('POST', `${urls.context('oauth', '8181')}/login`, {
			body: { username, password },
		});
		// Não incluir o corpo do login em mensagens de erro.
		expect(result.status).toBe(201);
		expect(typeof result.body.access_token === 'string' && result.body.access_token.length > 0).toBe(true);
		return result.body.access_token;
	}

	async function createRoom(body: typeof room) {
		const res = await api('POST', path, body);
		if (res.status === 201 && typeof res.body.id === 'string') created.rooms.add(`${bff}${path}/${res.body.id}`);
		expect(res.status).toBe(201);
		expect(res.body).toMatchObject({ ...body, id: expect.any(String), enabled: true });
		expect(res.body).not.toHaveProperty('classes');
		return res.body.id as string;
	}

	beforeAll(async () => {
		bff = urls.bff();
		classesUrl = urls.context('classes', '8182');
		await waitForBff();
		const password = defaultPassword();
		token = await login('admin@pucrs.br', password);
		studentToken = await login('student@pucrs.br', setting('E2E_STUDENT_PASSWORD', password));
	});

	afterAll(async () => {
		const errors: string[] = [];
		for (const resource of [created.classes, created.features, created.rooms]) {
			for (const url of resource) {
				try {
					const { status } = await http('DELETE', url, { token });
					if (status !== 204 && status !== 404) errors.push(`${url}: HTTP ${status}`);
				} catch (error) {
					errors.push(`${url}: ${String(error)}`);
				}
			}
		}
		if (errors.length) throw new Error(`Falha na limpeza E2E:\n${errors.join('\n')}`);
	});

	it('GET /health responde UP anonimamente', async () => {
		const res = await http('GET', `${bff}/health`);
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ status: 'UP' });
	});

	it('POST /rooms cria salas e prepara uma turma vinculada', async () => {
		roomId = await createRoom(room);
		secondRoomId = await createRoom(secondRoom);
		const { year, semester } = currentSemester();
		const [start, end] = semester === 1 ? ['03-01', '07-15'] : ['08-01', '12-15'];
		const result = await http('POST', `${classesUrl}/api/v1/classes`, {
			token,
			body: {
				code: room.code, label: 'Turma E2E de rooms', roomId,
				courseId: randomUUID(), professorId: randomUUID(), studentIds: [], seats: 30,
				year, semester, startDate: `${year}-${start}`, endDate: `${year}-${end}`,
			},
		});
		if (result.status === 201 && typeof result.body.id === 'string') {
			classId = result.body.id;
			created.classes.add(`${classesUrl}/api/v1/classes/${classId}`);
		}
		expect(result.status).toBe(201);
		expect(result.body).toMatchObject({ id: expect.any(String), roomId });
	});

	it('GET /rooms sem filtro devolve classes em cada sala', async () => {
		const res = await api('GET', path);
		expect(res.status).toBe(200);
		expect(res.body).toEqual(expect.any(Array));
		for (const item of res.body) expect(item.classes).toEqual(expect.any(Array));
	});

	it('GET /rooms com filtro exato devolve a sala com a turma vinculada', async () => {
		const res = await api('GET', `${path}?code=${room.code}`);
		expect(res.status).toBe(200);
		expect(res.body).toEqual([expect.objectContaining({
			id: roomId, classes: [expect.objectContaining({ id: classId, roomId })],
		})]);
	});

	it('GET /rooms com filtro sem resultado devolve RM-404', async () => {
		const res = await api('GET', `${path}?code=E2E-${stamp}-Z`);
		expect(res.status).toBe(404);
		expect(res.body.error_code).toBe('RM-404');
	});

	it('GET /rooms preserva paginação, ordenação e X-Total-Count', async () => {
		for (const [page, code] of [secondRoom.code, room.code].entries()) {
			const query = new URLSearchParams({ building: room.building, page: String(page), size: '1', sort: 'code,desc' });
			// O helper http retorna apenas corpo, status e Content-Type.
			const res = await fetch(`${bff}${path}?${query}`, {
				headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000),
			});
			expect(res.status).toBe(200);
			expect(res.headers.get('x-total-count')).toBe('2');
			expect(await res.json()).toEqual([expect.objectContaining({ code, classes: expect.any(Array) })]);
		}
	});

	it('GET /rooms/{id} inclui a turma vinculada', async () => {
		const res = await api('GET', roomPath());
		expect(res.status).toBe(200);
		expect(res.body.classes).toEqual([expect.objectContaining({ id: classId, roomId })]);
	});

	it('GET /rooms/{id} de sala sem turma no semestre devolve classes vazio', async () => {
		const res = await api('GET', `${path}/${secondRoomId}`);
		expect(res.status).toBe(200);
		expect(res.body.classes).toEqual([]);
	});

	it('PUT /rooms/{id} substitui a sala', async () => {
		const body = { ...room, capacity: 50, name: 'Sala substituída' };
		const res = await api('PUT', roomPath(), body);
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject(body);
		expect(res.body).not.toHaveProperty('classes');
	});

	it('PATCH /rooms/{id} altera a capacidade', async () => {
		const res = await api('PATCH', roomPath(), { capacity: 55 });
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ id: roomId, capacity: 55 });
		expect(res.body).not.toHaveProperty('classes');
	});

	it('POST /rooms/{id}/accessibility-features cria a característica', async () => {
		const res = await api('POST', featuresPath(), feature);
		if (res.status === 201 && typeof res.body.id === 'string') {
			featureId = res.body.id;
			created.features.add(bff + featurePath());
		}
		expect(res.status).toBe(201);
		expect(res.body).toMatchObject({ ...feature, id: expect.any(String) });
	});

	it('GET /rooms/{id}/accessibility-features lista a característica', async () => {
		const res = await api('GET', featuresPath());
		expect(res.status).toBe(200);
		expect(res.body).toEqual([expect.objectContaining({ id: featureId, ...feature })]);
	});

	it('GET /rooms/{id}/accessibility-features/{featureId} lê a característica', async () => {
		const res = await api('GET', featurePath());
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ id: featureId, ...feature });
	});

	it('PUT /rooms/{id}/accessibility-features/{featureId} substitui a característica', async () => {
		const body = { code: 'ELEVATOR', description: null, present: false };
		const res = await api('PUT', featurePath(), body);
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject(body);
	});

	it('PATCH /rooms/{id}/accessibility-features/{featureId} altera a característica', async () => {
		const res = await api('PATCH', featurePath(), { present: true });
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ id: featureId, present: true });
	});

	it('DELETE /rooms/{id}/accessibility-features/{featureId} exclui a característica', async () => {
		const res = await api('DELETE', featurePath());
		expect(res.status).toBe(204);
		expect(res.body).toBeUndefined();
		created.features.delete(bff + featurePath());
		// Exclusão lógica: some dos GET e não aceita PUT, PATCH nem outro DELETE.
		expect((await api('GET', featurePath())).status).toBe(404);
		expect((await api('PUT', featurePath(), { code: 'RAMP', description: null, present: true })).status).toBe(404);
		expect((await api('PATCH', featurePath(), { present: false })).status).toBe(404);
		expect((await api('DELETE', featurePath())).status).toBe(404);
		const list = await api('GET', featuresPath());
		expect(list.status).toBe(200);
		expect(list.body).toEqual([]);
	});

	it('GET /rooms sem token devolve RM-401', async () => {
		const res = await http('GET', `${bff}${path}`);
		expect(res.status).toBe(401);
		expect(res.body.error_code).toBe('RM-401');
	});

	it('student pode ler uma sala e recebe RM-403 ao tentar criar', async () => {
		const read = await api('GET', roomPath(), undefined, studentToken);
		expect(read.status).toBe(200);
		expect(read.body.classes).toEqual(expect.any(Array));
		const write = await api('POST', path, { ...room, code: `E2E-${stamp}-S` }, studentToken);
		if (write.status === 201 && typeof write.body.id === 'string') created.rooms.add(`${bff}${path}/${write.body.id}`);
		expect(write.status).toBe(403);
		expect(write.body.error_code).toBe('RM-403');
	});

	it('DELETE /rooms/{id} exclui a sala e o GET seguinte devolve 404', async () => {
		const res = await api('DELETE', roomPath());
		expect(res.status).toBe(204);
		expect(res.body).toBeUndefined();
		created.rooms.delete(bff + roomPath());
		expect((await api('GET', roomPath())).status).toBe(404);
	});

	it('sala excluída logicamente some das listas e não aceita PUT, PATCH, DELETE nem características', async () => {
		const gone = await api('GET', `${path}?code=${room.code}`);
		expect(gone.status).toBe(404);
		expect(gone.body.error_code).toBe('RM-404');
		const sameBuilding = await api('GET', `${path}?building=${room.building}`);
		expect(sameBuilding.status).toBe(200);
		expect(sameBuilding.body.map((item: { id: string }) => item.id)).toEqual([secondRoomId]);

		expect((await api('PUT', roomPath(), { ...room, name: 'Não deve gravar' })).status).toBe(404);
		expect((await api('PATCH', roomPath(), { capacity: 1 })).status).toBe(404);
		expect((await api('DELETE', roomPath())).status).toBe(404);
		expect((await api('GET', featuresPath())).status).toBe(404);
		expect((await api('POST', featuresPath(), feature)).status).toBe(404);
	});
});
