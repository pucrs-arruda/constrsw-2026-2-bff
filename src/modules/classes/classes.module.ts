import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { CircuitBreaker } from '../../common/http/circuit-breaker';
import { DownstreamService } from '../../common/http/downstream.service';
import { ClassesController } from './classes.controller';
import { CLASSES_DOWNSTREAM, ClassesService } from './classes.service';

/**
 * Módulo do Grupo 01 (`classes`).
 *
 * Toda a configuração vem das variáveis que o `docker-compose.yml` do repositório base **já**
 * declara para o serviço `bff` — `CLASSES_BASE_URL`, `BFF_HTTP_TIMEOUT_MS`, `BFF_HTTP_RETRIES` e
 * os `BFF_CIRCUIT_BREAKER_*`. Os defaults repetem os valores do `.env` do base, para o módulo
 * subir fora do compose (`npm test`, `npm run start:dev`).
 */
@Module({
	controllers: [ClassesController],
	providers: [
		{
			provide: CLASSES_DOWNSTREAM,
			inject: [ConfigService],
			useFactory: (config: ConfigService) =>
				new DownstreamService({
					name: 'classes',
					baseUrl: config.get<string>('CLASSES_BASE_URL', 'http://classes:8107'),
					timeoutMs: Number(config.get('BFF_HTTP_TIMEOUT_MS', 3_000)),
					retries: Number(config.get('BFF_HTTP_RETRIES', 2)),
					breaker: new CircuitBreaker({
						name: 'classes',
						errorThresholdPercentage: Number(
							config.get('BFF_CIRCUIT_BREAKER_ERROR_THRESHOLD_PERCENTAGE', 50),
						),
						resetTimeoutMs: Number(config.get('BFF_CIRCUIT_BREAKER_RESET_TIMEOUT_MS', 10_000)),
						volumeThreshold: Number(config.get('BFF_CIRCUIT_BREAKER_VOLUME_THRESHOLD', 10)),
						rollingWindowMs: Number(config.get('BFF_CIRCUIT_BREAKER_ROLLING_WINDOW_MS', 10_000)),
					}),
				}),
		},
		ClassesService,
	],
})
export class ClassesModule {}
