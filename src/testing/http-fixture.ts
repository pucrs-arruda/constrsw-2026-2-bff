import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';

export interface SeenRequest { method: string; url: string; body: string; headers: IncomingMessage['headers'] }
export interface Reply { status?: number; body?: string; headers?: Record<string, string>; delay?: number }

export async function httpFixture(reply: (request: SeenRequest) => Reply) {
	const seen: SeenRequest[] = [];
	const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		const received = { method: request.method!, url: request.url!, body: Buffer.concat(chunks).toString(), headers: request.headers };
		seen.push(received);
		const result = reply(received);
		if (result.delay) await new Promise(resolve => setTimeout(resolve, result.delay));
		if (response.destroyed) return;
		response.writeHead(result.status ?? 200, { 'content-type': 'application/json', ...result.headers });
		response.end(result.body ?? '[]');
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const address = server.address() as { port: number };
	return { seen, server, url: `http://127.0.0.1:${address.port}`, close: () => closeServer(server) };
}

export function closeServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close(error => error ? reject(error) : resolve());
		server.closeAllConnections();
	});
}
