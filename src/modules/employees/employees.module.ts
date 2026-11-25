import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { CircuitBreaker } from '../../common/http/circuit-breaker';
import { DownstreamService } from '../../common/http/downstream.service';
import { EmployeesController } from './employees.controller';
import { EMPLOYEES_DOWNSTREAM, EmployeesService } from './employees.service';

/**
 * Módulo proxy de `employees` (AD-6 pass-through; sem composição T3).
 *
 * Configuração vem das variáveis do serviço `bff` no compose da raiz:
 * `EMPLOYEES_BASE_URL` (origem sem `/api/v1`), `BFF_HTTP_*`, `BFF_CIRCUIT_BREAKER_*`.
 */
@Module({
	controllers: [EmployeesController],
	providers: [
		{
			provide: EMPLOYEES_DOWNSTREAM,
			inject: [ConfigService],
			useFactory: (config: ConfigService) =>
				new DownstreamService({
					name: 'employees',
					// Origin only — strip trailing /api/v1 if a stale .env still includes it.
					baseUrl: originOnly(
						config.get<string>('EMPLOYEES_BASE_URL', 'http://employees:8080'),
					),
					timeoutMs: Number(config.get('BFF_HTTP_TIMEOUT_MS', 3_000)),
					retries: Number(config.get('BFF_HTTP_RETRIES', 2)),
					breaker: new CircuitBreaker({
						name: 'employees',
						errorThresholdPercentage: Number(
							config.get('BFF_CIRCUIT_BREAKER_ERROR_THRESHOLD_PERCENTAGE', 50),
						),
						resetTimeoutMs: Number(config.get('BFF_CIRCUIT_BREAKER_RESET_TIMEOUT_MS', 10_000)),
						volumeThreshold: Number(config.get('BFF_CIRCUIT_BREAKER_VOLUME_THRESHOLD', 10)),
						rollingWindowMs: Number(config.get('BFF_CIRCUIT_BREAKER_ROLLING_WINDOW_MS', 10_000)),
					}),
				}),
		},
		EmployeesService,
	],
})
export class EmployeesModule {}

/** Keep baseUrl as host:port origin so DOMAIN_PREFIX owns `/api/v1/employees`. */
function originOnly(baseUrl: string): string {
	return baseUrl.replace(/\/?api\/v1\/?$/i, '').replace(/\/$/, '');
}
