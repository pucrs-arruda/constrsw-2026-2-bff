import { Injectable, Logger } from '@nestjs/common';

import { CircuitBreaker, CircuitOpenError } from './circuit-breaker';

/**
 * Hop HTTP do BFF para um contexto, com as três garantias do AD-10: **timeout**,
 * **circuit breaker** e **retry só em operação idempotente, com backoff limitado**.
 *
 * O que ele deliberadamente **não** faz (AD-6): interpretar regra de negócio, pré-validar
 * invariante ou reescrever corpo. A resposta do domínio — inclusive `problem+json` de recusa
 * FR — sobe para o frontend como veio. Só a indisponibilidade da dependência é traduzida, e
 * para um 503 estável.
 */
export interface DownstreamResponse {
	readonly status: number;
	readonly body: string;
	readonly contentType: string | null;
}

export interface DownstreamRequest {
	readonly method: string;
	/** Caminho absoluto no downstream, já com query string. */
	readonly path: string;
	readonly body?: string;
	readonly contentType?: string;
	/** Token do usuário, repassado como `Authorization: Bearer` (AD-4). */
	readonly bearerToken?: string;
}

export interface DownstreamOptions {
	readonly name: string;
	readonly baseUrl: string;
	readonly timeoutMs: number;
	readonly retries: number;
	readonly breaker: CircuitBreaker;
}

/** Métodos em que repetir a chamada não cria efeito novo (RFC 9110). */
const IDEMPOTENT = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS', 'TRACE']);

export class DownstreamUnavailableError extends Error {
	constructor(readonly downstream: string, readonly reason: string) {
		super(`Dependência ${downstream} indisponível: ${reason}`);
		this.name = 'DownstreamUnavailableError';
	}
}

@Injectable()
export class DownstreamService {
	private readonly logger = new Logger(DownstreamService.name);

	constructor(private readonly options: DownstreamOptions) {}

	async send(request: DownstreamRequest): Promise<DownstreamResponse> {
		const attempts = IDEMPOTENT.has(request.method.toUpperCase())
			? this.options.retries + 1
			: 1;

		let lastReason = 'sem resposta';

		for (let attempt = 1; attempt <= attempts; attempt++) {
			try {
				return await this.options.breaker.run(() => this.callOnce(request));
			}
			catch (error) {
				if (error instanceof CircuitOpenError) {
					throw new DownstreamUnavailableError(this.options.name, 'circuito aberto');
				}
				lastReason = error instanceof Error ? error.message : String(error);
				this.logger.warn(
					`${request.method} ${request.path} em ${this.options.name}: tentativa ${attempt}/${attempts} falhou (${lastReason})`,
				);
				if (attempt < attempts) {
					await this.backoff(attempt);
				}
			}
		}

		throw new DownstreamUnavailableError(this.options.name, lastReason);
	}

	private async callOnce(request: DownstreamRequest): Promise<DownstreamResponse> {
		const headers: Record<string, string> = { accept: 'application/json' };
		if (request.bearerToken) {
			headers.authorization = `Bearer ${request.bearerToken}`;
		}
		if (request.body !== undefined) {
			headers['content-type'] = request.contentType ?? 'application/json';
		}

		const response = await fetch(`${this.options.baseUrl}${request.path}`, {
			method: request.method,
			headers,
			body: request.body,
			signal: AbortSignal.timeout(this.options.timeoutMs),
		});

		return {
			status: response.status,
			body: await response.text(),
			contentType: response.headers.get('content-type'),
		};
	}

	/** Backoff exponencial com teto, para o retry não virar martelo no downstream. */
	private backoff(attempt: number): Promise<void> {
		const delay = Math.min(100 * 2 ** (attempt - 1), 1_000);
		return new Promise((resolve) => setTimeout(resolve, delay));
	}
}
