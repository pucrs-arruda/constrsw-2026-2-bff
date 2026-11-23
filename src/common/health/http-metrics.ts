import { Controller, Get, Injectable, Logger, OnApplicationShutdown, Res } from '@nestjs/common';
import { createServer, Server } from 'node:http';
import type { Request, Response } from 'express';

@Injectable()
export class HttpMetrics implements OnApplicationShutdown {
	private readonly counts = new Map<string, number>();
	private readonly started = Date.now();
	private readonly logger = new Logger('BffHttp');
	private server?: Server;

	observe(request: Request, response: Response, started: number): void {
		const method = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(request.method) ? request.method : 'OTHER';
		const route = typeof request.route?.path === 'string' ? request.route.path : 'unmatched';
		const labels = `method=${JSON.stringify(method)},route=${JSON.stringify(route)},status="${response.statusCode}"`;
		this.counts.set(labels, (this.counts.get(labels) ?? 0) + 1);
		this.logger.log(JSON.stringify({ method, route, status: response.statusCode, durationMs: Date.now() - started }));
	}

	render(): string {
		return '# HELP bff_http_requests_total Completed HTTP requests\n# TYPE bff_http_requests_total counter\n'
			+ [...this.counts].map(([labels, count]) => `bff_http_requests_total{${labels}} ${count}\n`).join('')
			+ '# HELP bff_uptime_seconds Process uptime\n# TYPE bff_uptime_seconds gauge\n'
			+ `bff_uptime_seconds ${(Date.now() - this.started) / 1000}\n`;
	}

	async listen(port: number): Promise<void> {
		this.server = createServer((request, response) => {
			if (request.url !== '/metrics') { response.writeHead(404).end(); return; }
			response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' }).end(this.render());
		});
		await new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(port, '0.0.0.0', resolve); });
	}
	async onApplicationShutdown(): Promise<void> {
		if (this.server) await new Promise<void>((resolve, reject) => this.server!.close(error => error ? reject(error) : resolve()));
	}
}

@Controller()
export class MetricsController {
	constructor(private readonly metrics: HttpMetrics) {}
	@Get('metrics')
	get(@Res() response: Response): void { response.type('text/plain; version=0.0.4; charset=utf-8').send(this.metrics.render()); }
}
