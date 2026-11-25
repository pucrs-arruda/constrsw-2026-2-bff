import { All, Controller, Inject, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { bearerTokenOf } from '../../common/auth/bearer-token';
import { KeycloakJwtVerifier } from './keycloak-jwt.verifier';
import { ReservationsService } from './reservations.service';

export const RESERVATIONS_JWT = Symbol('RESERVATIONS_JWT');

/**
 * Rotas do Grupo 03, iguais às do `bff.yaml` do base (mesmos paths do contrato do `reservations`):
 *
 * - `/api/v1/reservations`                               — GET, POST
 * - `/api/v1/reservations/ocupacao`                      — GET
 * - `/api/v1/reservations/:id`                           — GET, PUT, PATCH, DELETE
 * - `/api/v1/reservations/:id/details`                   — GET, POST
 * - `/api/v1/reservations/:id/details/:detailId`         — GET, PUT, PATCH, DELETE
 * - `/api/v1/identidade/me`                              — GET
 *
 * Um `@All` por rota, como no módulo rooms: quem recusa método é o domínio, não o proxy.
 * Toda rota exige `Authorization: Bearer` válido no Keycloak; sem ele, 401 **sem** chamar o backend.
 */
@Controller('api/v1')
export class ReservationsController {
	constructor(
		private readonly reservations: ReservationsService,
		@Inject(RESERVATIONS_JWT) private readonly jwt: KeycloakJwtVerifier,
	) {}

	@All('reservations')
	collection(@Req() request: Request, @Res() response: Response): Promise<void> {
		return this.proxy(request, response, '/api/v1/reservations');
	}

	// Antes de `:id`, senão "ocupacao" seria lido como id.
	@All('reservations/ocupacao')
	occupancy(@Req() request: Request, @Res() response: Response): Promise<void> {
		return this.proxy(request, response, '/api/v1/reservations/ocupacao');
	}

	@All('reservations/:id')
	item(@Req() request: Request, @Res() response: Response): Promise<void> {
		return this.proxy(request, response, '/api/v1/reservations', request.params.id);
	}

	@All('reservations/:id/details')
	details(@Req() request: Request, @Res() response: Response): Promise<void> {
		return this.proxy(request, response, '/api/v1/reservations', request.params.id, 'details');
	}

	@All('reservations/:id/details/:detailId')
	detail(@Req() request: Request, @Res() response: Response): Promise<void> {
		return this.proxy(
			request,
			response,
			'/api/v1/reservations',
			request.params.id,
			'details',
			request.params.detailId,
		);
	}

	@All('identidade/me')
	me(@Req() request: Request, @Res() response: Response): Promise<void> {
		return this.proxy(request, response, '/api/v1/identidade/me');
	}

	private async proxy(request: Request, response: Response, prefix: string, ...segments: unknown[]): Promise<void> {
		const token = bearerTokenOf(request);
		const check = await this.jwt.verify(token);
		if (!check.ok) {
			sendProblem(response, check.status, check.status === 401
				? { title: 'Não autenticado', detail: 'Token ausente, inválido ou expirado.' }
				: { title: 'Dependência indisponível', detail: 'Não foi possível validar o token: Keycloak indisponível.' });
			return;
		}

		const path = buildPath(prefix, segments);
		if (!path) {
			sendProblem(response, 404, { title: 'Não encontrado', detail: 'Recurso não encontrado.' });
			return;
		}

		const result = await this.reservations.forward({
			method: request.method,
			path: `${path}${queryOf(request)}`,
			body: bodyOf(request),
			contentType: request.headers['content-type'],
			bearerToken: token,
		});

		if (result.contentType) {
			response.setHeader('content-type', result.contentType);
		}
		// SPEC-bff CAP-1: o proxy repassa os cabeçalhos do domínio que o DownstreamService seleciona
		// (Location, X-Total-Count, Retry-After, WWW-Authenticate, ETag, Last-Modified, Cache-Control).
		for (const [name, value] of Object.entries(result.headers ?? {})) {
			response.setHeader(name, value);
		}
		if (result.location && !result.headers?.location) {
			response.setHeader('location', result.location);
		}
		response.status(result.status);
		if (result.body) {
			response.send(result.body);
		}
		else {
			response.end();
		}
	}
}

/**
 * Monta o path do backend com os ids reescapados. `.` e `..` não são id: o `fetch` os resolveria
 * e a chamada sairia da árvore de reservations.
 */
function buildPath(prefix: string, segments: unknown[]): string | undefined {
	let path = prefix;
	for (const segment of segments) {
		const value = String(segment);
		if (value === '' || value === '.' || value === '..') {
			return undefined;
		}
		path += `/${encodeURIComponent(value)}`;
	}
	return path;
}

/** Query exatamente como chegou (sem decodificar), para `{gteq}`, `%25` etc. chegarem iguais. */
function queryOf(request: Request): string {
	const at = request.originalUrl.indexOf('?');
	return at >= 0 ? request.originalUrl.slice(at) : '';
}

/**
 * Corpo a repassar. JSON já vem interpretado pelo parser global do Nest e é reserializado;
 * os outros tipos (como `application/merge-patch+json` do PATCH) chegam crus pelo parser do módulo.
 */
function bodyOf(request: Request): string | undefined {
	const body: unknown = request.body;
	if (body === undefined || body === null) {
		return undefined;
	}
	if (Buffer.isBuffer(body)) {
		return body.length > 0 ? body.toString('utf8') : undefined;
	}
	if (typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0 && !hasContent(request)) {
		return undefined;
	}
	return JSON.stringify(body);
}

function hasContent(request: Request): boolean {
	const length = Number(request.headers['content-length'] ?? 0);
	return length > 0 || request.headers['transfer-encoding'] !== undefined;
}

function sendProblem(response: Response, status: number, problem: { title: string; detail: string }): void {
	if (status === 401) {
		response.setHeader('www-authenticate', 'Bearer');
	}
	response
		.status(status)
		.setHeader('content-type', 'application/problem+json')
		.send(JSON.stringify({ type: 'about:blank', title: problem.title, status, detail: problem.detail }));
}
