import {
	All,
	BadRequestException,
	Controller,
	Get,
	Req,
	Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { bearerTokenOf } from '../../common/auth/bearer-token';
import { RoomsCompose, RoomsService } from './rooms.service';

const invalidRequest = (description: string) =>
	new BadRequestException({
		type: 'urn:closed-cras:bff:bad-request',
		title: 'Requisição inválida',
		status: 400,
		detail: description,
		code: 'BFF-BAD-REQUEST',
	});

function segment(value: unknown): string {
	const identifier = String(value);
	if (!identifier || identifier === '.' || identifier === '..') {
		throw invalidRequest('Dot segments are not valid resource identifiers.');
	}
	return encodeURIComponent(identifier);
}

@Controller('api/v1/rooms')
export class RoomsController {
	constructor(private readonly rooms: RoomsService) {}

	@Get()
	collection(@Req() request: Request, @Res() response: Response): Promise<void> {
		return this.proxy(request, response, '', 'collection');
	}

	@All()
	collectionProxy(@Req() request: Request, @Res() response: Response): Promise<void> {
		return this.proxy(request, response, '');
	}

	@Get(':id')
	item(@Req() request: Request, @Res() response: Response): Promise<void> {
		const id = segment(request.params.id);
		return this.proxy(request, response, `/${id}`, 'item', id);
	}

	@All(':id')
	itemProxy(@Req() request: Request, @Res() response: Response): Promise<void> {
		return this.proxy(request, response, `/${segment(request.params.id)}`);
	}

	@All(':id/accessibility-features')
	features(@Req() request: Request, @Res() response: Response): Promise<void> {
		return this.proxy(
			request,
			response,
			`/${segment(request.params.id)}/accessibility-features`,
		);
	}

	@All(':id/accessibility-features/:featureId')
	feature(@Req() request: Request, @Res() response: Response): Promise<void> {
		return this.proxy(
			request,
			response,
			`/${segment(request.params.id)}/accessibility-features/${segment(request.params.featureId)}`,
		);
	}

	private async proxy(
		request: Request,
		response: Response,
		suffix: string,
		compose?: RoomsCompose,
		roomId?: string,
	): Promise<void> {
		let body: Buffer | string | undefined;

		if (request.headers['content-length'] === '0') {
			body = undefined;
		} else if (Buffer.isBuffer(request.body)) {
			body = request.body.length === 0 ? undefined : request.body;
		} else if (request.body !== undefined && request.body !== null) {
			body = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
		}

		if (['GET', 'HEAD'].includes(request.method)) {
			const hasBody =
				(Buffer.isBuffer(body) && body.length > 0) ||
				(typeof body === 'string' && body.length > 0);
			if (hasBody) {
				throw invalidRequest('GET and HEAD do not accept a request body.');
			}
			body = undefined;
		}

		const abort = new AbortController();
		const disconnected = () => {
			if (!response.writableEnded) abort.abort();
		};
		response.on('close', disconnected);

		try {
			const queryAt = request.originalUrl.indexOf('?');
			const query = queryAt < 0 ? '' : request.originalUrl.slice(queryAt);

			const result = await this.rooms.forward(
				{
					method: request.method,
					suffix,
					query,
					body,
					contentType: request.headers['content-type'],
					bearerToken: bearerTokenOf(request),
					signal: abort.signal,
					roomId,
				},
				request.method === 'GET' ? compose : undefined,
			);

			if (response.destroyed) return;

			if (result.contentType) {
				response.setHeader('content-type', result.contentType);
			}
			for (const [name, value] of Object.entries(result.headers ?? {})) {
				response.setHeader(name, value);
			}
			response.status(result.status);
			if (result.body) {
				if (compose && request.method === 'GET' && result.status === 200) response.end(result.body);
				else response.send(result.body);
			} else {
				response.end();
			}
		} finally {
			response.off('close', disconnected);
		}
	}
}
