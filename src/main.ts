import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { configureApp } from './bootstrap';

/**
 * Pelo AD-6, **só o BFF** configura CORS, e só para a origem do frontend, com credentials — os
 * contextos não habilitam CORS de SPA porque o browser nunca os chama.
 */
async function bootstrap(): Promise<void> {
	const app = await NestFactory.create(AppModule, { bodyParser: false });
	configureApp(app);

	await app.listen(Number(process.env.PORT ?? 3001));
}

void bootstrap();
