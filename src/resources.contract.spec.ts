import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

import {
	futureReservation,
	occurrence,
	resolvedOccurrence,
	resource,
	resourceAggregate,
} from './testing/domain-fixtures';
import { unavailable } from './modules/resources/resources.service';

describe('offline Resources BFF schemas', () => {
	const ajv = new Ajv({ strict: false, allErrors: true }); addFormats(ajv);
	for (const name of ['openapi.json', 'domains/resources.openapi.json']) {
		ajv.addSchema(JSON.parse(readFileSync(join(__dirname, '..', 'openapi', name), 'utf8')), `https://bff.invalid/${name}`);
	}
	const browser = (name: string) => ajv.compile({ $ref: `https://bff.invalid/openapi.json#/components/schemas/${name}` });
	const domain = (name: string) => ajv.compile({ $ref: `https://bff.invalid/domains/resources.openapi.json#/components/schemas/${name}` });

	it('accepts the domain Resource, ResourceAggregate and Occurrence snapshots', () => {
		expect(domain('Resource')(resource)).toBe(true);
		expect(domain('ResourceAggregate')(resourceAggregate)).toBe(true);
		expect(domain('Occurrence')(occurrence)).toBe(true);
		expect(domain('Occurrence')(resolvedOccurrence)).toBe(true);
	});

	it('validates a composed ResourceSummary with openOccurrenceCount and reservations', () => {
		const { enabled: _enabled, ...summary } = resource;
		expect(browser('ResourceSummary')({ ...summary, openOccurrenceCount: 1, reservations: [] })).toBe(true);
		expect(browser('ResourceSummary')({ ...summary, openOccurrenceCount: 0, reservations: [futureReservation] })).toBe(true);
		expect(browser('ResourceSummary')({ ...summary, openOccurrenceCount: -1, reservations: [] })).toBe(false);
		expect(browser('ResourceSummary')({ ...summary, openOccurrenceCount: 0 })).toBe(false);
	});

	it('validates the FutureReservations array against the Reservation schema', () => {
		expect(browser('FutureReservations')([])).toBe(true);
		expect(browser('FutureReservations')([futureReservation])).toBe(true);
		expect(browser('FutureReservations')([{ ...futureReservation, faixaId: 'O' }])).toBe(false);
		expect(browser('FutureReservations')([{ ...futureReservation, resourceIds: [] }])).toBe(false);
	});

	it('rejects domain-only enabled in browser payloads', () => {
		expect(browser('ResourceSummary')({ ...resource, openOccurrenceCount: 1, reservations: [] })).toBe(false);
		expect(browser('Resource')({ ...resource, openOccurrenceCount: 1, reservations: [], occurrences: [] })).toBe(false);
		expect(browser('Occurrence')(occurrence)).toBe(false);
	});

	it('validates a composed Resource with a bare occurrences array', () => {
		const { enabled: _enabled, occurrences, ...master } = resourceAggregate;
		const items = occurrences.map(({ enabled: _occurrenceEnabled, ...rest }) => rest);
		expect(browser('Resource')({ ...master, openOccurrenceCount: 1, reservations: [futureReservation], occurrences: items })).toBe(true);
		expect(browser('Resource')({ ...master, openOccurrenceCount: 0, reservations: [], occurrences: [] })).toBe(true);
		expect(browser('Resource')({ ...master, openOccurrenceCount: 0, reservations: [], occurrences: { items: [] } })).toBe(false);
	});

	it('validates the bare ResourceList array', () => {
		const { enabled: _enabled, ...summary } = resource;
		expect(browser('ResourceList')([{ ...summary, openOccurrenceCount: 0, reservations: [] }])).toBe(true);
		expect(browser('ResourceList')({ items: [] })).toBe(false);
	});

	it('validates the BFF 503 Problem envelope', () => {
		expect(browser('Problem')(JSON.parse(unavailable('/api/v1/resources').body))).toBe(true);
	});

	it('declares the browser session security scheme and the resources operations', () => {
		const document = JSON.parse(readFileSync(join(__dirname, '..', 'openapi', 'openapi.json'), 'utf8'));
		expect(document.components.securitySchemes.bffSession).toMatchObject({ type: 'apiKey', in: 'cookie', name: 'cras_session' });
		const paths = Object.keys(document.paths).filter(name => name.startsWith('/api/v1/resources'));
		expect(paths).toEqual([
			'/api/v1/resources',
			'/api/v1/resources/{resourceId}',
			'/api/v1/resources/{resourceId}/occurrences',
			'/api/v1/resources/{resourceId}/occurrences/{occurrenceId}',
		]);
		for (const path of paths) {
			expect(document.paths[path].servers).toEqual([{ url: 'http://localhost:8088', description: 'Local compose BFF' }]);
		}
	});
});
