import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

import { DownstreamService, DownstreamUnavailableError } from '../../common/http/downstream.service';
import { LessonsService } from './lessons.service';

const root = join(__dirname, '../../..', 'openapi');
const browser = JSON.parse(readFileSync(join(root, 'openapi.json'), 'utf8'));
const domain = JSON.parse(readFileSync(join(root, 'domains/lessons.openapi.json'), 'utf8'));
const origin = 'https://bff.invalid/';
const expected: Record<string, string[]> = {
	'/api/v1/lessons': ['get', 'post'],
	'/api/v1/lessons/generate': ['post'],
	'/api/v1/lessons/{lessonId}': ['get', 'put', 'patch', 'delete'],
	'/api/v1/lessons/{lessonId}/topics': ['get', 'post'],
	'/api/v1/lessons/{lessonId}/topics/{topicId}': ['get', 'put', 'patch', 'delete'],
};
const methods = ['get', 'post', 'put', 'patch', 'delete'];
const classId = '11111111-1111-4111-8111-111111111111';
const lessonId = '22222222-2222-4222-8222-222222222222';
const topicId = '33333333-3333-4333-8333-333333333333';
const create = { classId, date: '2026-11-04', timeSlotId: 'H' };
const topic = { id: topicId, lessonId, order: 1, statement: 'Introdução', enabled: true };
const lesson = { ...create, id: lessonId, modality: 'IN_PERSON', hasAssessment: false,
	enabled: true, effectiveRoomId: classId, topics: [topic] };

describe('Lessons — snapshot OpenAPI offline', () => {
	const ajv = new Ajv({ strict: false, allErrors: true });
	addFormats(ajv);
	ajv.addSchema(browser, origin + 'openapi.json');
	ajv.addSchema(domain, origin + 'domains/lessons.openapi.json');
	const schema = (name: string) => ajv.compile({ $ref: `${origin}domains/lessons.openapi.json#/components/schemas/${name}` });

	it('documenta exatamente os cinco paths e as 13 operações do proxy', () => {
		expect(Object.keys(browser.paths).filter(path => path.startsWith('/api/v1/lessons'))).toEqual(Object.keys(expected));
		let count = 0;
		for (const [path, operations] of Object.entries(expected)) {
			const item = browser.paths[path];
			expect(methods.filter(method => item[method])).toEqual(methods.filter(method => operations.includes(method)));
			for (const method of operations) {
				count++;
				expect(item[method].operationId).toBe(domain.paths[path.slice('/api/v1'.length)][method].operationId);
				expect(Object.keys(item[method].responses)).toEqual(Object.keys(domain.paths[path.slice('/api/v1'.length)][method].responses));
				expect(item[method].security).toEqual([{ bearerAuth: [] }, { bffSession: [] }]);
				expect(item[method].servers).toBeUndefined();
			}
			expect(item.servers).toBeUndefined();
		}
		expect(count).toBe(13);
		expect(browser.servers).toEqual([{ url: 'http://localhost:8180' }]);
		expect(browser.paths['/api/v1/health']).toBeUndefined();
		expect(browser.components.securitySchemes.bffSession.name).toBe('closed_cras_session');
	});

	it('resolve os schemas de escrita e leitura pelos paths públicos da BFF', () => {
		const path = '/api/v1/lessons'.replaceAll('/', '~1');
		const write = ajv.compile({ $ref: `${origin}openapi.json#/paths/${path}/post/requestBody/content/application~1json/schema` });
		const read = ajv.compile({ $ref: `${origin}openapi.json#/paths/${path}/get/responses/200/content/application~1json/schema` });
		expect(write(create)).toBe(true);
		expect(write({ ...create, timeSlotId: 'JK' })).toBe(false);
		expect(read([lesson])).toBe(true);
		expect(read({ items: [lesson] })).toBe(false);
	});

	it('aceita criação com tópicos e recusa campos derivados ou faixas inválidas', () => {
		const validate = schema('LessonCreate');
		expect(validate({ ...create, topics: [{ order: 1, statement: 'Plano da aula' }] })).toBe(true);
		expect(validate({ ...create, effectiveRoomId: classId })).toBe(false);
		expect(validate({ ...create, timeSlotId: 'O' })).toBe(false);
		expect(validate({ ...create, date: '2026-02-30' })).toBe(false);
	});

	it('distingue PUT e PATCH e protege os campos imutáveis', () => {
		expect(schema('LessonUpdate')({ modality: 'REMOTE', hasAssessment: false })).toBe(true);
		expect(schema('LessonUpdate')({ modality: 'REMOTE' })).toBe(false);
		expect(schema('LessonPatch')({ hasAssessment: true })).toBe(true);
		expect(schema('LessonPatch')({})).toBe(false);
		expect(schema('LessonPatch')({ classId })).toBe(false);
		expect(schema('LessonPatch')({ hasAssessment: null })).toBe(false);
	});

	it('exige sala em aula presencial e omite sala na aula remota', () => {
		const validate = schema('Lesson');
		const { effectiveRoomId: _room, ...withoutRoom } = lesson;
		expect(validate(lesson)).toBe(true);
		expect(validate(withoutRoom)).toBe(false);
		expect(validate({ ...withoutRoom, modality: 'REMOTE' })).toBe(true);
		expect(validate({ ...lesson, modality: 'REMOTE' })).toBe(false);
	});

	it('valida tópicos, ordem e listas sem envelope', () => {
		expect(schema('LessonTopicCreate')({ order: 1, statement: 'Conteúdo' })).toBe(true);
		expect(schema('LessonTopicCreate')({ order: 1 })).toBe(false);
		expect(schema('LessonTopicCreate')({ order: 0, statement: 'Conteúdo' })).toBe(false);
		expect(schema('LessonTopicCreate')({ order: 32768, statement: 'Conteúdo' })).toBe(false);
		expect(schema('LessonTopicList')([topic])).toBe(true);
		expect(schema('LessonTopicList')({ items: [topic] })).toBe(false);
	});

	it('valida geração e os schemas de resposta referenciados no browser', () => {
		expect(schema('LessonGenerate')({ classId })).toBe(true);
		expect(schema('LessonGenerate')({})).toBe(false);
		expect(schema('LessonGenerate')({ classId, date: create.date })).toBe(false);
		for (const name of Object.keys(domain.components.schemas)) {
			expect(() => schema(name)).not.toThrow();
		}
	});

	it('o LE-503 produzido pelo serviço BFF respeita o contrato de Lessons', async () => {
		const downstream = { send: async () => { throw new DownstreamUnavailableError('lessons', 'offline'); } } as unknown as DownstreamService;
		const response = await new LessonsService(downstream).forward({ method: 'GET', path: '/api/v1/lessons' });
		expect(response.status).toBe(503);
		expect(response.contentType).toBe('application/json');
		expect(schema('ApiError')(JSON.parse(response.body))).toBe(true);
		expect(schema('ApiError')({ error_code: 'LE-503' })).toBe(false);
	});
});
