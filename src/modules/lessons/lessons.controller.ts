import { All, Controller, NotFoundException, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { bearerTokenOf } from '../../common/auth/bearer-token';
import { LessonsService } from './lessons.service';

@Controller('api/v1/lessons')
export class LessonsController {
	constructor(private readonly lessons: LessonsService) {}

	@All()
	collection(@Req() request: Request, @Res() response: Response): Promise<void> {
		return this.proxy(request, response);
	}

	@All('generate')
	generate(@Req() request: Request, @Res() response: Response): Promise<void> {
		return this.proxy(request, response, 'generate');
	}

	@All(':lessonId')
	item(@Req() request: Request, @Res() response: Response): Promise<void> {
		return this.proxy(request, response, request.params.lessonId);
	}

	@All(':lessonId/topics')
	topics(@Req() request: Request, @Res() response: Response): Promise<void> {
		return this.proxy(request, response, request.params.lessonId, 'topics');
	}

	@All(':lessonId/topics/:topicId')
	topic(@Req() request: Request, @Res() response: Response): Promise<void> {
		return this.proxy(request, response, request.params.lessonId, 'topics', request.params.topicId);
	}

	private async proxy(request: Request, response: Response, ...segments: unknown[]): Promise<void> {
		const suffix = segments.map(segment => {
			const value = String(segment);
			// fetch normalizes dot segments, which would escape the Lessons route.
			if (!value || value === '.' || value === '..') throw new NotFoundException();
			return encodeURIComponent(value);
		}).join('/');
		const at = request.originalUrl.indexOf('?');
		const query = at < 0 ? '' : request.originalUrl.slice(at);
		const body: unknown = request.body;
		const abort = new AbortController();
		const disconnected = () => { if (!response.writableEnded) abort.abort(); };
		response.on('close', disconnected);
		try {
			const result = await this.lessons.forward({
				method: request.method,
				path: `/api/v1/lessons${suffix ? '/' + suffix : ''}${query}`,
				body: Buffer.isBuffer(body) ? (body.length ? body.toString('utf8') : undefined)
					: body === undefined ? undefined : JSON.stringify(body),
				contentType: request.headers['content-type'],
				bearerToken: bearerTokenOf(request),
				signal: abort.signal,
			});
			if (response.destroyed) return;
			if (result.contentType) response.setHeader('content-type', result.contentType);
			for (const [name, value] of Object.entries(result.headers ?? {})) response.setHeader(name, value);
			if (result.location) response.setHeader('location', result.location);
			response.status(result.status);
			if (result.body) response.send(result.body); else response.end();
		} finally {
			response.off('close', disconnected);
		}
	}
}
