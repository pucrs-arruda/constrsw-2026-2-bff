import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { course, currentClass } from './testing/domain-fixtures';

describe('offline Courses BFF schemas', () => {
	const ajv = new Ajv({ strict: false, allErrors: true }); addFormats(ajv);
	for (const name of ['openapi.json', 'domains/courses.openapi.json', 'domains/classes.openapi.json']) {
		ajv.addSchema(JSON.parse(readFileSync(join(__dirname, '..', 'openapi', name), 'utf8')), `https://bff.invalid/${name}`);
	}
	it('accepts a complete composed CourseView with the closed domain properties', () => {
		const validate = ajv.compile({ $ref: 'https://bff.invalid/openapi.json#/components/schemas/CourseView' });
		expect(validate({ ...course, classes: [currentClass] })).toBe(true);
	});
	it('validates the proxy Course and ApiError payloads', () => {
		const validateCourse = ajv.compile({ $ref: 'https://bff.invalid/domains/courses.openapi.json#/components/schemas/Course' });
		expect(validateCourse(course)).toBe(true);
		const validateError = ajv.compile({ $ref: 'https://bff.invalid/domains/courses.openapi.json#/components/schemas/ApiError' });
		expect(validateError({ error_code: 'CO-503', error_description: 'Dependency unavailable', error_source: 'BFF', error_stack: [] })).toBe(true);
		expect(validateError({ error_code: 'CO-503' })).toBe(false);
	});
});
