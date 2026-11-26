import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { CircuitBreaker } from '../../common/http/circuit-breaker';
import { DownstreamService } from '../../common/http/downstream.service';
import { LessonsController } from './lessons.controller';
import { LESSONS_DOWNSTREAM, LessonsService } from './lessons.service';

function integer(config: ConfigService, name: string, fallback: number, min: number, max: number): number {
	const value = Number(config.get(name, fallback));
	if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid BFF configuration: ${name}`);
	return value;
}

export function lessonsDownstream(config: ConfigService): DownstreamService {
	const url = new URL(config.get<string>('LESSONS_BASE_URL', 'http://lessons:8108'));
	if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
		throw new Error('Invalid BFF configuration: LESSONS_BASE_URL');
	}
	return new DownstreamService({
		name: 'lessons', baseUrl: url.origin, retryMethods: ['GET', 'HEAD'],
		timeoutMs: integer(config, 'BFF_HTTP_TIMEOUT_MS', 3000, 1, 60000),
		retries: integer(config, 'BFF_HTTP_RETRIES', 2, 0, 5),
		breaker: new CircuitBreaker({
			name: 'lessons',
			errorThresholdPercentage: integer(config, 'BFF_CIRCUIT_BREAKER_ERROR_THRESHOLD_PERCENTAGE', 50, 1, 100),
			resetTimeoutMs: integer(config, 'BFF_CIRCUIT_BREAKER_RESET_TIMEOUT_MS', 10000, 1, 300000),
			volumeThreshold: integer(config, 'BFF_CIRCUIT_BREAKER_VOLUME_THRESHOLD', 10, 1, 10000),
			rollingWindowMs: integer(config, 'BFF_CIRCUIT_BREAKER_ROLLING_WINDOW_MS', 10000, 1, 300000),
		}),
	});
}

@Module({
	controllers: [LessonsController],
	providers: [LessonsService, {
		provide: LESSONS_DOWNSTREAM,
		inject: [ConfigService],
		useFactory: lessonsDownstream,
	}],
})
export class LessonsModule {}
