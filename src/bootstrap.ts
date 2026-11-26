import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { json, raw, urlencoded, Request, Response, NextFunction } from 'express';
import { bearerTokenOf } from './common/auth/bearer-token';
import { HttpMetrics } from './common/health/http-metrics';

/** Use with NestFactory.create(AppModule, { bodyParser: false }). */
export function configureApp(app: INestApplication): void {
	const origin = app.get(ConfigService).get<string>('BFF_ORIGIN', 'http://localhost:4200');
	const metrics = app.get(HttpMetrics);
	app.use((request: Request, response: Response, next: NextFunction) => {
		const started = Date.now();
		response.once('finish', () => metrics.observe(request, response, started));
		next();
	});
	app.enableCors({ origin, credentials: true, exposedHeaders: ['Location', 'X-Total-Count', 'Retry-After'] });
	app.use((request: Request, response: Response, next: NextFunction) => {
		const cookieAuthenticated = request.headers.authorization === undefined && bearerTokenOf(request) !== undefined;
		if (cookieAuthenticated && !['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.origin && request.headers.origin !== origin) {
			response.status(403).json({ error_code: 'CO-403', error_description: 'Origin is not allowed for session requests.', error_source: 'BFF', error_stack: [] });
			return;
		}
		next();
	});
	// Courses, Resources, and Rooms own JSON validation, including malformed and empty payloads.
	app.use('/api/v1/courses', raw({ type: () => true, limit: '1mb' }));
	app.use('/api/v1/resources', raw({ type: () => true, limit: '1mb' }));
	app.use('/api/v1/rooms', raw({ type: () => true, limit: '1mb' }));
	app.use('/api/v1/lessons', raw({ type: () => true, limit: '1mb' }));
	app.use(json({ limit: '1mb' }));
	app.use(urlencoded({ extended: true, limit: '1mb' }));
}
