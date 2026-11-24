import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { HttpMetrics } from './common/health/http-metrics';

/**
 * Pelo AD-6, **só o BFF** configura CORS, e só para a origem do frontend, com credentials — os
 * contextos não habilitam CORS de SPA porque o browser nunca os chama.
 */
async function bootstrap(): Promise<void> {
	const app = await NestFactory.create(AppModule, { bodyParser: false });
	configureApp(app);
	app.enableShutdownHooks();

	await app.listen(Number(process.env.PORT ?? 3001));
	const metricsPort = Number(process.env.BFF_INTERNAL_METRICS_PORT);
	if (metricsPort && metricsPort !== Number(process.env.PORT ?? 3001)) await app.get(HttpMetrics).listen(metricsPort);
}

void bootstrap();
