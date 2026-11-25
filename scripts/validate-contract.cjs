const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const Ajv = require('ajv/dist/2020').default;
const addFormats = require('ajv-formats').default;
const root = path.resolve(__dirname, '../openapi');
const documents = new Map();
const ajv = new Ajv({ strict: false, allErrors: true }); addFormats(ajv);
const operationCounts = { courses: 19, rooms: 12, resources: 6 };
const domainNames = [...Object.keys(operationCounts), 'classes'];
for (const name of ['openapi.json', ...domainNames.map(domain => `domains/${domain}.openapi.json`)]) {
  const document = JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
  documents.set(`https://bff.invalid/${name}`, document);
  ajv.addSchema(document, `https://bff.invalid/${name}`);
}
let refs = 0;
function walk(value, base) {
  if (!value || typeof value !== 'object') return;
  if (typeof value.$ref === 'string') {
    refs++;
    const uri = new URL(value.$ref, base);
    const target = documents.get(uri.origin + uri.pathname);
    assert(target, `Reference escapes offline contract: ${uri}`);
    const resolved = resolveReference(uri);
    assert(resolved !== undefined, `Unresolved reference: ${uri}`);
  }
  for (const item of Object.values(value)) walk(item, base);
}
for (const [uri, document] of documents) {
  walk(document, uri);
  for (const name of Object.keys(document.components?.schemas ?? {})) ajv.compile({ $ref: `${uri}#/components/schemas/${name}` });
}

function resolveReference(uri) {
  const target = documents.get(uri.origin + uri.pathname);
  return decodeURIComponent(uri.hash.slice(1)).split('/').filter(Boolean)
    .reduce((value, part) => value?.[part.replace(/~1/g, '/').replace(/~0/g, '~')], target);
}
const apiUri = 'https://bff.invalid/openapi.json';
const api = documents.get(apiUri);
const methods = new Set(['get', 'post', 'put', 'patch', 'delete']);
const counts = [];
for (const [domain, expected] of Object.entries(operationCounts)) {
  const prefix = `/api/v1/${domain}`;
  const paths = Object.entries(api.paths).filter(([name]) => name === prefix || name.startsWith(prefix + '/'));
  let count = 0;
  for (const [, item] of paths) {
    const definition = item.$ref ? resolveReference(new URL(item.$ref, apiUri)) : item;
    count += Object.keys(definition).filter(method => methods.has(method)).length;
  }
  assert.equal(count, expected, `Unexpected operation count for ${domain}`);
  counts.push(`${count} ${domain[0].toUpperCase() + domain.slice(1)} operations`);
}

const resourcesPaths = Object.keys(api.paths).filter(name => name.startsWith('/api/v1/resources'));
assert.deepEqual(resourcesPaths, [
  '/api/v1/resources',
  '/api/v1/resources/{resourceId}',
  '/api/v1/resources/{resourceId}/occurrences',
  '/api/v1/resources/{resourceId}/occurrences/{occurrenceId}',
]);
const resourcesCount = resourcesPaths
  .flatMap(name => Object.keys(api.paths[name]).filter(key => ['get', 'post', 'put', 'patch', 'delete'].includes(key)))
  .length;
assert.equal(resourcesCount, 6);
assert.deepEqual(api.components.schemas.ResourceList, {
  type: 'array',
  description: 'Ordered by code ascending. Bare array (no envelope), matching docs/open-api/bff.yaml.',
  items: { $ref: '#/components/schemas/ResourceSummary' },
});
assert(api.components.schemas.ResourceSummary.required.includes('reservations'));
assert(api.components.schemas.Resource.required.includes('reservations'));
assert(api.components.schemas.FutureReservations);
const resourcesDomain = documents.get('https://bff.invalid/domains/resources.openapi.json');
assert(resourcesDomain.paths['/api/v1/resources']);
assert(resourcesDomain.components.schemas.ResourceAggregate);
console.log(`Offline contract OK: ${documents.size} documents, ${refs} references, ${counts.join(', ')}; all schemas compile.`);
