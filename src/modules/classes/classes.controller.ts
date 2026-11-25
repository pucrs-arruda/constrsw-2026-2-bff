import { All, Controller, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { bearerTokenOf } from '../../common/auth/bearer-token';
import type { DownstreamResponse } from '../../common/http/downstream.service';
import { ClassesService } from './classes.service';

const METHODS_WITH_BODY = new Set(['POST', 'PUT', 'PATCH']);

/**
 * Rotas de `classes` publicadas para o frontend, nos paths de `docs/open-api/bff.yaml`:
 *
 * - `/api/v1/classes`                                — GET, POST
 * - `/api/v1/classes/import`                         — POST (declarada antes de `:classId`)
 * - `/api/v1/classes/:classId`                       — GET, PUT, PATCH, DELETE
 * - `/api/v1/classes/:classId/reviews`               — GET, POST
 * - `/api/v1/classes/:classId/reviews/:reviewId`     — GET, PUT, PATCH, DELETE
 *
 * Um `@All` por rota, seguindo o padrão dos demais módulos proxy: o BFF não decide regras por
 * verbo nem pré-valida invariantes de domínio (AD-6).
 */
@Controller('api/v1/classes')
export class ClassesController {
	constructor(private readonly classes: ClassesService) {}

	@All()
	collection(@Req() request: Request, @Res() response: Response): Promise<void> {
		return this.proxy(request, response, '');
	}

	@All('import')
	importBatch(@Req() request: Request, @Res() response: Response): Promise<void> {
		return this.proxy(request, response, '/import');
	}

	@All(':classId')
	item(@Req() request: Request, @Res() response: Response): Promise<void> {
		const classId = safeSegment(request.params.classId);
		if (!classId) {
			sendInvalidSegment(response, request.path);
			return Promise.resolve();
		}
		return this.proxy(request, response, `/${classId}`);
	}

	@All(':classId/reviews')
	reviews(@Req() request: Request, @Res() response: Response): Promise<void> {
		const classId = safeSegment(request.params.classId);
		if (!classId) {
			sendInvalidSegment(response, request.path);
			return Promise.resolve();
		}
		return this.proxy(request, response, `/${classId}/reviews`);
	}

	@All(':classId/reviews/:reviewId')
	review(@Req() request: Request, @Res() response: Response): Promise<void> {
		const classId = safeSegment(request.params.classId);
		const reviewId = safeSegment(request.params.reviewId);
		if (!classId || !reviewId) {
			sendInvalidSegment(response, request.path);
			return Promise.resolve();
		}
		return this.proxy(request, response, `/${classId}/reviews/${reviewId}`);
	}

	private async proxy(request: Request, response: Response, suffix: string): Promise<void> {
		const result = await this.classes.forward({
			method: request.method,
			suffix: `${suffix}${queryOf(request)}`,
			body: serializeBody(request),
			contentType: request.headers['content-type'],
			bearerToken: bearerTokenOf(request),
		});
		send(response, result);
	}
}

/** Query string crua, com `?`: os filtros do classes usam operadores como `{neq}`, `{gteq}` e `{like}`. */
function queryOf(request: Request): string {
	const index = request.originalUrl.indexOf('?');
	return index === -1 ? '' : request.originalUrl.slice(index);
}

function safeSegment(value: unknown): string | undefined {
	const raw = String(value ?? '');
	if (!raw || raw === '.' || raw === '..' || raw.includes('/') || raw.includes('\\')) {
		return undefined;
	}
	return encodeURIComponent(raw);
}

function serializeBody(request: Request): string | undefined {
	if (!METHODS_WITH_BODY.has(request.method.toUpperCase()) || request.body === undefined) {
		return undefined;
	}
	if (typeof request.body === 'string') {
		return request.body;
	}
	return JSON.stringify(request.body);
}

function sendInvalidSegment(response: Response, instance: string): void {
	response.setHeader('content-type', 'application/problem+json');
	response.status(400).send(
		JSON.stringify({
			type: 'about:blank',
			title: 'Requisição inválida',
			status: 400,
			code: 'BFF-BAD-REQUEST',
			detail: 'Parâmetro de caminho inválido.',
			instance,
		}),
	);
}

function send(response: Response, result: DownstreamResponse): void {
	if (result.location) {
		response.setHeader('location', result.location);
	}
	if (result.contentType) {
		response.setHeader('content-type', result.contentType);
	}
	response.status(result.status);
	// 204 não tem corpo; evitar enviar string vazia preserva semântica HTTP.
	if (result.status !== 204 && result.body) {
		response.send(result.body);
	}
	else {
		response.end();
	}
}
