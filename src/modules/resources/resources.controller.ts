import { Controller, Get, Patch, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { bearerTokenOf } from '../../common/auth/bearer-token';
import type { DownstreamResponse } from '../../common/http/downstream.service';
import { ResourcesService } from './resources.service';

/**
 * Rotas browser-facing do recurso (UX-S3), no contrato `bff-openapi.yaml`:
 *
 * - `GET    /api/v1/resources`                                              — lista + count + reservations
 * - `POST   /api/v1/resources`                                              — cria + `Location`
 * - `GET    /api/v1/resources/:resourceId`                                  — agregado + count + reservations
 * - `PATCH  /api/v1/resources/:resourceId`                                  — atualiza agregado + count + reservations
 * - `POST   /api/v1/resources/:resourceId/occurrences`                      — registra + `Location`
 * - `PATCH  /api/v1/resources/:resourceId/occurrences/:occurrenceId`        — resolve
 *
 * Toda rota exige sessão (cookie ou Bearer). Sem token, o BFF responde 401 `problem+json` antes de
 * qualquer chamada ao domínio. O domínio é o dono das recusas: 403, 404, 409 e 422 sobem intactos.
 */
@Controller('api/v1/resources')
export class ResourcesController {
	constructor(private readonly resources: ResourcesService) {}

	@Get()
	list(@Req() request: Request, @Res() response: Response): Promise<void> {
		return this.proxy(request, response, (token, instance, signal) =>
			this.resources.list(queryOf(request), token, instance, signal));
	}

	@Post()
	create(@Req() request: Request, @Res() response: Response): Promise<void> {
		return this.proxy(request, response, (token, instance, signal) =>
			this.resources.create(bodyOf(request), request.headers['content-type'], token, instance, signal));
	}

	@Get(':resourceId')
	get(@Req() request: Request, @Res() response: Response): Promise<void> {
		return this.proxy(request, response, (token, instance, signal) =>
			this.resources.get(segment(request.params.resourceId), token, instance, signal));
	}

	@Patch(':resourceId')
	update(@Req() request: Request, @Res() response: Response): Promise<void> {
		return this.proxy(request, response, (token, instance, signal) =>
			this.resources.update(segment(request.params.resourceId), bodyOf(request), request.headers['content-type'], token, instance, signal));
	}

	@Post(':resourceId/occurrences')
	createOccurrence(@Req() request: Request, @Res() response: Response): Promise<void> {
		return this.proxy(request, response, (token, instance, signal) =>
			this.resources.createOccurrence(
				segment(request.params.resourceId),
				bodyOf(request),
				request.headers['content-type'],
				token,
				instance,
				signal,
			));
	}

	@Patch(':resourceId/occurrences/:occurrenceId')
	resolveOccurrence(@Req() request: Request, @Res() response: Response): Promise<void> {
		return this.proxy(request, response, (token, instance, signal) =>
			this.resources.resolveOccurrence(
				segment(request.params.resourceId),
				segment(request.params.occurrenceId),
				bodyOf(request),
				request.headers['content-type'],
				token,
				instance,
				signal,
			));
	}

	private async proxy(
		request: Request,
		response: Response,
		call: (token: string, instance: string, signal: AbortSignal) => Promise<DownstreamResponse>,
	): Promise<void> {
		const instance = instanceOf(request);
		const token = bearerTokenOf(request);
		if (token === undefined) {
			sendProblem(response, 401, {
				type: 'urn:closed-cras:auth:unauthenticated',
				title: 'Authentication required',
				status: 401,
				detail: 'The BFF session is missing or expired.',
				instance,
				code: 'AUTH_UNAUTHENTICATED',
				reason: 'MISSING_TOKEN',
			});
			return;
		}

		const abort = new AbortController();
		const disconnected = () => { if (!response.writableEnded) abort.abort(); };
		response.on('close', disconnected);
		try {
			const result = await call(token, instance, abort.signal);
			if (response.destroyed) return;
			send(response, result);
		}
		catch (error) {
			if (error instanceof InvalidIdentifier) {
				sendProblem(response, 400, {
					type: 'urn:closed-cras:malformed-request',
					title: 'Malformed request',
					status: 400,
					detail: 'Dot segments are not valid resource identifiers.',
					instance,
					code: 'MALFORMED_REQUEST',
				});
				return;
			}
			if (response.destroyed) return;
			if (response.headersSent) {
				response.end();
				return;
			}
			sendProblem(response, 500, {
				type: 'urn:closed-cras:internal',
				title: 'Internal error',
				status: 500,
				detail: 'An unexpected error occurred.',
				instance,
				code: 'INTERNAL_ERROR',
			});
		}
		finally {
			response.off('close', disconnected);
		}
	}
}

class InvalidIdentifier extends Error {}

function segment(value: unknown): string {
	const identifier = String(value);
	if (identifier === '' || identifier === '.' || identifier === '..') {
		throw new InvalidIdentifier();
	}
	// O service codifica uma única vez; codificar aqui também produziria `%252F`.
	return identifier;
}

const ALLOWED_FILTERS = new Set(['code', 'type', 'active', 'tag']);

/**
 * O contrato browser só documenta `code`, `type`, `active` e `tag`. Filtrar aqui evita que
 * `enabled=false` (exclusão lógica do domínio) vaze registros removidos para o browser.
 */
function queryOf(request: Request): string {
	const at = request.originalUrl.indexOf('?');
	if (at < 0) return '';
	const source = new URLSearchParams(request.originalUrl.slice(at + 1));
	const allowed = new URLSearchParams();
	for (const [name, value] of source) {
		if (ALLOWED_FILTERS.has(name)) allowed.append(name, value);
	}
	const query = allowed.toString();
	return query === '' ? '' : `?${query}`;
}

function instanceOf(request: Request): string {
	const at = request.originalUrl.indexOf('?');
	return at < 0 ? request.originalUrl : request.originalUrl.slice(0, at);
}

function bodyOf(request: Request): string | undefined {
	const body: unknown = request.body;
	if (body === undefined) return undefined;
	if (Buffer.isBuffer(body)) return body.length > 0 ? body.toString('utf8') : undefined;
	return JSON.stringify(body);
}

function send(response: Response, result: DownstreamResponse): void {
	if (result.contentType) {
		response.setHeader('content-type', result.contentType);
	}
	for (const [name, value] of Object.entries(result.headers ?? {})) response.setHeader(name, value);
	response.status(result.status);
	// `res.end` em vez de `res.send` evita o ETag automático do Express nas leituras compostas,
	// que já removeram o ETag/Last-Modified do domínio. Um ETag do domínio ainda sobe em passthrough.
	if (response.req?.method === 'HEAD' || !result.body) {
		response.end();
		return;
	}
	response.setHeader('content-length', Buffer.byteLength(result.body));
	response.end(result.body);
}

function sendProblem(response: Response, status: number, problem: Record<string, unknown>): void {
	if (status === 401) response.setHeader('www-authenticate', 'Bearer');
	response
		.status(status)
		.setHeader('content-type', 'application/problem+json')
		.send(JSON.stringify(problem));
}
