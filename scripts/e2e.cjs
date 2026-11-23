// Real OAuth + Courses; Classes is an explicit HTTP fixture. Only owned records are deleted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createServer } = require('node:http');
const { randomUUID } = require('node:crypto');
const { NestFactory } = require('@nestjs/core');
const secrets = [];

async function main() {
  let oauth = process.env.BFF_E2E_OAUTH_URL;
  let courses = process.env.BFF_E2E_COURSES_URL;
  let username = process.env.BFF_E2E_USERNAME;
  let password = process.env.BFF_E2E_PASSWORD;
  if (process.env.BFF_E2E_RECEIPT) {
    const receipt = JSON.parse(fs.readFileSync(path.resolve(process.env.BFF_E2E_RECEIPT), 'utf8'));
    assert.equal(receipt.owner, 'courses-base-e2e/v1', 'Not a Courses test-stack receipt');
    oauth ??= `http://127.0.0.1:${receipt.ports.oauth}`;
    courses ??= `http://127.0.0.1:${receipt.ports.courses}`;
    username ??= 'coordinator@courses.local';
    password ??= receipt.userPassword;
  }
  assert(username && password && oauth && courses, 'Supply BFF_E2E_OAUTH_URL, BFF_E2E_COURSES_URL, BFF_E2E_USERNAME and BFF_E2E_PASSWORD.');
  secrets.push(password);
  const form = new FormData(); form.set('username', username); form.set('password', password);
  const loggedIn = await fetch(`${oauth}/login`, { method: 'POST', body: form, signal: AbortSignal.timeout(15000) });
  assert.equal(loggedIn.status, 201, 'OAuth login failed');
  const tokens = await loggedIn.json();
  for (const value of [tokens.access_token, tokens.refresh_token]) if (typeof value === 'string') secrets.push(value);
  assert(typeof tokens.access_token === 'string');
  const cookie = loggedIn.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  assert(cookie, 'OAuth did not return the browser session cookie');
  assert(loggedIn.headers.getSetCookie().some(value => /;\s*httponly(?:;|$)/i.test(value)), 'OAuth cookie must be HttpOnly');
  process.env.SESSION_COOKIE_NAME ??= cookie.split('=')[0];
  console.log('PASS real OAuth login and HttpOnly session cookie');

  let classStatus = 200;
  let linkedCourse;
  const received = [];
  const calendar = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: 'numeric' }).formatToParts(new Date());
  const year = Number(calendar.find(part => part.type === 'year').value);
  const semester = Number(calendar.find(part => part.type === 'month').value) < 8 ? 1 : 2;
  const sample = { id: randomUUID(), enabled: true, year, semester, startDate: `${year}-01-01`, endDate: `${year}-12-31`, seats: 30, roomId: randomUUID(), professorId: randomUUID(), studentIds: [], status: 'active', averageRating: null };
  const fixture = createServer((request, response) => {
    received.push({ url: request.url, authorization: request.headers.authorization, cookie: request.headers.cookie });
    response.writeHead(classStatus, { 'content-type': 'application/json' });
    response.end(classStatus === 200 ? JSON.stringify(linkedCourse ? [{ ...sample, courseId: linkedCourse }] : []) : '{}');
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  Object.assign(process.env, { PORT: '0', COURSES_BASE_URL: courses, CLASSES_BASE_URL: `http://127.0.0.1:${fixture.address().port}`, BFF_HTTP_RETRIES: '0', BFF_HTTP_TIMEOUT_MS: '5000' });
  // Load after setting environment so all configured providers use this run's origins.
  const { AppModule } = require('../dist/app.module');
  const { configureApp } = require('../dist/bootstrap');
  let app;
  let created;
  let root;
  let checks = 1;
  async function call(method, suffix, status, body, authenticated = true) {
    const response = await fetch(`${root}${suffix}`, { method, headers: { ...(authenticated ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(20000) });
    assert.equal(response.status, status, `${method} ${suffix}: expected ${status}, got ${response.status}`);
    const text = await response.text(); checks++;
    return text ? JSON.parse(text) : undefined;
  }
  try {
    app = await NestFactory.create(AppModule, { bodyParser: false, logger: false });
    configureApp(app); await app.listen(0, '127.0.0.1');
    root = `${await app.getUrl()}/api/v1/courses`;
    await call('GET', '', 401, undefined, false);
    const payload = { code: `BFF-${randomUUID().slice(0, 12)}`, name: 'BFF integration test', syllabus: 'Owned disposable record', workloadHours: 60, bibliographicReferences: [{ title: 'Integration', authors: 'Test', type: 'BASIC' }, { title: 'Second', authors: 'Test', type: 'SUPPLEMENTARY' }] };
    created = await call('POST', '', 201, payload); linkedCourse = created.id;
    assert(!('classes' in created), 'Writes must remain domain responses');
    const own = `/${created.id}`;
    const view = await call('GET', own, 200);
    assert.equal(view.classes.length, 1); assert.equal(view.classes[0].courseId, created.id);
    assert.deepEqual(view.bibliographicReferences, created.bibliographicReferences);
    const list = await call('GET', `?code=${encodeURIComponent(payload.code)}`, 200);
    assert.equal(list.length, 1); assert.equal(list[0].classes.length, 1);
    const { bibliographicReferences, ...replacement } = payload;
    await call('PUT', own, 200, replacement);
    await call('PATCH', own, 200, { name: 'Updated by BFF E2E' });

    await call('GET', `${own}/bibliographic-references`, 200);
    const reference = await call('POST', `${own}/bibliographic-references`, 201, { title: 'New reference', authors: 'Test', type: 'SUPPLEMENTARY' });
    const ref = `${own}/bibliographic-references/${reference.id}`;
    await call('GET', ref, 200);
    await call('PUT', ref, 200, { title: 'Replaced reference', authors: 'Test', type: 'BASIC' });
    await call('PATCH', ref, 200, { title: 'Patched reference' });
    await call('DELETE', ref, 204);

    await call('GET', `${own}/syllabus-items`, 200);
    const item = await call('POST', `${own}/syllabus-items`, 201, { kind: 'CONTENT', statement: 'HTTP contracts', order: 1 });
    const itemPath = `${own}/syllabus-items/${item.id}`;
    await call('GET', itemPath, 200);
    await call('GET', `/syllabus-items/${item.id}`, 200);
    await call('PUT', itemPath, 200, { kind: 'CONTENT', statement: 'Replaced', order: 1 });
    await call('PATCH', itemPath, 200, { statement: 'Patched' });
    await call('DELETE', itemPath, 204);

    classStatus = 503;
    const failure = await call('GET', own, 503);
    assert.equal(failure.error_code, 'CO-503'); assert(!('classes' in failure));
    classStatus = 200;
    for (const request of received) {
      assert.equal(request.authorization, `Bearer ${tokens.access_token}`);
      assert.equal(request.cookie, undefined);
    }
    const metrics = await fetch(`${await app.getUrl()}/metrics`).then(response => response.text());
    assert(metrics.includes('bff_http_requests_total')); assert(!metrics.includes(tokens.access_token));
    console.log('PASS all 19 Courses operations through Nest BFF and real Courses');
    console.log('PASS current-semester composition, preserved nested data, cookie forwarding, Classes outage and metrics');
    console.log('Classes source: explicit local HTTP fixture; live Classes compatibility was not tested.');
  } finally {
    try {
      if (created && root) { await call('DELETE', `/${created.id}`, 204); await call('GET', `/${created.id}`, 404); console.log('PASS cleanup of this run\'s Course'); }
    } finally {
      if (app) await app.close();
      await new Promise(resolve => { fixture.close(resolve); fixture.closeAllConnections(); });
    }
  }
  console.log(`E2E OK: ${checks} verified HTTP checks.`);
}
main().catch(error => {
  let message = String(error.message);
  for (const secret of secrets) if (secret) message = message.replaceAll(secret, '[REDACTED]');
  console.error(`E2E failed: ${message}`); process.exitCode = 1;
});
