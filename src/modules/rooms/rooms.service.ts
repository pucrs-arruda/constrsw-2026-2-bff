import { Inject, Injectable } from '@nestjs/common';

import {
	DownstreamRequest,
	DownstreamResponse,
	DownstreamService,
	DownstreamUnavailableError,
} from '../../common/http/downstream.service';

export const ROOMS_DOWNSTREAM = Symbol('ROOMS_DOWNSTREAM');

/**
 * Proxy do contexto `rooms` (AD-6: *proxy*, não read-model de composição).
 *
 * O prefixo do domínio é fixo aqui porque o contrato do `rooms` serve sob `/api/v1`, enquanto o
 * BFF publica `/v1/rooms` para o browser — o espelhamento de paths do AD-6 é só de forma, não de
 * prefixo.
 */
const DOMAIN_PREFIX = '/api/v1/rooms';

/** Envelope de indisponibilidade do AD-10: 503 + problem+json estável, com code de infraestrutura. */
export const UNAVAILABLE_BODY = JSON.stringify({
	type: 'about:blank',
	title: 'Dependência indisponível',
	status: 503,
	code: 'BFF-DOWNSTREAM-UNAVAILABLE',
	detail: 'O contexto rooms não respondeu. Tente novamente em instantes.',
});

@Injectable()
export class RoomsService {
	constructor(@Inject(ROOMS_DOWNSTREAM) private readonly downstream: DownstreamService) {}

	/**
	 * Repassa a chamada ao contexto e devolve a resposta **como veio**: mesmo status, mesmo corpo.
	 * Recusa FR do domínio (409, 404, 400…) sobe intacta — o BFF não reinterpreta regra de negócio.
	 * Só a dependência fora do ar vira 503.
	 */
	async forward(request: Omit<DownstreamRequest, 'path'> & { suffix: string }): Promise<DownstreamResponse> {
		try {
			return await this.downstream.send({
				method: request.method,
				path: `${DOMAIN_PREFIX}${request.suffix}`,
				body: request.body,
				contentType: request.contentType,
				bearerToken: request.bearerToken,
			});
		}
		catch (error) {
			if (error instanceof DownstreamUnavailableError) {
				return {
					status: 503,
					body: UNAVAILABLE_BODY,
					contentType: 'application/problem+json',
				};
			}
			throw error;
		}
	}
}
