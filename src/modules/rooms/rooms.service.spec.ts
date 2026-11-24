import { DownstreamService, DownstreamUnavailableError } from '../../common/http/downstream.service';
import { RoomsService } from './rooms.service';

describe('RoomsService (unit)', () => {
	const validRoom = {
		id: '3f6c2b1e-8a4d-4c1f-9e2b-7d5a6c4b3a21',
		code: '32/405',
		name: 'Laboratório de Software',
		building: '32',
		capacity: 40,
		active: true,
		enabled: true,
		resourceIds: [],
	};

	let roomsDownstream: jest.Mocked<DownstreamService>;
	let classesDownstream: jest.Mocked<DownstreamService>;
	let service: RoomsService;

	beforeEach(() => {
		roomsDownstream = {
			send: jest.fn(),
		} as unknown as jest.Mocked<DownstreamService>;

		classesDownstream = {
			send: jest.fn(),
		} as unknown as jest.Mocked<DownstreamService>;

		service = new RoomsService(
			roomsDownstream,
			classesDownstream,
			() => new Date('2026-11-24T12:00:00Z'),
		);
	});

	it('proxy puro repassa requisição e resposta sem chamar classes', async () => {
		roomsDownstream.send.mockResolvedValueOnce({
			status: 201,
			body: JSON.stringify(validRoom),
			contentType: 'application/json',
			headers: { location: `/api/v1/rooms/${validRoom.id}` },
		});

		const res = await service.forward({
			method: 'POST',
			suffix: '',
			query: '',
			body: JSON.stringify({ code: '32/405', name: 'Lab', building: '32' }),
			contentType: 'application/json',
		});

		expect(res.status).toBe(201);
		expect(classesDownstream.send).not.toHaveBeenCalled();
		expect(res.headers.location).toBe(`/api/v1/rooms/${validRoom.id}`);
	});

	it('composição de coleção vazia não chama classes e retorna 200 []', async () => {
		roomsDownstream.send.mockResolvedValueOnce({
			status: 200,
			body: '[]',
			contentType: 'application/json',
			headers: { 'x-total-count': '0' },
		});

		const res = await service.forward(
			{
				method: 'GET',
				suffix: '',
				query: '',
			},
			'collection',
		);

		expect(res.status).toBe(200);
		expect(JSON.parse(res.body)).toEqual([]);
		expect(classesDownstream.send).not.toHaveBeenCalled();
		expect(res.headers['cache-control']).toBe('no-store');
	});

	it('composição de coleção com salas busca turmas e agrupa por roomId', async () => {
		roomsDownstream.send.mockResolvedValueOnce({
			status: 200,
			body: JSON.stringify([validRoom]),
			contentType: 'application/json',
			headers: { 'x-total-count': '1' },
		});

		classesDownstream.send.mockResolvedValueOnce({
			status: 200,
			body: JSON.stringify([
				{
					id: 'class-1',
					roomId: validRoom.id,
					year: 2026,
					semester: 2,
					enabled: true,
					code: 'T-101',
				},
				{
					id: 'class-other-room',
					roomId: 'other-room-id',
					year: 2026,
					semester: 2,
					enabled: true,
				},
				{
					id: 'class-disabled',
					roomId: validRoom.id,
					year: 2026,
					semester: 2,
					enabled: false,
				},
			]),
			contentType: 'application/json',
		});

		const res = await service.forward(
			{
				method: 'GET',
				suffix: '',
				query: '?building=32',
			},
			'collection',
		);

		expect(res.status).toBe(200);
		const data = JSON.parse(res.body);
		expect(data).toHaveLength(1);
		expect(data[0].id).toBe(validRoom.id);
		expect(data[0].classes).toHaveLength(1);
		expect(data[0].classes[0].id).toBe('class-1');
		expect(res.headers['cache-control']).toBe('no-store');
	});

	it('composição de item com sala busca turmas com roomId na query', async () => {
		roomsDownstream.send.mockResolvedValueOnce({
			status: 200,
			body: JSON.stringify(validRoom),
			contentType: 'application/json',
		});

		classesDownstream.send.mockResolvedValueOnce({
			status: 200,
			body: JSON.stringify([
				{
					id: 'class-1',
					roomId: validRoom.id,
					year: 2026,
					semester: 2,
					enabled: true,
				},
			]),
			contentType: 'application/json',
		});

		const res = await service.forward(
			{
				method: 'GET',
				suffix: `/${validRoom.id}`,
				query: '',
				roomId: validRoom.id,
			},
			'item',
		);

		expect(res.status).toBe(200);
		expect(classesDownstream.send).toHaveBeenCalledWith(
			expect.objectContaining({
				path: `/api/v1/classes?year=2026&semester=2&roomId=${validRoom.id}`,
			}),
		);
		const data = JSON.parse(res.body);
		expect(data.id).toBe(validRoom.id);
		expect(data.classes).toHaveLength(1);
	});

	it('falha no classes retorna 503 BFF-DEPENDENCY', async () => {
		roomsDownstream.send.mockResolvedValueOnce({
			status: 200,
			body: JSON.stringify([validRoom]),
			contentType: 'application/json',
		});

		classesDownstream.send.mockRejectedValueOnce(
			new DownstreamUnavailableError('classes', 'timeout'),
		);

		const res = await service.forward(
			{
				method: 'GET',
				suffix: '',
				query: '',
			},
			'collection',
		);

		expect(res.status).toBe(503);
		expect(res.contentType).toBe('application/problem+json');
		const body = JSON.parse(res.body);
		expect(body.code).toBe('BFF-DEPENDENCY');
		expect(body.title).toBe('Serviço de composição indisponível');
	});

	it('resposta não 200 do rooms (ex. 404) sobe intacta sem chamar classes', async () => {
		roomsDownstream.send.mockResolvedValueOnce({
			status: 404,
			body: JSON.stringify({ error_code: 'RM-404', error_description: 'Sala não encontrada' }),
			contentType: 'application/problem+json',
			headers: {},
		});

		const res = await service.forward(
			{
				method: 'GET',
				suffix: `/${validRoom.id}`,
				query: '',
				roomId: validRoom.id,
			},
			'item',
		);

		expect(res.status).toBe(404);
		expect(classesDownstream.send).not.toHaveBeenCalled();
		expect(JSON.parse(res.body).error_code).toBe('RM-404');
	});
});
