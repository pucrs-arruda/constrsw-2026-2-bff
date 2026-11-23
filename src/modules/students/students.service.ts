import { Inject, Injectable } from '@nestjs/common';

import { currentSemester } from '../../common/academic/current-semester';
import {
	DownstreamRequest,
	DownstreamResponse,
	DownstreamService,
	DownstreamUnavailableError,
} from '../../common/http/downstream.service';

export const STUDENTS_DOWNSTREAM = Symbol('STUDENTS_DOWNSTREAM');
export const CLASSES_DOWNSTREAM = Symbol('CLASSES_DOWNSTREAM');

/** O contrato do students serve sob `/api/v1/students`, o mesmo path que o BFF publica. */
const STUDENTS_PREFIX = '/api/v1/students';
const CLASSES_PATH = '/api/v1/classes';

const JSON_CONTENT_TYPE = 'application/json';
const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/** O students fora do ar no proxy: 503 estável (AD-10), como nos demais módulos. */
const STUDENTS_UNAVAILABLE_BODY = JSON.stringify({
	type: 'about:blank',
	title: 'Dependência indisponível',
	status: 503,
	code: 'BFF-DOWNSTREAM-UNAVAILABLE',
	detail: 'O contexto students não respondeu. Tente novamente em instantes.',
});

type Json = Record<string, unknown>;

interface ClassLike extends Json {
	readonly studentIds?: unknown;
}

export interface ForwardRequest extends Omit<DownstreamRequest, 'path'> {
	/** Trecho depois de `/api/v1/students`, já com a query string. */
	readonly suffix: string;
}

/**
 * Proxy do contexto `students` mais a composição de leitura T3 (`docs/open-api/bff.yaml`).
 *
 * - **Proxy:** POST, PUT, PATCH, DELETE e os GET de matrículas repetem o contrato do students.
 *   Status e corpo sobem como vieram (AD-6).
 * - **Composição:** `GET /api/v1/students` e `GET /api/v1/students/{id}` acrescentam `classes`, as
 *   classes do semestre em curso cujo `studentIds` contém o id do estudante. Se o classes não
 *   puder ser consultado, a resposta é 503 `problem+json` com `code` `BFF-DEPENDENCY` e o
 *   estudante não é devolvido pela metade.
 */
@Injectable()
export class StudentsService {
	constructor(
		@Inject(STUDENTS_DOWNSTREAM) private readonly students: DownstreamService,
		@Inject(CLASSES_DOWNSTREAM) private readonly classes: DownstreamService,
	) {}

	forward(request: ForwardRequest): Promise<DownstreamResponse> {
		return this.callStudents(request);
	}

	/** `GET /api/v1/students` com os filtros do cliente, cada item com `classes`. */
	async list(query: string, bearerToken?: string): Promise<DownstreamResponse> {
		return this.compose({ method: 'GET', suffix: query, bearerToken }, (body, classes) => {
			if (!Array.isArray(body)) {
				return undefined;
			}
			return body.map((student: Json) => withClasses(student, classes));
		});
	}

	/** `GET /api/v1/students/{id}` com `classes`. */
	async get(id: string, query: string, bearerToken?: string): Promise<DownstreamResponse> {
		return this.compose(
			{ method: 'GET', suffix: `/${encodeURIComponent(id)}${query}`, bearerToken },
			(body, classes) => (isObject(body) ? withClasses(body, classes) : undefined),
		);
	}

	/**
	 * Busca o recurso no students e as classes do semestre em paralelo. Só compõe quando o students
	 * respondeu 200; qualquer outro status do students (400, 401, 403, 404…) sobe intacto, porque é
	 * a resposta do dono do recurso. Com o students em 200, falha no classes vira 503.
	 */
	private async compose(
		request: ForwardRequest,
		merge: (body: unknown, classes: ClassLike[]) => unknown,
	): Promise<DownstreamResponse> {
		const [student, classes] = await Promise.all([
			this.callStudents(request),
			this.currentClasses(request.bearerToken),
		]);

		if (student.status !== 200) {
			return student;
		}
		if (classes === undefined) {
			return dependencyProblem();
		}

		const merged = merge(parse(student.body), classes);
		if (merged === undefined) {
			// O students respondeu 200 com um corpo fora do contrato; não há o que compor.
			return student;
		}

		return { status: 200, body: JSON.stringify(merged), contentType: JSON_CONTENT_TYPE };
	}

	private async callStudents(request: ForwardRequest): Promise<DownstreamResponse> {
		try {
			return await this.students.send({
				method: request.method,
				path: `${STUDENTS_PREFIX}${request.suffix}`,
				body: request.body,
				contentType: request.contentType,
				bearerToken: request.bearerToken,
			});
		}
		catch (error) {
			if (error instanceof DownstreamUnavailableError) {
				return { status: 503, body: STUDENTS_UNAVAILABLE_BODY, contentType: PROBLEM_CONTENT_TYPE };
			}
			throw error;
		}
	}

	/**
	 * Classes do semestre em curso. O classes filtra por `year` e `semester`, mas não por estudante,
	 * então o BFF filtra `studentIds` em memória — uma única chamada atende a lista inteira.
	 *
	 * Devolve `undefined` quando o classes não pôde ser consultado: fora do ar, status diferente de
	 * 2xx ou corpo que não é uma lista.
	 */
	private async currentClasses(bearerToken?: string): Promise<ClassLike[] | undefined> {
		const { year, semester } = currentSemester();
		try {
			const response = await this.classes.send({
				method: 'GET',
				path: `${CLASSES_PATH}?year=${year}&semester=${semester}`,
				bearerToken,
			});
			if (response.status < 200 || response.status >= 300) {
				return undefined;
			}
			const body = parse(response.body);
			return Array.isArray(body) ? (body as ClassLike[]) : undefined;
		}
		catch (error) {
			if (error instanceof DownstreamUnavailableError) {
				return undefined;
			}
			throw error;
		}
	}
}

function withClasses(student: Json, classes: ClassLike[]): Json {
	const id = student.id;
	return {
		...student,
		classes: classes.filter(
			(item) => Array.isArray(item.studentIds) && item.studentIds.includes(id),
		),
	};
}

function dependencyProblem(): DownstreamResponse {
	return {
		status: 503,
		contentType: PROBLEM_CONTENT_TYPE,
		body: JSON.stringify({
			type: 'urn:closed-cras:bff:dependency',
			title: 'Dependência da composição indisponível',
			status: 503,
			detail: 'O serviço classes não pôde ser consultado; o estudante não é devolvido sem as classes do semestre em curso.',
			code: 'BFF-DEPENDENCY',
		}),
	};
}

function parse(body: string): unknown {
	try {
		return JSON.parse(body);
	}
	catch {
		return undefined;
	}
}

function isObject(value: unknown): value is Json {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
