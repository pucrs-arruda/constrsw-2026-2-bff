/**
 * Semestre em curso, como o contrato do BFF (`docs/open-api/bff.yaml`) define para a composição
 * de leitura T3:
 *
 * - calculado no fuso **America/Sao_Paulo**, não no fuso do container;
 * - `year` é o ano civil atual;
 * - `semester` é 1 quando o mês é anterior a agosto e 2 quando o mês é agosto ou posterior.
 *
 * Compartilhado: students, courses, professors e rooms usam a mesma regra para filtrar classes.
 */
export interface AcademicSemester {
	readonly year: number;
	readonly semester: 1 | 2;
}

const TIME_ZONE = 'America/Sao_Paulo';

/** Mês de agosto, a partir do qual o semestre é o 2. */
const SECOND_SEMESTER_FIRST_MONTH = 8;

export function currentSemester(now: Date = new Date()): AcademicSemester {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: TIME_ZONE,
		year: 'numeric',
		month: 'numeric',
	}).formatToParts(now);

	const year = Number(parts.find((part) => part.type === 'year')?.value);
	const month = Number(parts.find((part) => part.type === 'month')?.value);

	return { year, semester: month < SECOND_SEMESTER_FIRST_MONTH ? 1 : 2 };
}
