import { Inject, Injectable } from '@nestjs/common';
import { DownstreamRequest, DownstreamResponse, DownstreamService, DownstreamUnavailableError } from '../../common/http/downstream.service';
import { currentSemester } from './current-semester';
import { validClass, validCourse } from './composition-contract';

export const COURSES_DOWNSTREAM = 'COURSES_DOWNSTREAM';
export const CLASSES_DOWNSTREAM = 'COURSES_CLASSES_DOWNSTREAM';
export const COURSES_CLOCK = 'COURSES_CLOCK';
type Resource = Record<string, unknown>;
const record = (value: unknown): value is Resource => value !== null && typeof value === 'object' && !Array.isArray(value);

function unavailable(): DownstreamResponse {
	return { status: 503, contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify({
		error_code: 'CO-503', error_description: 'A dependency required by Courses is unavailable.', error_source: 'BFF', error_stack: [],
	}) };
}

@Injectable()
export class CoursesService {
	constructor(
		@Inject(COURSES_DOWNSTREAM) private readonly courses: DownstreamService,
		@Inject(CLASSES_DOWNSTREAM) private readonly classes: DownstreamService,
		@Inject(COURSES_CLOCK) private readonly clock: () => Date,
	) {}

	async forward(request: DownstreamRequest, compose?: 'collection' | 'item'): Promise<DownstreamResponse> {
		try {
			const response = await this.courses.send(request);
			if (!compose || response.status !== 200) return response;
			try { return await this.compose(response, request, compose); }
			catch { return unavailable(); }
		} catch (error) {
			if (error instanceof DownstreamUnavailableError) return unavailable();
			throw error;
		}
	}

	private async compose(response: DownstreamResponse, request: DownstreamRequest, mode: 'collection' | 'item'): Promise<DownstreamResponse> {
		const payload: unknown = JSON.parse(response.body);
		const courses: unknown[] = mode === 'collection' && Array.isArray(payload) ? payload : mode === 'item' ? [payload] : [];
		if ((mode === 'collection' && !Array.isArray(payload)) || !courses.every(course => validCourse(course))) throw new Error('Invalid Courses payload');
		const { year, semester } = currentSemester(this.clock());
		const grouped = new Map<string, Resource[]>();
		if (courses.length > 0) {
			const query = new URLSearchParams({ year: String(year), semester: String(semester) });
			if (mode === 'item') query.set('courseId', String((courses[0] as Resource).id));
			const result = await this.classes.send({ method: 'GET', path: `/api/v1/classes?${query}`, bearerToken: request.bearerToken, signal: request.signal });
			if (result.status !== 200) throw new Error('Classes query failed');
			const classes: unknown = JSON.parse(result.body);
			if (!Array.isArray(classes)) throw new Error('Invalid Classes payload');
			for (const item of classes) {
				if (!record(item) || !validClass(item)) throw new Error('Invalid Class');
				if (!item.enabled || item.year !== year || item.semester !== semester) continue;
				const linked = grouped.get(String(item.courseId)) ?? [];
				linked.push(item); grouped.set(String(item.courseId), linked);
			}
		}
		const views = (courses as Resource[]).map(course => ({ ...course, classes: grouped.get(String(course.id)) ?? [] }));
		// Domain validators/cache metadata describe the uncomposed representation.
		const headers: Record<string, string> = { ...response.headers, 'cache-control': 'no-store' };
		delete headers.etag; delete headers['last-modified'];
		return { ...response, headers, body: JSON.stringify(mode === 'collection' ? views : views[0]) };
	}
}
