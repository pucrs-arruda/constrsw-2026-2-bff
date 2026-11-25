import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CircuitBreaker } from '../../common/http/circuit-breaker';
import { DownstreamService } from '../../common/http/downstream.service';
import { RoomsController } from './rooms.controller';
import {
	ROOMS_CLASSES_DOWNSTREAM,
	ROOMS_CLOCK,
	ROOMS_DOWNSTREAM,
	RoomsService,
} from './rooms.service';

export { ROOMS_CLASSES_DOWNSTREAM, ROOMS_CLOCK, ROOMS_DOWNSTREAM };

function integer(config: ConfigService, name: string, fallback: number, min: number, max: number): number {
	const value = Number(config.get(name, fallback));
	if (!Number.isInteger(value) || value < min || value > max) {
		throw new Error(`Invalid BFF configuration: ${name}`);
	}
	return value;
}

function downstream(provider: string, name: string, variable: string, fallback: string) {
	return {
		provide: provider,
		inject: [ConfigService],
		useFactory: (config: ConfigService) => {
			const rawUrl = config.get<string>(variable, fallback);
			const url = new URL(rawUrl);
			if (
				!['http:', 'https:'].includes(url.protocol) ||
				url.username ||
				url.password ||
				url.search ||
				url.hash ||
				url.pathname !== '/'
			) {
				throw new Error(`Invalid BFF configuration: ${variable}`);
			}
			return new DownstreamService({
				name,
				baseUrl: url.origin,
				retryMethods: ['GET', 'HEAD'],
				timeoutMs: integer(config, 'BFF_HTTP_TIMEOUT_MS', 3000, 1, 60000),
				retries: integer(config, 'BFF_HTTP_RETRIES', 2, 0, 5),
				breaker: new CircuitBreaker({
					name,
					errorThresholdPercentage: integer(
						config,
						'BFF_CIRCUIT_BREAKER_ERROR_THRESHOLD_PERCENTAGE',
						50,
						1,
						100,
					),
					resetTimeoutMs: integer(
						config,
						'BFF_CIRCUIT_BREAKER_RESET_TIMEOUT_MS',
						10000,
						1,
						300000,
					),
					volumeThreshold: integer(
						config,
						'BFF_CIRCUIT_BREAKER_VOLUME_THRESHOLD',
						10,
						1,
						10000,
					),
					rollingWindowMs: integer(
						config,
						'BFF_CIRCUIT_BREAKER_ROLLING_WINDOW_MS',
						10000,
						1,
						300000,
					),
				}),
			});
		},
	};
}

@Module({
	controllers: [RoomsController],
	providers: [
		RoomsService,
		{ provide: ROOMS_CLOCK, useValue: () => new Date() },
		downstream(ROOMS_DOWNSTREAM, 'rooms', 'ROOMS_BASE_URL', 'http://rooms:8105'),
		downstream(ROOMS_CLASSES_DOWNSTREAM, 'classes', 'CLASSES_BASE_URL', 'http://classes:8107'),
	],
	exports: [RoomsService],
})
export class RoomsModule {}
