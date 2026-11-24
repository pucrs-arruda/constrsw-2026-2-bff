import { Inject, Injectable } from '@nestjs/common';

import {
	DownstreamRequest,
	DownstreamResponse,
	DownstreamService,
	DownstreamUnavailableError,
} from '../../common/http/downstream.service';

export const RESERVATIONS_DOWNSTREAM = Symbol('RESERVATIONS_DOWNSTREAM');

/**
 * Problem RFC 9457 do 503, no formato do contrato do `reservations` (`grupo03-reservations-api.yaml`).
 * Sem `code`: no nosso schema, `code` é só para recusa de regra (`FR-n`).
 */
export const UNAVAILABLE_BODY = JSON.stringify({
	type: 'about:blank',
	title: 'Dependência indisponível',
	status: 503,
	detail: 'O serviço reservations não respondeu. Tente novamente em instantes.',
});

/**
 * Proxy do contexto `reservations` (Grupo 03). O `bff.yaml` não pede composição para este
 * contexto: o BFF repassa e devolve a resposta **como veio** (status, corpo, `Content-Type` e
 * `Location`). Recusas do domínio (403, 404, 409 FR-23/FR-30, 422) sobem intactas. Só a
 * indisponibilidade vira 503.
 */
@Injectable()
export class ReservationsService {
	constructor(@Inject(RESERVATIONS_DOWNSTREAM) private readonly downstream: DownstreamService) {}

	async forward(request: DownstreamRequest): Promise<DownstreamResponse> {
		try {
			return await this.downstream.send(request);
		}
		catch (error) {
			if (error instanceof DownstreamUnavailableError) {
				return { status: 503, body: UNAVAILABLE_BODY, contentType: 'application/problem+json' };
			}
			throw error;
		}
	}
}
