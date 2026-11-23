import { CircuitBreaker, CircuitOpenError } from './circuit-breaker';

/**
 * O AD-10 põe o disjuntor como invariante, não como detalhe de lib. Estes testes fixam o
 * comportamento que a invariante exige, para que trocar a implementação por `@nestjs/resilience`
 * (ou qualquer outra) continue sendo possível sem mudar o contrato.
 */
describe('CircuitBreaker', () => {
	const options = {
		name: 'rooms',
		errorThresholdPercentage: 50,
		resetTimeoutMs: 10_000,
		volumeThreshold: 4,
		rollingWindowMs: 10_000,
	};

	const fail = () => Promise.reject(new Error('downstream caiu'));
	const ok = () => Promise.resolve('ok');

	async function swallow(promise: Promise<unknown>): Promise<unknown> {
		return promise.catch((error: unknown) => error);
	}

	it('deixa passar enquanto o volume mínimo não é atingido', async () => {
		const breaker = new CircuitBreaker(options);

		for (let i = 0; i < 3; i++) {
			await swallow(breaker.run(fail));
		}

		expect(breaker.currentState()).toBe('closed');
	});

	it('abre quando o percentual de erro é atingido depois do volume mínimo', async () => {
		const breaker = new CircuitBreaker(options);

		for (let i = 0; i < 4; i++) {
			await swallow(breaker.run(fail));
		}

		expect(breaker.currentState()).toBe('open');
	});

	it('com o circuito aberto, recusa sem chamar o downstream', async () => {
		const breaker = new CircuitBreaker(options);
		for (let i = 0; i < 4; i++) {
			await swallow(breaker.run(fail));
		}

		const call = jest.fn(ok);
		await expect(breaker.run(call)).rejects.toBeInstanceOf(CircuitOpenError);
		expect(call).not.toHaveBeenCalled();
	});

	it('não abre quando a maioria das chamadas tem sucesso', async () => {
		const breaker = new CircuitBreaker(options);

		await breaker.run(ok);
		await breaker.run(ok);
		await breaker.run(ok);
		await swallow(breaker.run(fail));

		expect(breaker.currentState()).toBe('closed');
	});

	it('passa a half-open depois do reset e fecha com um sucesso', async () => {
		const breaker = new CircuitBreaker(options);
		let now = 1_000;
		const clock = () => now;

		for (let i = 0; i < 4; i++) {
			await swallow(breaker.run(fail, clock));
		}
		expect(breaker.currentState(now)).toBe('open');

		now += options.resetTimeoutMs;
		expect(breaker.currentState(now)).toBe('half-open');

		await breaker.run(ok, clock);
		expect(breaker.currentState(now)).toBe('closed');
	});

	it('uma falha em half-open reabre o circuito', async () => {
		const breaker = new CircuitBreaker(options);
		let now = 1_000;
		const clock = () => now;

		for (let i = 0; i < 4; i++) {
			await swallow(breaker.run(fail, clock));
		}
		now += options.resetTimeoutMs;
		expect(breaker.currentState(now)).toBe('half-open');

		await swallow(breaker.run(fail, clock));
		expect(breaker.currentState(now)).toBe('open');
	});

	it('esquece falhas antigas ao sair da janela deslizante', async () => {
		const breaker = new CircuitBreaker(options);
		let now = 1_000;
		const clock = () => now;

		for (let i = 0; i < 3; i++) {
			await swallow(breaker.run(fail, clock));
		}

		now += options.rollingWindowMs + 1;
		await swallow(breaker.run(fail, clock));

		expect(breaker.currentState(now)).toBe('closed');
	});
});
