import { Inject, Injectable } from '@nestjs/common';

import {
	DownstreamRequest,
	DownstreamResponse,
	DownstreamService,
	DownstreamUnavailableError,
} from '../../common/http/downstream.service';

export const EMPLOYEES_DOWNSTREAM = Symbol('EMPLOYEES_DOWNSTREAM');

/**
 * Proxy do contexto `employees` (AD-6: *proxy*, não read-model de composição).
 *
 * `EMPLOYEES_BASE_URL` é só a origem (host:porta). O prefixo do contrato do domínio fica aqui.
 */
const DOMAIN_PREFIX = '/api/v1/employees';

/** Envelope de indisponibilidade do AD-10: 503 + problem+json estável, com code de infraestrutura. */
export const UNAVAILABLE_BODY = JSON.stringify({
	type: 'about:blank',
	title: 'Dependência indisponível',
	status: 503,
	code: 'BFF-DOWNSTREAM-UNAVAILABLE',
	detail: 'O contexto employees não respondeu. Tente novamente em instantes.',
});

@Injectable()
export class EmployeesService {
	constructor(@Inject(EMPLOYEES_DOWNSTREAM) private readonly downstream: DownstreamService) {}

	/**
	 * Repassa a chamada ao contexto e devolve a resposta **como veio**: mesmo status, mesmo corpo.
	 * Recusa do domínio sobe intacta — o BFF não reinterpreta regra de negócio.
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
