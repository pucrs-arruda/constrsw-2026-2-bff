import { Inject, Injectable } from '@nestjs/common';

import {
	DownstreamRequest,
	DownstreamResponse,
	DownstreamService,
	DownstreamUnavailableError,
} from '../../common/http/downstream.service';

export const CLASSES_DOWNSTREAM = Symbol('CLASSES_DOWNSTREAM');

const CLASSES_PREFIX = '/api/v1/classes';
const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/** Envelope de indisponibilidade do AD-10: 503 + problem+json estável, com code de infraestrutura. */
export const CLASSES_UNAVAILABLE_BODY = JSON.stringify({
	type: 'about:blank',
	title: 'Dependência indisponível',
	status: 503,
	code: 'BFF-DOWNSTREAM-UNAVAILABLE',
	detail: 'O contexto classes não respondeu. Tente novamente em instantes.',
});

export type ForwardClassesRequest = Omit<DownstreamRequest, 'path'> & { suffix: string };

/**
 * Proxy do contexto `classes` (AD-6: *proxy*, não read-model de composição).
 *
 * Repassa a chamada ao contexto e devolve a resposta **como veio**: mesmo status, mesmo corpo.
 * Recusas do domínio (`400`, `401`, `403`, `404`, `409`, `422` em `application/problem+json`)
 * sobem intactas — o BFF não reinterpreta regra de negócio. Só a indisponibilidade vira 503.
 */
@Injectable()
export class ClassesService {
	constructor(@Inject(CLASSES_DOWNSTREAM) private readonly downstream: DownstreamService) {}

	async forward(request: ForwardClassesRequest): Promise<DownstreamResponse> {
		try {
			return await this.downstream.send({
				method: request.method,
				path: `${CLASSES_PREFIX}${request.suffix}`,
				body: request.body,
				contentType: request.contentType,
				bearerToken: request.bearerToken,
			});
		}
		catch (error) {
			if (error instanceof DownstreamUnavailableError) {
				return {
					status: 503,
					body: CLASSES_UNAVAILABLE_BODY,
					contentType: PROBLEM_CONTENT_TYPE,
				};
			}
			throw error;
		}
	}
}
