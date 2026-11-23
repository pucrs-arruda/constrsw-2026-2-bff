import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';

/**
 * Pelo AD-6, **só o BFF** configura CORS, e só para a origem do frontend, com credentials — os
 * contextos não habilitam CORS de SPA porque o browser nunca os chama.
 */
async function bootstrap(): Promise<void> {
	const app = await NestFactory.create(AppModule);

	app.enableCors({
		origin: process.env.BFF_ORIGIN ?? 'http://localhost:4200',
		credentials: true,
	});
	app.useGlobalPipes(new ValidationPipe({ transform: true }));

	await app.listen(Number(process.env.PORT ?? 3001));
}

void bootstrap();
