import { All, Controller, Get, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { bearerTokenOf } from '../../common/auth/bearer-token';
import type { DownstreamResponse } from '../../common/http/downstream.service';
import { StudentsService } from './students.service';

/**
 * Rotas de `students` publicadas para o frontend, nos paths de `docs/open-api/bff.yaml`:
 *
 * - `GET  /api/v1/students`                                  — composição: cada item + `classes`
 * - `GET  /api/v1/students/:id`                              — composição: estudante + `classes`
 * - `/api/v1/students` e `/api/v1/students/:id`, demais verbos — proxy
 * - `/api/v1/students/:id/enrollments[/:enrollmentId]`       — proxy
 *
 * Os `@Get` vêm antes dos `@All` do mesmo path: o Nest registra as rotas na ordem de declaração,
 * então o GET cai na composição e os outros verbos no proxy.
 */
@Controller('api/v1/students')
export class StudentsController {
	constructor(private readonly students: StudentsService) {}

	@Get()
	async list(@Req() request: Request, @Res() response: Response): Promise<void> {
		send(response, await this.students.list(queryOf(request), bearerTokenOf(request)));
	}

	@All()
	collection(@Req() request: Request, @Res() response: Response): Promise<void> {
		return this.proxy(request, response, '');
	}

	@Get(':id')
	async get(@Req() request: Request, @Res() response: Response): Promise<void> {
		send(
			response,
			await this.students.get(String(request.params.id), queryOf(request), bearerTokenOf(request)),
		);
	}

	@All(':id')
	item(@Req() request: Request, @Res() response: Response): Promise<void> {
		return this.proxy(request, response, `/${segment(request.params.id)}`);
	}

	@All(':id/enrollments')
	enrollments(@Req() request: Request, @Res() response: Response): Promise<void> {
		return this.proxy(request, response, `/${segment(request.params.id)}/enrollments`);
	}

	@All(':id/enrollments/:enrollmentId')
	enrollment(@Req() request: Request, @Res() response: Response): Promise<void> {
		return this.proxy(
			request,
			response,
			`/${segment(request.params.id)}/enrollments/${segment(request.params.enrollmentId)}`,
		);
	}

	private async proxy(request: Request, response: Response, suffix: string): Promise<void> {
		const result = await this.students.forward({
			method: request.method,
			suffix: `${suffix}${queryOf(request)}`,
			body: hasBody(request) ? JSON.stringify(request.body) : undefined,
			contentType: request.headers['content-type'],
			bearerToken: bearerTokenOf(request),
		});
		send(response, result);
	}
}

/** Query string crua, com `?`: os filtros do students usam operadores como `{like}` e `{gteq}`. */
function queryOf(request: Request): string {
	const index = request.originalUrl.indexOf('?');
	return index === -1 ? '' : request.originalUrl.slice(index);
}

function segment(value: unknown): string {
	return encodeURIComponent(String(value));
}

function hasBody(request: Request): boolean {
	return request.body !== undefined && Object.keys(request.body as object).length > 0;
}

function send(response: Response, result: DownstreamResponse): void {
	if (result.contentType) {
		response.setHeader('content-type', result.contentType);
	}
	response.status(result.status);
	// 204 não tem corpo.
	if (result.body) {
		response.send(result.body);
	}
	else {
		response.end();
	}
}
