export const COURSE_ID = '11111111-1111-4111-8111-111111111111';
export const course = {
	id: COURSE_ID, enabled: true, code: 'SW101', name: 'Software', syllabus: 'Construction', workloadHours: 60,
	bibliographicReferences: [{ id: '22222222-2222-4222-8222-222222222222', enabled: true, courseId: COURSE_ID, title: 'Software', authors: 'Author', type: 'BASIC' }],
	syllabusItems: [],
};
export const currentClass = {
	id: '33333333-3333-4333-8333-333333333333', enabled: true, courseId: COURSE_ID,
	startDate: '2026-08-01', endDate: '2026-12-20', year: 2026, semester: 2, seats: 30,
	roomId: '44444444-4444-4444-8444-444444444444', professorId: '55555555-5555-4555-8555-555555555555',
	studentIds: [], status: 'active', averageRating: null,
};
