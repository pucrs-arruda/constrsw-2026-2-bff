import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { HealthController } from './common/health/health.controller';
import { RoomsModule } from './modules/rooms/rooms.module';

/**
 * Raiz da aplicação.
 *
 * **Arquivo compartilhado pelos nove grupos:** cada um acrescenta aqui uma linha de `import` e o
 * próprio módulo em `imports`. É o único ponto do BFF em que o trabalho de dois grupos se cruza,
 * então mantenha a lista em ordem alfabética — merge de linhas vizinhas é o que mais gera
 * conflito bobo.
 */
@Module({
	imports: [
		ConfigModule.forRoot({ isGlobal: true }),
		RoomsModule,
	],
	controllers: [HealthController],
})
export class AppModule {}
