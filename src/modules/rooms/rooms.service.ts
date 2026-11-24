import { Inject, Injectable } from '@nestjs/common';
import { currentSemester } from '../../common/academic/current-semester';
import {
	DownstreamResponse,
	DownstreamService,
	DownstreamUnavailableError,
} from '../../common/http/downstream.service';
import { validClass, validRoom } from './composition-contract';

export const ROOMS_DOWNSTREAM = 'ROOMS_DOWNSTREAM';
export const ROOMS_CLASSES_DOWNSTREAM = 'ROOMS_CLASSES_DOWNSTREAM';
export const ROOMS_CLOCK = 'ROOMS_CLOCK';

export type RoomsCompose = 'collection' | 'item';

export interface RoomsForwardRequest {
	method: string;
	suffix: string;
	query: string;
	body?: Buffer | string;
	contentType?: string;
	bearerToken?: string;
	signal?: AbortSignal;
	roomId?: string;
}

export interface RoomsForwardResponse {
	status: number;
	body: string;
	contentType?: string;
	headers: Record<string, string>;
}

type JsonResource = Record<string, unknown>;
const isObject = (val: unknown): val is JsonResource =>
	val !== null && typeof val === 'object' && !Array.isArray(val);

function compositionUnavailable(detail = 'Não foi possível obter as turmas do semestre em curso.'): RoomsForwardResponse {
	return {
		status: 503,
		contentType: 'application/problem+json',
		headers: { 'cache-control': 'no-store' },
		body: JSON.stringify({
			type: 'urn:closed-cras:bff:dependency',
			title: 'Serviço de composição indisponível',
			status: 503,
			detail,
			code: 'BFF-DEPENDENCY',
		}),
	};
}

function downstreamUnavailable(): RoomsForwardResponse {
	return {
		status: 503,
		contentType: 'application/problem+json',
		headers: { 'cache-control': 'no-store' },
		body: JSON.stringify({
			type: 'urn:closed-cras:bff:dependency',
			title: 'Dependência indisponível',
			status: 503,
			detail: 'O contexto rooms não respondeu. Tente novamente em instantes.',
			code: 'BFF-DEPENDENCY',
		}),
	};
}

@Injectable()
export class RoomsService {
	constructor(
		@Inject(ROOMS_DOWNSTREAM) private readonly rooms: DownstreamService,
		@Inject(ROOMS_CLASSES_DOWNSTREAM) private readonly classes: DownstreamService,
		@Inject(ROOMS_CLOCK) private readonly clock: () => Date,
	) {}

	async forward(request: RoomsForwardRequest, compose?: RoomsCompose): Promise<RoomsForwardResponse> {
		const requestBody =
			typeof request.body === 'string'
				? request.body
				: Buffer.isBuffer(request.body)
					? request.body.toString('utf8')
					: undefined;

		try {
			const response = await this.rooms.send({
				method: request.method,
				path: `/api/v1/rooms${request.suffix}${request.query}`,
				body: requestBody,
				contentType: request.contentType,
				bearerToken: request.bearerToken,
				signal: request.signal,
			});

			if (!compose || response.status !== 200) {
				return {
					status: response.status,
					body: response.body,
					contentType: response.contentType ?? undefined,
					headers: response.headers ?? {},
				};
			}

			try {
				return await this.compose(response, request, compose);
			} catch {
				return compositionUnavailable();
			}
		} catch (error) {
			if (error instanceof DownstreamUnavailableError) {
				return compose ? compositionUnavailable() : downstreamUnavailable();
			}
			throw error;
		}
	}

	private async compose(
		response: DownstreamResponse,
		request: RoomsForwardRequest,
		mode: RoomsCompose,
	): Promise<RoomsForwardResponse> {
		const payload: unknown = JSON.parse(response.body);

		if (mode === 'item' && !isObject(payload)) {
			throw new Error('Invalid Rooms item payload: expected object');
		}
		if (mode === 'collection' && !Array.isArray(payload)) {
			throw new Error('Invalid Rooms collection payload: expected array');
		}

		const roomsList: JsonResource[] =
			mode === 'collection' ? (payload as JsonResource[]) : [payload as JsonResource];

		if (!roomsList.every((r) => isObject(r) && validRoom(r))) {
			throw new Error('Invalid Room payload');
		}

		const headers: Record<string, string> = { ...response.headers, 'cache-control': 'no-store' };
		delete headers.etag;
		delete headers['last-modified'];

		if (mode === 'collection' && roomsList.length === 0) {
			return {
				status: 200,
				contentType: 'application/json',
				headers,
				body: JSON.stringify([]),
			};
		}

		const { year, semester } = currentSemester(this.clock());
		const grouped = new Map<string, JsonResource[]>();

		const query = new URLSearchParams({ year: String(year), semester: String(semester) });
		if (mode === 'item') {
			const roomId = request.roomId ?? String((roomsList[0] as JsonResource).id);
			query.set('roomId', roomId);
		}

		const result = await this.classes.send({
			method: 'GET',
			path: `/api/v1/classes?${query.toString()}`,
			bearerToken: request.bearerToken,
			signal: request.signal,
		});

		if (result.status !== 200) {
			throw new Error('Classes downstream returned status ' + result.status);
		}

		const classesPayload: unknown = JSON.parse(result.body);
		if (!Array.isArray(classesPayload)) {
			throw new Error('Invalid Classes payload: expected array');
		}

		for (const item of classesPayload) {
			if (!isObject(item) || !validClass(item)) {
				throw new Error('Invalid Class in payload');
			}
			if (!item.enabled || item.year !== year || item.semester !== semester || !item.roomId) {
				continue;
			}
			const rId = String(item.roomId);
			const linked = grouped.get(rId) ?? [];
			linked.push(item);
			grouped.set(rId, linked);
		}

		const views = (roomsList as JsonResource[]).map((room) => ({
			...room,
			classes: grouped.get(String(room.id)) ?? [],
		}));

		return {
			status: 200,
			contentType: 'application/json',
			headers,
			body: JSON.stringify(mode === 'collection' ? views : views[0]),
		};
	}
}
