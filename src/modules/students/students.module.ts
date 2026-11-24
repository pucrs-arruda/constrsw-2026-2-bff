import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { CircuitBreaker } from '../../common/http/circuit-breaker';
import { DownstreamService } from '../../common/http/downstream.service';
import { StudentsController } from './students.controller';
import { CLASSES_DOWNSTREAM, STUDENTS_DOWNSTREAM, StudentsService } from './students.service';

/**
 * Módulo do Grupo 04 (students).
 *
 * Fala com dois contextos, cada um com o próprio disjuntor (AD-10): `students`, dono do recurso, e
 * `classes`, consultado só para a composição de leitura T3 (classes do semestre em curso).
 *
 * Base URLs e parâmetros de resiliência vêm das variáveis do serviço `bff` no `docker-compose.yml`
 * do repositório base. Os defaults repetem o `.env` do base (rede Docker), usados só se a
 * variável faltar — por exemplo em testes unitários.
 */
function downstream(config: ConfigService, name: string, baseUrlKey: string, fallback: string): DownstreamService {
	return new DownstreamService({
		name,
		baseUrl: config.get<string>(baseUrlKey, fallback),
		timeoutMs: Number(config.get('BFF_HTTP_TIMEOUT_MS', 3_000)),
		retries: Number(config.get('BFF_HTTP_RETRIES', 2)),
		breaker: new CircuitBreaker({
			name,
			errorThresholdPercentage: Number(config.get('BFF_CIRCUIT_BREAKER_ERROR_THRESHOLD_PERCENTAGE', 50)),
			resetTimeoutMs: Number(config.get('BFF_CIRCUIT_BREAKER_RESET_TIMEOUT_MS', 10_000)),
			volumeThreshold: Number(config.get('BFF_CIRCUIT_BREAKER_VOLUME_THRESHOLD', 10)),
			rollingWindowMs: Number(config.get('BFF_CIRCUIT_BREAKER_ROLLING_WINDOW_MS', 10_000)),
		}),
	});
}

@Module({
	controllers: [StudentsController],
	providers: [
		{
			provide: STUDENTS_DOWNSTREAM,
			inject: [ConfigService],
			useFactory: (config: ConfigService) =>
				downstream(config, 'students', 'STUDENTS_BASE_URL', 'http://students:8080'),
		},
		{
			provide: CLASSES_DOWNSTREAM,
			inject: [ConfigService],
			useFactory: (config: ConfigService) =>
				downstream(config, 'classes', 'CLASSES_BASE_URL', 'http://classes:8107'),
		},
		StudentsService,
	],
})
export class StudentsModule {}
