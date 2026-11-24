import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { raw } from 'express';

import { CircuitBreaker } from '../../common/http/circuit-breaker';
import { DownstreamService } from '../../common/http/downstream.service';
import { KeycloakJwtVerifier } from './keycloak-jwt.verifier';
import { RESERVATIONS_JWT, ReservationsController } from './reservations.controller';
import { RESERVATIONS_DOWNSTREAM, ReservationsService } from './reservations.service';

/**
 * Módulo do Grupo 03.
 *
 * Só variáveis que o bloco `bff` do `docker-compose.yml` do base **já** passa:
 * `RESERVATIONS_BASE_URL`, `JWT_ISSUER`, `JWT_AUDIENCE`, `BFF_HTTP_TIMEOUT_MS`, `BFF_HTTP_RETRIES`
 * e os cinco `BFF_CIRCUIT_BREAKER_*`. Os defaults repetem o `.env` do base (rede Docker),
 * usados só se a variável faltar. Valor inválido (URL ou número) impede a subida com uma
 * mensagem que cita a variável.
 */
@Module({
	controllers: [ReservationsController],
	providers: [
		{
			provide: RESERVATIONS_DOWNSTREAM,
			inject: [ConfigService],
			useFactory: (config: ConfigService) =>
				new DownstreamService({
					name: 'reservations',
					baseUrl: urlFrom(config, 'RESERVATIONS_BASE_URL', 'http://reservations:8109'),
					timeoutMs: numberFrom(config, 'BFF_HTTP_TIMEOUT_MS', 3_000),
					retries: numberFrom(config, 'BFF_HTTP_RETRIES', 2),
					breaker: new CircuitBreaker({
						name: 'reservations',
						errorThresholdPercentage: numberFrom(config, 'BFF_CIRCUIT_BREAKER_ERROR_THRESHOLD_PERCENTAGE', 50),
						resetTimeoutMs: numberFrom(config, 'BFF_CIRCUIT_BREAKER_RESET_TIMEOUT_MS', 10_000),
						volumeThreshold: numberFrom(config, 'BFF_CIRCUIT_BREAKER_VOLUME_THRESHOLD', 10),
						rollingWindowMs: numberFrom(config, 'BFF_CIRCUIT_BREAKER_ROLLING_WINDOW_MS', 10_000),
					}),
				}),
		},
		{
			provide: RESERVATIONS_JWT,
			inject: [ConfigService],
			useFactory: (config: ConfigService) =>
				new KeycloakJwtVerifier({
					issuer: urlFrom(config, 'JWT_ISSUER', 'http://keycloak:8080/realms/constrsw'),
					audience: config.get<string>('JWT_AUDIENCE') || 'oauth',
					timeoutMs: numberFrom(config, 'BFF_HTTP_TIMEOUT_MS', 3_000),
				}),
		},
		ReservationsService,
	],
})
export class ReservationsModule implements NestModule {
	/**
	 * O parser global do Nest só lê `application/json`. O PATCH do contrato usa
	 * `application/merge-patch+json`; sem isto o corpo se perderia. Este parser só age nas rotas
	 * deste módulo e só quando o corpo ainda não foi lido.
	 */
	configure(consumer: MiddlewareConsumer): void {
		consumer.apply(raw({ type: () => true, limit: '1mb' })).forRoutes(ReservationsController);
	}
}

export function urlFrom(config: ConfigService, name: string, fallback: string): string {
	const value = (config.get<string>(name) || fallback).replace(/\/+$/, '');
	let protocol = '';
	try {
		protocol = new URL(value).protocol;
	}
	catch {
		// cai no erro abaixo
	}
	if (protocol !== 'http:' && protocol !== 'https:') {
		throw new Error(`Variável de ambiente ${name} inválida: "${value}" não é uma URL http(s).`);
	}
	return value;
}

export function numberFrom(config: ConfigService, name: string, fallback: number): number {
	const raw = config.get<string | number>(name);
	const value = raw === undefined || raw === '' ? fallback : Number(raw);
	if (!Number.isFinite(value) || value < 0) {
		throw new Error(`Variável de ambiente ${name} inválida: "${raw}" não é um número.`);
	}
	return value;
}
