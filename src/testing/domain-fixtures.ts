export const COURSE_ID = '11111111-1111-4111-8111-111111111111';
export const course = {
	id: COURSE_ID, enabled: true, code: 'SW101', name: 'Software', syllabus: 'Construction', workloadHours: 60,
	bibliographicReferences: [{ id: '22222222-2222-4222-8222-222222222222', enabled: true, courseId: COURSE_ID, title: 'Software', authors: 'Author', type: 'BASIC' }],
	syllabusItems: [],
};
export const RESOURCE_ID = '66666666-6666-4666-8666-666666666666';
export const OCCURRENCE_ID = '77777777-7777-4777-8777-777777777777';
export const ACTOR_ID = '88888888-8888-4888-8888-888888888888';
export const resource = {
	id: RESOURCE_ID, enabled: true, code: 'PROJ-01', name: 'Projector 1', type: 'PROJECTOR',
	active: true, tags: ['av', 'portable'], createdAt: '2026-11-01T12:00:00Z', updatedAt: '2026-11-01T12:00:00Z',
};
export const occurrence = {
	id: OCCURRENCE_ID, resourceId: RESOURCE_ID, description: 'Lamp does not turn on', type: 'MALFUNCTION',
	priority: 'MEDIUM', status: 'OPEN', enabled: true, resolution: null, reportedBy: ACTOR_ID,
	resolvedBy: null, createdAt: '2026-11-02T12:00:00Z', resolvedAt: null, updatedAt: '2026-11-02T12:00:00Z',
};
export const resolvedOccurrence = {
	...occurrence, status: 'RESOLVED', resolution: 'Lamp replaced', resolvedBy: ACTOR_ID,
	resolvedAt: '2026-11-03T12:00:00Z', updatedAt: '2026-11-03T12:00:00Z',
};
export const resourceAggregate = { ...resource, occurrences: [occurrence] };
export const RESERVATION_ID = '99999999-9999-4999-8999-999999999999';
export const PAST_RESERVATION_ID = '99999999-9999-4999-8999-999999999998';
export const OTHER_RESOURCE_RESERVATION_ID = '99999999-9999-4999-8999-999999999997';
export const LESSON_ID = '30000000-0000-4000-8000-000000000001';
export const PROFESSOR_ID = '55555555-5555-4555-8555-555555555555';
export const futureReservation = {
	id: RESERVATION_ID, professorId: PROFESSOR_ID, lessonId: LESSON_ID,
	data: '2026-11-25', faixaId: 'F', resourceIds: [RESOURCE_ID], status: 'ACTIVE', enabled: true,
	createdAt: '2026-11-01T12:00:00Z', updatedAt: '2026-11-01T12:00:00Z',
};
export const pastReservation = {
	...futureReservation, id: PAST_RESERVATION_ID, data: '2026-11-25', faixaId: 'A',
};
export const otherResourceReservation = {
	...futureReservation, id: OTHER_RESOURCE_RESERVATION_ID, resourceIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
};
export const currentClass = {
	id: '33333333-3333-4333-8333-333333333333', enabled: true, courseId: COURSE_ID,
	startDate: '2026-08-01', endDate: '2026-12-20', year: 2026, semester: 2, seats: 30,
	roomId: '44444444-4444-4444-8444-444444444444', professorId: '55555555-5555-4555-8555-555555555555',
	studentIds: [], status: 'active', averageRating: null,
};
