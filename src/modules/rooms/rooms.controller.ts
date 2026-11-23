import { All, Controller, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { bearerTokenOf } from '../../common/auth/bearer-token';
import { RoomsService } from './rooms.service';

/**
 * Rotas de `rooms` publicadas para o frontend.
 *
 * Pelo AD-6 o proxy espelha os paths do contexto sob `/v1/<contexto>/...`, então as quatro rotas
 * do contrato do `rooms` aparecem aqui como:
 *
 * - `/v1/rooms`                                             — GET, POST
 * - `/v1/rooms/:id`                                         — GET, PUT, PATCH, DELETE
 * - `/v1/rooms/:id/accessibility-features`                  — GET, POST
 * - `/v1/rooms/:id/accessibility-features/:featureId`       — GET, PUT, PATCH, DELETE
 *
 * Um `@All` por rota, em vez de um método por verbo: o proxy não decide nada por verbo — quem
 * recusa `POST` de quem não pode é o gateway do domínio, e inventar aqui uma lista de métodos
 * permitidos seria a "regra negocial no proxy" que o AD-6 proíbe. Método não suportado pelo
 * contexto volta como o próprio contexto responde (405/404), sem o BFF opinar.
 */
@Controller('v1/rooms')
export class RoomsController {
	constructor(private readonly rooms: RoomsService) {}

	@All()
	collection(@Req() request: Request, @Res() response: Response): Promise<void> {
		return this.proxy(request, response, '');
	}

	@All(':id')
	item(@Req() request: Request, @Res() response: Response): Promise<void> {
		return this.proxy(request, response, `/${encodeURIComponent(String(request.params.id))}`);
	}

	@All(':id/accessibility-features')
	features(@Req() request: Request, @Res() response: Response): Promise<void> {
		return this.proxy(request, response, `/${encodeURIComponent(String(request.params.id))}/accessibility-features`);
	}

	@All(':id/accessibility-features/:featureId')
	feature(@Req() request: Request, @Res() response: Response): Promise<void> {
		return this.proxy(
			request,
			response,
			`/${encodeURIComponent(String(request.params.id))}/accessibility-features/${encodeURIComponent(String(request.params.featureId))}`,
		);
	}

	private async proxy(request: Request, response: Response, suffix: string): Promise<void> {
		const query = request.originalUrl.includes('?')
			? request.originalUrl.slice(request.originalUrl.indexOf('?'))
			: '';

		const result = await this.rooms.forward({
			method: request.method,
			suffix: `${suffix}${query}`,
			body: hasBody(request) ? JSON.stringify(request.body) : undefined,
			contentType: request.headers['content-type'],
			bearerToken: bearerTokenOf(request),
		});

		if (result.contentType) {
			response.setHeader('content-type', result.contentType);
		}
		for (const [name, value] of Object.entries(result.headers ?? {})) response.setHeader(name, value);
		response.status(result.status);
		// 204 não tem corpo; mandar string vazia evita content-length indevido.
		if (result.body) {
			response.send(result.body);
		}
		else {
			response.end();
		}
	}
}

function hasBody(request: Request): boolean {
	return request.body !== undefined;
}
