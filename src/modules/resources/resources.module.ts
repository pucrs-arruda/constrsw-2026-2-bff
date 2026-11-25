import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { CircuitBreaker } from '../../common/http/circuit-breaker';
import { DownstreamService } from '../../common/http/downstream.service';
import { ResourcesController } from './resources.controller';
import {
	RESERVATIONS_DOWNSTREAM,
	RESOURCES_CLOCK,
	RESOURCES_DOWNSTREAM,
	ResourcesService,
} from './resources.service';

function integer(config: ConfigService, name: string, fallback: number, min: number, max: number): number {
	const value = Number(config.get(name, fallback));
	if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid BFF configuration: ${name}`);
	return value;
}

function downstream(config: ConfigService, name: string, variable: string, fallback: string): DownstreamService {
	const value = config.get<string>(variable, fallback) ?? '';
	if (value.trim() === '') throw new Error(`Invalid BFF configuration: ${variable}`);
	const url = new URL(value);
	if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
		throw new Error(`Invalid BFF configuration: ${variable}`);
	}
	return new DownstreamService({
		name,
		baseUrl: url.origin,
		retryMethods: ['GET', 'HEAD'],
		timeoutMs: integer(config, 'BFF_HTTP_TIMEOUT_MS', 3_000, 1, 60_000),
		retries: integer(config, 'BFF_HTTP_RETRIES', 2, 0, 5),
		breaker: new CircuitBreaker({
			name,
			errorThresholdPercentage: integer(config, 'BFF_CIRCUIT_BREAKER_ERROR_THRESHOLD_PERCENTAGE', 50, 1, 100),
			resetTimeoutMs: integer(config, 'BFF_CIRCUIT_BREAKER_RESET_TIMEOUT_MS', 10_000, 1, 300_000),
			volumeThreshold: integer(config, 'BFF_CIRCUIT_BREAKER_VOLUME_THRESHOLD', 10, 1, 10_000),
			rollingWindowMs: integer(config, 'BFF_CIRCUIT_BREAKER_ROLLING_WINDOW_MS', 10_000, 1, 300_000),
		}),
	});
}

export function resourcesDownstream(config: ConfigService): DownstreamService {
	return downstream(config, 'resources', 'RESOURCES_BASE_URL', 'http://resources:8106');
}

export function reservationsDownstream(config: ConfigService): DownstreamService {
	return downstream(config, 'reservations', 'RESERVATIONS_BASE_URL', 'http://reservations:8109');
}

/**
 * Módulo do resources (UX-S3).
 *
 * Fala com dois contextos, cada um com o próprio disjuntor (AD-10): `resources`, dono do recurso,
 * e `reservations`, consultado só para a composição das reservas futuras. As bases vêm das
 * variáveis passadas pelo compose da base; timeout, retries e circuit breaker são os compartilhados.
 */
@Module({
	controllers: [ResourcesController],
	providers: [
		{
			provide: RESOURCES_DOWNSTREAM,
			inject: [ConfigService],
			useFactory: (config: ConfigService) => resourcesDownstream(config),
		},
		{
			provide: RESERVATIONS_DOWNSTREAM,
			inject: [ConfigService],
			useFactory: (config: ConfigService) => reservationsDownstream(config),
		},
		{ provide: RESOURCES_CLOCK, useValue: () => new Date() },
		ResourcesService,
	],
})
export class ResourcesModule {}
