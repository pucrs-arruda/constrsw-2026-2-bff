import { All, Controller, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { bearerTokenOf } from '../../common/auth/bearer-token';
import { CoursesService } from './courses.service';

const segment = (value: unknown) => encodeURIComponent(String(value));

@Controller('api/v1/courses')
export class CoursesController {
	constructor(private readonly courses: CoursesService) {}
	@All()
	collection(@Req() request: Request, @Res() response: Response) { return this.proxy(request, response, '', 'collection'); }
	@All('syllabus-items/:syllabusItemId')
	globalSyllabusItem(@Req() request: Request, @Res() response: Response) { return this.proxy(request, response, `/syllabus-items/${segment(request.params.syllabusItemId)}`); }
	@All(':courseId')
	item(@Req() request: Request, @Res() response: Response) { return this.proxy(request, response, `/${segment(request.params.courseId)}`, 'item'); }
	@All(':courseId/bibliographic-references')
	references(@Req() request: Request, @Res() response: Response) { return this.proxy(request, response, `/${segment(request.params.courseId)}/bibliographic-references`); }
	@All(':courseId/bibliographic-references/:referenceId')
	reference(@Req() request: Request, @Res() response: Response) { return this.proxy(request, response, `/${segment(request.params.courseId)}/bibliographic-references/${segment(request.params.referenceId)}`); }
	@All(':courseId/syllabus-items')
	syllabusItems(@Req() request: Request, @Res() response: Response) { return this.proxy(request, response, `/${segment(request.params.courseId)}/syllabus-items`); }
	@All(':courseId/syllabus-items/:syllabusItemId')
	syllabusItem(@Req() request: Request, @Res() response: Response) { return this.proxy(request, response, `/${segment(request.params.courseId)}/syllabus-items/${segment(request.params.syllabusItemId)}`); }

	private async proxy(request: Request, response: Response, suffix: string, compose?: 'collection' | 'item'): Promise<void> {
		const abort = new AbortController();
		const disconnected = () => { if (!response.writableEnded) abort.abort(); };
		response.on('close', disconnected);
		try {
			const queryAt = request.originalUrl.indexOf('?');
			const query = queryAt < 0 ? '' : request.originalUrl.slice(queryAt);
			const result = await this.courses.forward({
				method: request.method, path: `/api/v1/courses${suffix}${query}`,
				body: request.body === undefined ? undefined : Buffer.isBuffer(request.body) ? request.body.toString('utf8') : JSON.stringify(request.body),
				contentType: request.headers['content-type'], bearerToken: bearerTokenOf(request), signal: abort.signal,
			}, request.method === 'GET' ? compose : undefined);
			if (response.destroyed) return;
			if (result.contentType) response.setHeader('content-type', result.contentType);
			for (const [name, value] of Object.entries(result.headers ?? {})) response.setHeader(name, value);
			response.status(result.status);
			if (result.body) response.send(result.body); else response.end();
		} finally { response.off('close', disconnected); }
	}
}
