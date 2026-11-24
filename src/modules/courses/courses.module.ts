import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CircuitBreaker } from '../../common/http/circuit-breaker';
import { DownstreamService } from '../../common/http/downstream.service';
import { CoursesController } from './courses.controller';
import { CLASSES_DOWNSTREAM, COURSES_CLOCK, COURSES_DOWNSTREAM, CoursesService } from './courses.service';

function integer(config: ConfigService, name: string, fallback: number, min: number, max: number): number {
	const value = Number(config.get(name, fallback));
	if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid BFF configuration: ${name}`);
	return value;
}

function downstream(provider: string, name: string, variable: string, fallback: string) {
	return { provide: provider, inject: [ConfigService], useFactory: (config: ConfigService) => {
		const url = new URL(config.get<string>(variable, fallback));
		if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error(`Invalid BFF configuration: ${variable}`);
		return new DownstreamService({
			name, baseUrl: url.origin, retryMethods: ['GET', 'HEAD'],
			timeoutMs: integer(config, 'BFF_HTTP_TIMEOUT_MS', 3000, 1, 60000), retries: integer(config, 'BFF_HTTP_RETRIES', 2, 0, 5),
			breaker: new CircuitBreaker({ name,
				errorThresholdPercentage: integer(config, 'BFF_CIRCUIT_BREAKER_ERROR_THRESHOLD_PERCENTAGE', 50, 1, 100),
				resetTimeoutMs: integer(config, 'BFF_CIRCUIT_BREAKER_RESET_TIMEOUT_MS', 10000, 1, 300000),
				volumeThreshold: integer(config, 'BFF_CIRCUIT_BREAKER_VOLUME_THRESHOLD', 10, 1, 10000),
				rollingWindowMs: integer(config, 'BFF_CIRCUIT_BREAKER_ROLLING_WINDOW_MS', 10000, 1, 300000),
			}),
		});
	} };
}

@Module({
	controllers: [CoursesController],
	providers: [CoursesService, { provide: COURSES_CLOCK, useValue: () => new Date() },
		downstream(COURSES_DOWNSTREAM, 'courses', 'COURSES_BASE_URL', 'http://courses:8080'),
		downstream(CLASSES_DOWNSTREAM, 'classes', 'CLASSES_BASE_URL', 'http://classes:8107'),
	],
})
export class CoursesModule {}
