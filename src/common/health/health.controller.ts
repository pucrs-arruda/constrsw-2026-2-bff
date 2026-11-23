import { Controller, Get } from '@nestjs/common';

/**
 * `GET /health` anônimo, exigido pelo AD-7 em todo serviço e usado pelo healthcheck do
 * `docker-compose.yml` do repositório base.
 *
 * Responde só pela própria aplicação: a saúde de cada contexto é do contexto, e agregar isso aqui
 * faria o BFF cair junto com qualquer dependência — o oposto do AD-10, que quer o BFF de pé para
 * responder 503 com envelope estável.
 */
@Controller()
export class HealthController {
	@Get('health')
	health(): { status: string } {
		return { status: 'UP' };
	}
}
