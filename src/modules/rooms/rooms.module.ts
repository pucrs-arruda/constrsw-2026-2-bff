import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { CircuitBreaker } from '../../common/http/circuit-breaker';
import { DownstreamService } from '../../common/http/downstream.service';
import { RoomsController } from './rooms.controller';
import { ROOMS_DOWNSTREAM, RoomsService } from './rooms.service';

/**
 * Módulo do Grupo 08.
 *
 * Toda a configuração vem das variáveis que o `docker-compose.yml` do repositório base **já**
 * declara para o serviço `bff` — `ROOMS_BASE_URL`, `BFF_HTTP_TIMEOUT_MS`, `BFF_HTTP_RETRIES` e os
 * cinco `BFF_CIRCUIT_BREAKER_*`. Nada de porta ou host escrito no código.
 *
 * Os defaults repetem os valores do `.env` do base (rede Docker), usados só se a variável
 * faltar — por exemplo em testes unitários.
 */
@Module({
	controllers: [RoomsController],
	providers: [
		{
			provide: ROOMS_DOWNSTREAM,
			inject: [ConfigService],
			useFactory: (config: ConfigService) =>
				new DownstreamService({
					name: 'rooms',
					baseUrl: config.get<string>('ROOMS_BASE_URL', 'http://rooms:8105'),
					timeoutMs: Number(config.get('BFF_HTTP_TIMEOUT_MS', 3_000)),
					retries: Number(config.get('BFF_HTTP_RETRIES', 2)),
					breaker: new CircuitBreaker({
						name: 'rooms',
						errorThresholdPercentage: Number(
							config.get('BFF_CIRCUIT_BREAKER_ERROR_THRESHOLD_PERCENTAGE', 50),
						),
						resetTimeoutMs: Number(config.get('BFF_CIRCUIT_BREAKER_RESET_TIMEOUT_MS', 10_000)),
						volumeThreshold: Number(config.get('BFF_CIRCUIT_BREAKER_VOLUME_THRESHOLD', 10)),
						rollingWindowMs: Number(config.get('BFF_CIRCUIT_BREAKER_ROLLING_WINDOW_MS', 10_000)),
					}),
				}),
		},
		RoomsService,
	],
})
export class RoomsModule {}
