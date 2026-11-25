import { All, Controller, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { bearerTokenOf } from '../../common/auth/bearer-token';
import { EmployeesService } from './employees.service';

/**
 * Rotas de `employees` publicadas para o frontend (`bff.yaml` + SPA `bffBaseUrl: '/api'`).
 *
 * - `/api/v1/employees`                                           — GET, POST
 * - `/api/v1/employees/:id`                                       — GET, PUT, PATCH, DELETE
 * - `/api/v1/employees/:id/dependents`                            — GET, POST
 * - `/api/v1/employees/:id/dependents/:dependentId`               — GET, PUT, PATCH, DELETE
 *
 * Um `@All` por rota: quem recusa método/papel é o domínio (AD-6).
 */
@Controller('api/v1/employees')
export class EmployeesController {
	constructor(private readonly employees: EmployeesService) {}

	@All()
	collection(@Req() request: Request, @Res() response: Response): Promise<void> {
		return this.proxy(request, response, '');
	}

	@All(':id')
	item(@Req() request: Request, @Res() response: Response): Promise<void> {
		return this.proxy(request, response, `/${encodeURIComponent(String(request.params.id))}`);
	}

	@All(':id/dependents')
	dependents(@Req() request: Request, @Res() response: Response): Promise<void> {
		return this.proxy(
			request,
			response,
			`/${encodeURIComponent(String(request.params.id))}/dependents`,
		);
	}

	@All(':id/dependents/:dependentId')
	dependent(@Req() request: Request, @Res() response: Response): Promise<void> {
		return this.proxy(
			request,
			response,
			`/${encodeURIComponent(String(request.params.id))}/dependents/${encodeURIComponent(String(request.params.dependentId))}`,
		);
	}

	private async proxy(request: Request, response: Response, suffix: string): Promise<void> {
		const query = request.originalUrl.includes('?')
			? request.originalUrl.slice(request.originalUrl.indexOf('?'))
			: '';

		const result = await this.employees.forward({
			method: request.method,
			suffix: `${suffix}${query}`,
			body: hasBody(request) ? JSON.stringify(request.body) : undefined,
			contentType: request.headers['content-type'],
			bearerToken: bearerTokenOf(request),
		});

		if (result.contentType) {
			response.setHeader('content-type', result.contentType);
		}
		// DownstreamService already puts Location (and other whitelisted headers) in `headers`.
		for (const [name, value] of Object.entries(result.headers ?? {})) {
			response.setHeader(name, value);
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

function hasBody(request: Request): boolean {
	return request.body !== undefined && request.headers['content-length'] !== '0';
}
