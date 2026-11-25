import { Inject, Injectable } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

import {
	DownstreamRequest,
	DownstreamResponse,
	DownstreamService,
	DownstreamUnavailableError,
} from '../../common/http/downstream.service';

export const RESOURCES_DOWNSTREAM = Symbol('RESOURCES_DOWNSTREAM');
export const RESERVATIONS_DOWNSTREAM = Symbol('RESERVATIONS_DOWNSTREAM');
export const RESOURCES_CLOCK = Symbol('RESOURCES_CLOCK');

/** O browser e o domínio compartilham o prefixo `/api/v1/resources`. */
const DOMAIN_PREFIX = '/api/v1/resources';
const RESERVATIONS_PATH = '/api/v1/reservations';
const JSON_CONTENT_TYPE = 'application/json';
const PROBLEM_CONTENT_TYPE = 'application/problem+json';

// Only reads that the BFF composes are validated against the domain snapshot. Writes and
// refusals remain proxy passthrough; the resources context owns their validation.
const validator = new Ajv({ strict: false, allErrors: false });
addFormats(validator);
const domain = JSON.parse(readFileSync(join(__dirname, '../../../openapi/domains', 'resources.openapi.json'), 'utf8'));
validator.addSchema(domain, 'https://bff.invalid/domains/resources.openapi.json');
const validResource = validator.compile({ $ref: 'https://bff.invalid/domains/resources.openapi.json#/components/schemas/Resource' });
const validAggregate = validator.compile({ $ref: 'https://bff.invalid/domains/resources.openapi.json#/components/schemas/ResourceAggregate' });
const validOccurrence = validator.compile({ $ref: 'https://bff.invalid/domains/resources.openapi.json#/components/schemas/Occurrence' });

type Json = Record<string, unknown>;
type Clock = () => Date;

export interface ForwardRequest extends Omit<DownstreamRequest, 'path'> {
	/** Trecho depois de `/api/v1/resources`, já com a query string. */
	readonly suffix: string;
}

/**
 * Proxy do contexto `resources` mais os read-models `openOccurrenceCount` e `reservations` (UX-S3).
 *
 * O BFF não persiste recurso nem ocorrência e não aplica regra de ocorrência: repassa a chamada
 * com o Bearer do usuário e devolve a recusa do domínio intacta. Só a indisponibilidade de
 * transporte/circuito vira 503 `RESOURCES_UPSTREAM_UNAVAILABLE`. `enabled` é flag de exclusão
 * lógica do domínio e não é exposta ao browser; coleções sobem como array puro.
 *
 * `reservations` é composição somente leitura do contexto reservations: reservas futuras cujo
 * `resourceIds` contém o recurso. A falha dessa composição também vira 503, sem resposta parcial.
 */
@Injectable()
export class ResourcesService {
	constructor(
		@Inject(RESOURCES_DOWNSTREAM) private readonly downstream: DownstreamService,
		@Inject(RESERVATIONS_DOWNSTREAM) private readonly reservations: DownstreamService,
		@Inject(RESOURCES_CLOCK) private readonly clock: Clock,
	) {}

	async list(query: string, bearerToken: string | undefined, instance: string, signal?: AbortSignal): Promise<DownstreamResponse> {
		const response = await this.send({ method: 'GET', suffix: query, bearerToken, signal }, instance);
		if (response.status !== 200) return response;

		const payload = parse(response.body);
		if (!Array.isArray(payload) || !payload.every(resource => validResource(resource))) return unavailable(instance);

		const reservations = await this.futureReservations(undefined, bearerToken, signal);
		if (reservations === null) return unavailable(instance);

		const items: Json[] = [];
		for (const resource of payload as Json[]) {
			const id = resource.id;
			if (typeof id !== 'string') return unavailable(instance);
			const detail = await this.send({ method: 'GET', suffix: `/${encodeURIComponent(id)}`, bearerToken, signal }, instance);
			if (detail.status !== 200) return unavailable(instance);
			const aggregate = parse(detail.body);
			if (!validAggregate(aggregate)) return unavailable(instance);
			items.push(summaryOf(aggregate as Json, openCount(aggregate as Json), reservations.filter(item => belongsTo(item, id))));
		}
		return composed(200, items, response.headers);
	}

	async get(resourceId: string, bearerToken: string | undefined, instance: string, signal?: AbortSignal): Promise<DownstreamResponse> {
		const response = await this.send({ method: 'GET', suffix: `/${encodeURIComponent(resourceId)}`, bearerToken, signal }, instance);
		if (response.status !== 200) return response;

		const aggregate = parse(response.body);
		if (!validAggregate(aggregate)) return unavailable(instance);

		const reservations = await this.futureReservations(resourceId, bearerToken, signal);
		if (reservations === null) return unavailable(instance);
		return composed(200, resourceOf(aggregate as Json, reservations), response.headers);
	}

	async create(body: string | undefined, contentType: string | undefined, bearerToken: string | undefined, instance: string, signal?: AbortSignal): Promise<DownstreamResponse> {
		const response = await this.send({ method: 'POST', suffix: '', body, contentType, bearerToken, signal }, instance);
		if (response.status !== 201) return response;

		const resource = parse(response.body);
		if (!validResource(resource)) return unavailable(instance);
		const view = summaryOf(resource as Json, 0, []);
		view.occurrences = [];
		return composed(201, view, response.headers, locationOf(response, `/api/v1/resources/${String((resource as Json).id)}`));
	}

	async update(resourceId: string, body: string | undefined, contentType: string | undefined, bearerToken: string | undefined, instance: string, signal?: AbortSignal): Promise<DownstreamResponse> {
		const response = await this.send({ method: 'PATCH', suffix: `/${encodeURIComponent(resourceId)}`, body, contentType, bearerToken, signal }, instance);
		if (response.status !== 200) return response;

		const aggregate = parse(response.body);
		if (!validAggregate(aggregate)) return unavailable(instance);

		const reservations = await this.futureReservations(resourceId, bearerToken, signal);
		if (reservations === null) return unavailable(instance);
		return composed(200, resourceOf(aggregate as Json, reservations), response.headers);
	}

	async createOccurrence(resourceId: string, body: string | undefined, contentType: string | undefined, bearerToken: string | undefined, instance: string, signal?: AbortSignal): Promise<DownstreamResponse> {
		const response = await this.send({ method: 'POST', suffix: `/${encodeURIComponent(resourceId)}/occurrences`, body, contentType, bearerToken, signal }, instance);
		if (response.status !== 201) return response;

		const occurrence = parse(response.body);
		if (!validOccurrence(occurrence)) return unavailable(instance);
		const fallback = `/api/v1/resources/${encodeURIComponent(resourceId)}/occurrences/${String((occurrence as Json).id)}`;
		return composed(201, occurrenceOf(occurrence as Json), response.headers, locationOf(response, fallback));
	}

	async resolveOccurrence(resourceId: string, occurrenceId: string, body: string | undefined, contentType: string | undefined, bearerToken: string | undefined, instance: string, signal?: AbortSignal): Promise<DownstreamResponse> {
		const suffix = `/${encodeURIComponent(resourceId)}/occurrences/${encodeURIComponent(occurrenceId)}`;
		const response = await this.send({ method: 'PATCH', suffix, body, contentType, bearerToken, signal }, instance);
		if (response.status !== 200) return response;

		const occurrence = parse(response.body);
		if (!validOccurrence(occurrence)) return unavailable(instance);
		return composed(200, occurrenceOf(occurrence as Json), response.headers);
	}

	/**
	 * Reservations futuras do recurso. `null` significa que a composição falhou ou veio fora do
	 * contrato; o chamador responde 503 sem payload parcial.
	 */
	private async futureReservations(resourceId: string | undefined, bearerToken: string | undefined, signal?: AbortSignal): Promise<Json[] | null> {
		const query = resourceId === undefined ? '' : `?resourceId=${encodeURIComponent(resourceId)}`;
		let response: DownstreamResponse;
		try {
			response = await this.reservations.send({
				method: 'GET',
				path: `${RESERVATIONS_PATH}${query}`,
				bearerToken,
				signal,
			});
		}
		catch (error) {
			if (error instanceof DownstreamUnavailableError) return null;
			throw error;
		}
		if (response.status !== 200) return null;

		const payload = parse(response.body);
		if (!Array.isArray(payload) || !payload.every(item => validReservation(item))) return null;

		const now = nowInSaoPaulo(this.clock());
		return (payload as Json[]).filter(item => {
			if (resourceId !== undefined && !belongsTo(item, resourceId)) return false;
			return isFuture(item, now);
		});
	}

	private async send(request: ForwardRequest, instance: string): Promise<DownstreamResponse> {
		try {
			return await this.downstream.send({
				method: request.method,
				path: `${DOMAIN_PREFIX}${request.suffix}`,
				body: request.body,
				contentType: request.contentType,
				bearerToken: request.bearerToken,
				signal: request.signal,
			});
		}
		catch (error) {
			if (error instanceof DownstreamUnavailableError) return unavailable(instance);
			throw error;
		}
	}
}

/** Envelope estável do AD-10 para o resources indisponível. */
export function unavailable(instance: string): DownstreamResponse {
	return {
		status: 503,
		contentType: PROBLEM_CONTENT_TYPE,
		body: JSON.stringify({
			type: 'urn:closed-cras:dependency:unavailable',
			title: 'Resources context unavailable',
			status: 503,
			detail: 'The resources context did not respond.',
			instance,
			code: 'DEPENDENCY_UNAVAILABLE',
			reason: 'RESOURCES_UPSTREAM_UNAVAILABLE',
		}),
	};
}

function composed(status: number, body: unknown, headers?: Readonly<Record<string, string>>, location?: string): DownstreamResponse {
	// Domain validators/cache metadata describe the uncomposed representation, and the count must
	// not be cached: the next read after a resolve has to observe the lower value.
	const forwarded: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers ?? {})) {
		if (name === 'etag' || name === 'last-modified') continue;
		forwarded[name] = value;
	}
	forwarded['cache-control'] = 'no-store';
	if (location !== undefined) forwarded.location = location;
	return { status, body: JSON.stringify(body), contentType: JSON_CONTENT_TYPE, headers: forwarded, location: location ?? null };
}

function summaryOf(resource: Json, openOccurrenceCount: number, reservations: Json[]): Json {
	return {
		id: resource.id,
		code: resource.code,
		name: resource.name,
		type: resource.type,
		active: resource.active,
		tags: uniqueTags(resource.tags),
		createdAt: resource.createdAt,
		updatedAt: resource.updatedAt,
		openOccurrenceCount,
		reservations,
	};
}

function resourceOf(aggregate: Json, reservations: Json[]): Json {
	const occurrences: unknown[] = Array.isArray(aggregate.occurrences) ? aggregate.occurrences : [];
	return {
		...summaryOf(aggregate, openCount(aggregate), reservations),
		occurrences: occurrences.map(occurrence => occurrenceOf(occurrence as Json)),
	};
}

function occurrenceOf(occurrence: Json): Json {
	return {
		id: occurrence.id,
		resourceId: occurrence.resourceId,
		description: occurrence.description,
		type: occurrence.type,
		priority: occurrence.priority,
		status: occurrence.status,
		resolution: occurrence.resolution,
		reportedBy: occurrence.reportedBy,
		resolvedBy: occurrence.resolvedBy,
		createdAt: occurrence.createdAt,
		resolvedAt: occurrence.resolvedAt,
		updatedAt: occurrence.updatedAt,
	};
}

/** O schema browser exige `uniqueItems`; o domínio já normaliza, mas o BFF não confia nisso. */
function uniqueTags(value: unknown): unknown {
	if (!Array.isArray(value)) return value;
	return [...new Set(value)];
}

/** `openOccurrenceCount` é o número de ocorrências com status `OPEN` no agregado do domínio. */
function openCount(aggregate: Json): number {
	const occurrences: unknown[] = Array.isArray(aggregate.occurrences) ? aggregate.occurrences : [];
	return occurrences.filter(occurrence => isObject(occurrence) && occurrence.status === 'OPEN').length;
}

function locationOf(response: DownstreamResponse, fallback: string): string {
	const location = response.location ?? response.headers?.location;
	if (location === undefined || location === null || location === '') return fallback;
	return location;
}

/**
 * Cânone de faixas do oauth (addendum do PRD): A–E, F–N, P; sem O, E1, E2. A reserva é futura
 * quando o início da faixa (`data` + horário) é posterior ao agora em America/Sao_Paulo.
 */
const SLOT_START: Readonly<Record<string, string>> = {
	A: '08:00', B: '08:45', C: '09:45', D: '10:30', E: '11:30',
	F: '14:00', G: '14:45', H: '15:45', I: '16:30', J: '17:30',
	K: '18:15', L: '19:15', M: '20:00', N: '21:00', P: '21:45',
};

const saoPaulo = new Intl.DateTimeFormat('en-CA', {
	timeZone: 'America/Sao_Paulo',
	year: 'numeric',
	month: '2-digit',
	day: '2-digit',
	hour: '2-digit',
	minute: '2-digit',
	hourCycle: 'h23',
});

interface LocalNow { readonly date: string; readonly time: string }

function nowInSaoPaulo(now: Date): LocalNow {
	const parts = saoPaulo.formatToParts(now);
	const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? '';
	return {
		date: `${value('year')}-${value('month')}-${value('day')}`,
		time: `${value('hour')}:${value('minute')}`,
	};
}

function isFuture(reservation: Json, now: LocalNow): boolean {
	const data = reservation.data;
	const faixaId = reservation.faixaId;
	if (typeof data !== 'string' || typeof faixaId !== 'string') return false;
	const start = SLOT_START[faixaId];
	if (start === undefined) return false;
	if (data > now.date) return true;
	if (data < now.date) return false;
	return start > now.time;
}

function belongsTo(reservation: Json, resourceId: string): boolean {
	return resourceIdsOf(reservation).includes(resourceId);
}

function resourceIdsOf(reservation: Json): string[] {
	return Array.isArray(reservation.resourceIds)
		? reservation.resourceIds.filter((id): id is string => typeof id === 'string')
		: [];
}

/** Validação estrutural da reserva devolvida pelo contexto reservations. */
function validReservation(value: unknown): value is Json {
	if (!isObject(value)) return false;
	const { id, professorId, lessonId, data, faixaId, status, enabled, createdAt, updatedAt, resourceIds } = value;
	if (typeof id !== 'string' || typeof professorId !== 'string' || typeof lessonId !== 'string') return false;
	if (typeof data !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(data)) return false;
	if (typeof faixaId !== 'string' || SLOT_START[faixaId] === undefined) return false;
	if (status !== 'ACTIVE' && status !== 'CANCELLED') return false;
	if (typeof enabled !== 'boolean') return false;
	if (typeof createdAt !== 'string' || typeof updatedAt !== 'string') return false;
	if (value.purpose !== undefined && typeof value.purpose !== 'string') return false;
	return Array.isArray(resourceIds) && resourceIds.length > 0 && resourceIds.every(resourceId => typeof resourceId === 'string');
}

function parse(body: string): unknown {
	try {
		return JSON.parse(body);
	}
	catch {
		return undefined;
	}
}

function isObject(value: unknown): value is Json {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
