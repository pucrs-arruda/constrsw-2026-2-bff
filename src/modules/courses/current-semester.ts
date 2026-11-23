const calendar = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: 'numeric' });

export function currentSemester(date: Date): { year: number; semester: number } {
	const parts = calendar.formatToParts(date);
	const year = Number(parts.find(part => part.type === 'year')!.value);
	const month = Number(parts.find(part => part.type === 'month')!.value);
	return { year, semester: month < 8 ? 1 : 2 };
}
