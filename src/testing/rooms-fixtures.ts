import { randomUUID } from 'node:crypto';
import { currentClass } from './domain-fixtures';

const room = {
	id: '3f6c2b1e-8a4d-4c1f-9e2b-7d5a6c4b3a21',
	code: '32/405',
	name: 'Laboratório de Engenharia de Software',
	building: '32',
	capacity: 40 as number | null,
	active: true,
	enabled: true,
	resourceIds: [] as string[],
};

export const roomFixture = (overrides: Partial<typeof room> = {}) => ({ ...room, ...overrides });
export const classFixture = (overrides: Partial<typeof currentClass> = {}) => ({
	...currentClass, id: randomUUID(), roomId: room.id, ...overrides,
});

export const roomList = (...overrides: Partial<typeof room>[]) =>
	overrides.map(item => roomFixture({ id: randomUUID(), ...item }));
export const classList = (...overrides: Partial<typeof currentClass>[]) => overrides.map(classFixture);
