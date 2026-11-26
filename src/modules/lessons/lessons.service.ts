import { Inject, Injectable } from '@nestjs/common';

import { DownstreamRequest, DownstreamResponse, DownstreamService, DownstreamUnavailableError } from '../../common/http/downstream.service';

export const LESSONS_DOWNSTREAM = Symbol('LESSONS_DOWNSTREAM');

@Injectable()
export class LessonsService {
	constructor(@Inject(LESSONS_DOWNSTREAM) private readonly downstream: DownstreamService) {}

	async forward(request: DownstreamRequest): Promise<DownstreamResponse> {
		try {
			return await this.downstream.send(request);
		} catch (error) {
			if (!(error instanceof DownstreamUnavailableError)) throw error;
			return {
				status: 503,
				contentType: 'application/json',
				body: JSON.stringify({
					error_code: 'LE-503',
					error_description: 'O serviço Lessons está indisponível. Tente novamente em instantes.',
					error_source: 'BFF',
					error_stack: [],
				}),
			};
		}
	}
}
