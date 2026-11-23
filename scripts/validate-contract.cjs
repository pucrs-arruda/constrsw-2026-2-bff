const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const Ajv = require('ajv/dist/2020').default;
const addFormats = require('ajv-formats').default;
const root = path.resolve(__dirname, '../openapi');
const documents = new Map();
const ajv = new Ajv({ strict: false, allErrors: true }); addFormats(ajv);
for (const name of ['openapi.json', 'domains/courses.openapi.json', 'domains/classes.openapi.json']) {
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
    let resolved = target;
    for (const part of decodeURIComponent(uri.hash.slice(2)).split('/').filter(Boolean)) resolved = resolved?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
    assert(resolved !== undefined, `Unresolved reference: ${uri}`);
  }
  for (const item of Object.values(value)) walk(item, base);
}
for (const [uri, document] of documents) {
  walk(document, uri);
  for (const name of Object.keys(document.components?.schemas ?? {})) ajv.compile({ $ref: `${uri}#/components/schemas/${name}` });
}
const api = documents.get('https://bff.invalid/openapi.json');
const operations = Object.entries(api.paths).filter(([name]) => name.startsWith('/api/v1/courses')).flatMap(([, item]) => Object.keys(item).filter(key => ['get', 'post', 'put', 'patch', 'delete'].includes(key)));
// Referenced path items are checked through their resolved domain definition.
let count = operations.length;
for (const [name, item] of Object.entries(api.paths)) if (name.startsWith('/api/v1/courses') && item.$ref) {
  const uri = new URL(item.$ref, 'https://bff.invalid/openapi.json');
  let target = documents.get(uri.origin + uri.pathname);
  for (const part of uri.hash.slice(2).split('/')) target = target[part.replace(/~1/g, '/').replace(/~0/g, '~')];
  count += Object.keys(target).filter(key => ['get', 'post', 'put', 'patch', 'delete'].includes(key)).length;
}
assert.equal(count, 19);
console.log(`Offline contract OK: ${documents.size} documents, ${refs} references, ${count} Courses operations; all schemas compile.`);
