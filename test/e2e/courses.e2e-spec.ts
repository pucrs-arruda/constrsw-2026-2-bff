import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { currentSemester, http, setting, urls, waitForBff } from './support/e2e-env';

/**
 * Group 05 contribution to the shared runner: real BFF -> Courses + Classes,
 * authenticated by the real Keycloak. No in-process Nest app or HTTP fixtures.
 * Run: npm run test:e2e:courses. E2E_DOCKER=1 also checks Classes downtime.
 */
jest.setTimeout(120_000);

const COURSES = '/api/v1/courses';
const CLASSES = '/api/v1/classes';
const ids = (items: Array<{ id: string }>) => items.map(item => item.id).sort();

describe('BFF Courses — shared end-to-end runner', () => {
	let token: string, bff: string, coursesUrl: string, classesUrl: string;
	let courseId: string, otherCourseId: string, emptyCourseId: string;
	let createdCourse: any, referenceId: string, syllabusItemId: string;
	let currentClassId: string, otherCourseClassId: string, pastYearClassId: string, otherSemesterClassId: string, disabledClassId: string;
	const createdCourseIds = new Set<string>();
	const createdClassIds = new Set<string>();
	const { year, semester } = currentSemester();
	const stamp = randomUUID().slice(0, 10);
	const payload = {
		code: `BFF-${stamp}`, name: `Courses E2E ${stamp}`, syllabus: 'Shared runner verification', workloadHours: 60,
		bibliographicReferences: [
			{ title: 'Software Construction', authors: 'E2E Author', type: 'BASIC' },
			{ title: 'HTTP Contracts', authors: 'E2E Author', type: 'SUPPLEMENTARY' },
		],
	};
	const target = () => `${COURSES}/${courseId}`;
	const call = (method: string, suffix: string, body?: unknown) => http(method, `${bff}${suffix}`, { token, body });

	beforeAll(async () => {
		bff = urls.bff(); coursesUrl = urls.context('courses', '8183'); classesUrl = urls.context('classes', '8182');
		await waitForBff();
		await waitForDomains();
		// Courses introspects tokens through OAuth. Obtain the token through that
		// real login flow so Keycloak's internal/external hostnames do not change iss.
		const login = await http('POST', `${urls.context('oauth', '8181')}/login`, { body: {
			username: setting('E2E_USERNAME', 'admin@pucrs.br'), password: setting('E2E_PASSWORD', 'a12345678'),
		} });
		expect(login.status).toBe(201); expect(login.body.access_token).toEqual(expect.any(String));
		token = login.body.access_token;
		createdCourse = await createCourse(payload);
		courseId = createdCourse.id;
		otherCourseId = (await createCourse({ ...payload, code: `${payload.code}-B` })).id;
		emptyCourseId = (await createCourse({ ...payload, code: `${payload.code}-C` })).id;
		currentClassId = await createClass(courseId, year, semester);
		otherCourseClassId = await createClass(otherCourseId, year, semester);
		pastYearClassId = await createClass(courseId, year - 1, semester);
		otherSemesterClassId = await createClass(courseId, year, semester === 1 ? 2 : 1);
		disabledClassId = await createClass(courseId, year, semester);
		const removed = await http('DELETE', `${classesUrl}${CLASSES}/${disabledClassId}`, { token });
		expect(removed.status).toBe(204);
	});

	afterAll(async () => {
		const failures: string[] = [];
		for (const id of createdClassIds) {
			try {
				const result = await http('DELETE', `${classesUrl}${CLASSES}/${id}`, { token });
				if (![204, 404].includes(result.status)) failures.push(`Classes cleanup: HTTP ${result.status}`);
			} catch { failures.push('Classes cleanup: connection failed'); }
		}
		for (const id of createdCourseIds) {
			try {
				const result = await http('DELETE', `${coursesUrl}${COURSES}/${id}`, { token });
				if (![204, 404].includes(result.status)) failures.push(`Courses cleanup: HTTP ${result.status}`);
			} catch { failures.push('Courses cleanup: connection failed'); }
		}
		if (failures.length) throw new Error(failures.join('; '));
	});

	async function createCourse(body: typeof payload): Promise<any> {
		const result = await call('POST', COURSES, body);
		expect(result.status).toBe(201);
		expect(result.body.id).toEqual(expect.any(String));
		createdCourseIds.add(result.body.id);
		return result.body;
	}

	async function waitForDomains(): Promise<void> {
		const deadline = Date.now() + 60_000;
		while (Date.now() < deadline) {
			const results = await Promise.all([coursesUrl, classesUrl].map(url => http('GET', `${url}/api/v1/health`).catch(() => undefined)));
			if (results.every(result => result?.status === 200)) return;
			await new Promise(resolve => setTimeout(resolve, 1000));
		}
		throw new Error('Courses or Classes did not become healthy before E2E setup.');
	}

	async function createClass(link: string, classYear: number, classSemester: number): Promise<string> {
		const [start, end] = classSemester === 1 ? ['03-01', '07-15'] : ['08-01', '12-15'];
		const result = await http('POST', `${classesUrl}${CLASSES}`, { token, body: {
			courseId: link, roomId: setting('E2E_ROOM_ID', randomUUID()), professorId: setting('E2E_PROFESSOR_ID', randomUUID()),
			startDate: `${classYear}-${start}`, endDate: `${classYear}-${end}`, year: classYear, semester: classSemester,
			seats: 30, studentIds: [], code: `BFF-${stamp}-${createdClassIds.size}`, label: 'Courses BFF E2E',
		} });
		expect(result.status).toBe(201);
		expect(result.body.id).toEqual(expect.any(String));
		createdClassIds.add(result.body.id);
		return result.body.id;
	}

	it('serves anonymous health', async () => {
		const result = await http('GET', `${bff}/health`);
		expect(result.status).toBe(200); expect(result.body).toEqual({ status: 'UP' });
	});
	it('POST returns the real Course without composition', async () => {
		expect(createdCourse).toMatchObject({ code: payload.code, name: payload.name, workloadHours: 60, enabled: true });
		expect(createdCourse.bibliographicReferences).toHaveLength(2);
		expect(createdCourse).not.toHaveProperty('classes');
		const direct = await http('GET', `${coursesUrl}${target()}`, { token });
		expect(direct.status).toBe(200); expect(direct.body).toEqual(createdCourse);
	});
	it('GET item preserves every domain field and adds only its current-semester Classes', async () => {
		const [viaBff, direct] = await Promise.all([call('GET', target()), http('GET', `${coursesUrl}${target()}`, { token })]);
		expect(viaBff.status).toBe(200); expect(direct.status).toBe(200);
		const { classes, ...rest } = viaBff.body;
		expect(rest).toEqual(direct.body); expect(ids(classes)).toEqual([currentClassId]);
	});
	it('excludes other-course, past-year, other-semester and deleted Classes', async () => {
		const result = await call('GET', target()); expect(result.status).toBe(200);
		const linked = ids(result.body.classes);
		for (const excluded of [otherCourseClassId, pastYearClassId, otherSemesterClassId, disabledClassId]) expect(linked).not.toContain(excluded);
		for (const item of result.body.classes) expect(item).toMatchObject({ courseId, year, semester, enabled: true });
	});
	it('matches the direct Classes query for the same year, semester and Course', async () => {
		const [viaBff, direct] = await Promise.all([call('GET', target()), http('GET', `${classesUrl}${CLASSES}?year=${year}&semester=${semester}`, { token })]);
		expect(viaBff.status).toBe(200); expect(direct.status).toBe(200);
		const expected = direct.body.filter((item: any) => item.courseId === courseId && item.enabled && item.year === year && item.semester === semester);
		expect(ids(viaBff.body.classes)).toEqual(ids(expected));
	});
	it('GET collection preserves filters and the domain data while adding Classes', async () => {
		const query = `?code=${encodeURIComponent(payload.code)}`;
		const [viaBff, direct] = await Promise.all([call('GET', COURSES + query), http('GET', `${coursesUrl}${COURSES}${query}`, { token })]);
		expect(viaBff.status).toBe(200); expect(direct.status).toBe(200); expect(viaBff.body).toHaveLength(1);
		const { classes, ...rest } = viaBff.body[0];
		expect(rest).toEqual(direct.body[0]); expect(ids(classes)).toEqual([currentClassId]);
	});
	it('returns classes:[] for a real Course with no Classes', async () => {
		const result = await call('GET', `${COURSES}/${emptyCourseId}`);
		expect(result.status).toBe(200); expect(result.body.classes).toEqual([]);
	});
	it.each([COURSES, () => target()])('propagates 401 without credentials for %s', async suffix => {
		const result = await http('GET', `${bff}${typeof suffix === 'function' ? suffix() : suffix}`);
		expect(result.status).toBe(401); expect(result.body.error_code).toBe('CO-401');
	});
	it('propagates the exact domain 404 without partial composition', async () => {
		const suffix = `${COURSES}/${randomUUID()}`;
		const [viaBff, direct] = await Promise.all([call('GET', suffix), http('GET', `${coursesUrl}${suffix}`, { token })]);
		expect(viaBff.status).toBe(404); expect(direct.status).toBe(404); expect(viaBff.body).toEqual(direct.body);
	});
	it('propagates 400 for an empty PATCH instead of consuming the payload', async () => {
		const [viaBff, direct] = await Promise.all([call('PATCH', target(), {}), http('PATCH', `${coursesUrl}${target()}`, { token, body: {} })]);
		expect(viaBff.status).toBe(400); expect(direct.status).toBe(400); expect(viaBff.body).toEqual(direct.body);
	});
	it('propagates the domain conflict for a duplicate code', async () => {
		const result = await call('POST', COURSES, payload);
		expect(result.status).toBe(409); expect(result.body.error_code).toBe('CO-409');
	});
	it('PUT replaces only mutable Course scalars and returns no classes', async () => {
		const result = await call('PUT', target(), { code: payload.code, name: `${payload.name} replaced`, workloadHours: 80, syllabus: 'Updated' });
		expect(result.status).toBe(200); expect(result.body.workloadHours).toBe(80); expect(result.body).not.toHaveProperty('classes');
		expect(result.body.bibliographicReferences).toEqual(createdCourse.bibliographicReferences);
		const direct = await http('GET', `${coursesUrl}${target()}`, { token }); expect(result.body).toEqual(direct.body);
	});
	it('PATCH returns the domain Course without classes', async () => {
		const result = await call('PATCH', target(), { name: `${payload.name} patched` });
		expect(result.status).toBe(200); expect(result.body.name).toBe(`${payload.name} patched`); expect(result.body).not.toHaveProperty('classes');
	});

	describe('bibliographic references remain proxies', () => {
		it('GET collection matches Courses directly', async () => {
			const suffix = `${target()}/bibliographic-references`;
			const [viaBff, direct] = await Promise.all([call('GET', suffix), http('GET', `${coursesUrl}${suffix}`, { token })]);
			expect(viaBff.status).toBe(200); expect(viaBff.body).toEqual(direct.body);
		});
		it('POST creates a reference', async () => {
			const result = await call('POST', `${target()}/bibliographic-references`, { title: 'New reference', authors: 'E2E Author', type: 'SUPPLEMENTARY' });
			expect(result.status).toBe(201); referenceId = result.body.id;
			expect(result.body).toMatchObject({ courseId, title: 'New reference', enabled: true }); expect(result.body).not.toHaveProperty('classes');
		});
		it('GET item matches Courses directly', async () => {
			const suffix = `${target()}/bibliographic-references/${referenceId}`;
			const [viaBff, direct] = await Promise.all([call('GET', suffix), http('GET', `${coursesUrl}${suffix}`, { token })]);
			expect(viaBff.status).toBe(200); expect(viaBff.body).toEqual(direct.body);
		});
		it('PUT replaces the reference', async () => {
			const result = await call('PUT', `${target()}/bibliographic-references/${referenceId}`, { title: 'Replaced reference', authors: 'Other author', type: 'BASIC' });
			expect(result.status).toBe(200); expect(result.body.title).toBe('Replaced reference');
		});
		it('PATCH changes the reference', async () => {
			const result = await call('PATCH', `${target()}/bibliographic-references/${referenceId}`, { title: 'Patched reference' });
			expect(result.status).toBe(200); expect(result.body.title).toBe('Patched reference');
		});
		it('DELETE returns empty 204 and the item subsequently returns 404', async () => {
			const suffix = `${target()}/bibliographic-references/${referenceId}`;
			const result = await call('DELETE', suffix); expect(result.status).toBe(204); expect(result.body).toBeUndefined();
			expect((await call('GET', suffix)).status).toBe(404);
		});
	});

	describe('syllabus items remain proxies', () => {
		it('GET collection matches Courses directly', async () => {
			const suffix = `${target()}/syllabus-items`;
			const [viaBff, direct] = await Promise.all([call('GET', suffix), http('GET', `${coursesUrl}${suffix}`, { token })]);
			expect(viaBff.status).toBe(200); expect(viaBff.body).toEqual(direct.body);
		});
		it('POST creates a syllabus item', async () => {
			const result = await call('POST', `${target()}/syllabus-items`, { kind: 'CONTENT', statement: 'HTTP contracts', order: 1 });
			expect(result.status).toBe(201); syllabusItemId = result.body.id;
			expect(result.body).toMatchObject({ courseId, kind: 'CONTENT', order: 1 }); expect(result.body).not.toHaveProperty('classes');
		});
		it('GET item matches Courses directly', async () => {
			const suffix = `${target()}/syllabus-items/${syllabusItemId}`;
			const [viaBff, direct] = await Promise.all([call('GET', suffix), http('GET', `${coursesUrl}${suffix}`, { token })]);
			expect(viaBff.status).toBe(200); expect(viaBff.body).toEqual(direct.body);
		});
		it('GET global syllabus item matches its nested representation', async () => {
			const [global, nested] = await Promise.all([call('GET', `${COURSES}/syllabus-items/${syllabusItemId}`), call('GET', `${target()}/syllabus-items/${syllabusItemId}`)]);
			expect(global.status).toBe(200); expect(global.body).toEqual(nested.body);
		});
		it('PUT replaces the syllabus item', async () => {
			const result = await call('PUT', `${target()}/syllabus-items/${syllabusItemId}`, { kind: 'CONTENT', statement: 'Replaced statement', order: 1 });
			expect(result.status).toBe(200); expect(result.body.statement).toBe('Replaced statement');
		});
		it('PATCH changes the syllabus item', async () => {
			const result = await call('PATCH', `${target()}/syllabus-items/${syllabusItemId}`, { statement: 'Patched statement' });
			expect(result.status).toBe(200); expect(result.body.statement).toBe('Patched statement');
		});
		it('DELETE returns empty 204 and the global item subsequently returns 404', async () => {
			const result = await call('DELETE', `${target()}/syllabus-items/${syllabusItemId}`);
			expect(result.status).toBe(204); expect(result.body).toBeUndefined();
			expect((await call('GET', `${COURSES}/syllabus-items/${syllabusItemId}`)).status).toBe(404);
		});
	});

	const withDocker = setting('E2E_DOCKER', '0') === '1' ? it : it.skip;
	withDocker('returns CO-503 without partial Course when the real Classes container stops', async () => {
		const container = setting('E2E_CLASSES_CONTAINER', 'classes');
		execFileSync('docker', ['stop', container], { stdio: 'ignore' });
		try {
			const result = await call('GET', target());
			expect(result.status).toBe(503); expect(result.contentType).toContain('application/json');
			expect(Object.keys(result.body).sort()).toEqual(['error_code', 'error_description', 'error_source', 'error_stack']);
			expect(result.body.error_code).toBe('CO-503'); expect(result.body).not.toHaveProperty('id');
			expect(result.body).not.toHaveProperty('classes');
		} finally {
			execFileSync('docker', ['start', container], { stdio: 'ignore' });
			const deadline = Date.now() + 90_000;
			let ready = false;
			while (Date.now() < deadline) {
				const result = await http('GET', `${classesUrl}${CLASSES}?year=${year}`, { token }).catch(() => undefined);
				if (result?.status === 200) { ready = true; break; }
				await new Promise(resolve => setTimeout(resolve, 1000));
			}
			if (!ready) throw new Error('Classes did not recover; inspect the container before rerunning cleanup.');
		}
	});

	it('DELETE logically removes the Course through BFF and its domain', async () => {
		const result = await call('DELETE', target()); expect(result.status).toBe(204); expect(result.body).toBeUndefined();
		const direct = await http('GET', `${coursesUrl}${target()}`, { token }); expect(direct.status).toBe(404);
		expect((await call('GET', target())).status).toBe(404);
		createdCourseIds.delete(courseId);
	});
});
