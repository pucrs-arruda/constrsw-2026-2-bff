import { ConfigService } from '@nestjs/config';

import { reservationsDownstream, resourcesDownstream } from './resources.module';

function config(values: Record<string, string | undefined>): ConfigService {
	return {
		get: (name: string, fallback?: unknown) => values[name] ?? fallback,
	} as unknown as ConfigService;
}

describe('configuração do módulo resources', () => {
	it('usa o default do compose quando a URL não é informada', () => {
		expect(() => resourcesDownstream(config({}))).not.toThrow();
	});

	it.each(['', '   '])('rejeita RESOURCES_BASE_URL em branco (%j)', value => {
		expect(() => resourcesDownstream(config({ RESOURCES_BASE_URL: value })))
			.toThrow('Invalid BFF configuration: RESOURCES_BASE_URL');
	});

	it('rejeita RESOURCES_BASE_URL com path', () => {
		expect(() => resourcesDownstream(config({ RESOURCES_BASE_URL: 'http://resources:8106/api' })))
			.toThrow('Invalid BFF configuration: RESOURCES_BASE_URL');
	});

	it('rejeita BFF_HTTP_TIMEOUT_MS que não é inteiro', () => {
		expect(() => resourcesDownstream(config({ RESOURCES_BASE_URL: 'http://resources:8106', BFF_HTTP_TIMEOUT_MS: 'tres' })))
			.toThrow('Invalid BFF configuration: BFF_HTTP_TIMEOUT_MS');
	});

	it('usa o default do compose para reservations quando a URL não é informada', () => {
		expect(() => reservationsDownstream(config({}))).not.toThrow();
	});

	it.each(['', '   '])('rejeita RESERVATIONS_BASE_URL em branco (%j)', value => {
		expect(() => reservationsDownstream(config({ RESERVATIONS_BASE_URL: value })))
			.toThrow('Invalid BFF configuration: RESERVATIONS_BASE_URL');
	});

	it('rejeita RESERVATIONS_BASE_URL com path', () => {
		expect(() => reservationsDownstream(config({ RESERVATIONS_BASE_URL: 'http://reservations:8109/api' })))
			.toThrow('Invalid BFF configuration: RESERVATIONS_BASE_URL');
	});
});
