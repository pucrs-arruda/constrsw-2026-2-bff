/**
 * Disjuntor por downstream, exigido pelo AD-10 (todo hop BFF→domínio aplica timeout +
 * circuit breaker).
 *
 * A spine lista `@nestjs/resilience` como *seed*, não como obrigação: "Libs na Stack são seed;
 * o comportamento é a invariante". Implementado aqui para não acoplar a invariante a um pacote
 * de terceiros — são ~80 linhas e o compose já entrega todos os parâmetros por env.
 *
 * Estados:
 * - `closed`   — deixa passar; conta falhas numa janela deslizante.
 * - `open`     — recusa na hora (sem chamar o downstream) até `resetTimeoutMs`.
 * - `half-open`— deixa passar **uma** tentativa: sucesso fecha, falha reabre.
 *
 * O disjuntor só abre depois de `volumeThreshold` chamadas na janela, para que duas falhas num
 * serviço ocioso não derrubem o circuito.
 */
export interface CircuitBreakerOptions {
	/** Nome do downstream, usado em log e mensagem de erro. */
	readonly name: string;
	/** Percentual de erro na janela que abre o circuito. */
	readonly errorThresholdPercentage: number;
	/** Quanto tempo o circuito fica aberto antes de tentar de novo. */
	readonly resetTimeoutMs: number;
	/** Chamadas mínimas na janela antes de o percentual valer. */
	readonly volumeThreshold: number;
	/** Tamanho da janela deslizante. */
	readonly rollingWindowMs: number;
}

export class CircuitOpenError extends Error {
	constructor(readonly downstream: string) {
		super(`Circuito aberto para ${downstream}`);
		this.name = 'CircuitOpenError';
	}
}

type State = 'closed' | 'open' | 'half-open';

interface Outcome {
	readonly at: number;
	readonly failed: boolean;
}

export class CircuitBreaker {
	private state: State = 'closed';
	private outcomes: Outcome[] = [];
	private openedAt = 0;
	private halfOpenInFlight = false;

	constructor(private readonly options: CircuitBreakerOptions) {}

	/** Para log e para o teste: o estado corrente, já considerando a passagem do tempo. */
	currentState(now: number = Date.now()): State {
		if (this.state === 'open' && now - this.openedAt >= this.options.resetTimeoutMs) {
			this.state = 'half-open';
			this.halfOpenInFlight = false;
		}
		return this.state;
	}

	/**
	 * Executa `call` sob o disjuntor. Lança {@link CircuitOpenError} sem tocar no downstream
	 * quando o circuito está aberto.
	 */
	async run<T>(call: () => Promise<T>, now: () => number = Date.now): Promise<T> {
		const state = this.currentState(now());

		if (state === 'open') {
			throw new CircuitOpenError(this.options.name);
		}
		if (state === 'half-open') {
			if (this.halfOpenInFlight) {
				throw new CircuitOpenError(this.options.name);
			}
			this.halfOpenInFlight = true;
		}

		try {
			const result = await call();
			this.onSuccess(now());
			return result;
		}
		catch (error) {
			this.onFailure(now());
			throw error;
		}
	}

	private onSuccess(now: number): void {
		if (this.state === 'half-open') {
			this.reset();
			return;
		}
		this.record(now, false);
	}

	private onFailure(now: number): void {
		if (this.state === 'half-open') {
			this.trip(now);
			return;
		}
		this.record(now, true);
		this.evaluate(now);
	}

	private record(now: number, failed: boolean): void {
		this.outcomes.push({ at: now, failed });
		this.prune(now);
	}

	private prune(now: number): void {
		const floor = now - this.options.rollingWindowMs;
		this.outcomes = this.outcomes.filter((outcome) => outcome.at > floor);
	}

	private evaluate(now: number): void {
		this.prune(now);
		if (this.outcomes.length < this.options.volumeThreshold) {
			return;
		}
		const failures = this.outcomes.filter((outcome) => outcome.failed).length;
		const percentage = (failures / this.outcomes.length) * 100;
		if (percentage >= this.options.errorThresholdPercentage) {
			this.trip(now);
		}
	}

	private trip(now: number): void {
		this.state = 'open';
		this.openedAt = now;
		this.halfOpenInFlight = false;
		this.outcomes = [];
	}

	private reset(): void {
		this.state = 'closed';
		this.openedAt = 0;
		this.halfOpenInFlight = false;
		this.outcomes = [];
	}
}
