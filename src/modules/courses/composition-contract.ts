import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

// Only composed reads require validation here. Writes and domain refusals remain proxies.
const validator = new Ajv({ strict: false, allErrors: false });
addFormats(validator);
for (const domain of ['courses', 'classes']) {
	const document = JSON.parse(readFileSync(join(__dirname, '../../../openapi/domains', `${domain}.openapi.json`), 'utf8'));
	validator.addSchema(document, `https://bff.invalid/domains/${domain}.openapi.json`);
}
export const validCourse = validator.compile({ $ref: 'https://bff.invalid/domains/courses.openapi.json#/components/schemas/Course' });
export const validClass = validator.compile({ $ref: 'https://bff.invalid/domains/classes.openapi.json#/components/schemas/Class' });
