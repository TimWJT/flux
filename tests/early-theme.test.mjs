import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename, resolve } from 'node:path';

const project = new URL('../', import.meta.url);
const source = readFileSync(new URL('src/startup.js', project), 'utf8');
const variants = [
  ['light', '"light"', 'light'], ['dark', '"dark"', 'dark'], ['auto', '"auto"', null],
  ['missing', null, null], ['invalid JSON', '{oops', null], ['raw string', 'dark', null],
  ['unknown', '"sepia"', null], ['null', 'null', null], ['object', '{}', null],
  ['array', '["dark"]', null], ['number', '42', null], ['boolean', 'true', null],
];

for (const osDark of [false, true]) {
  for (const [name, value, expected] of variants) {
    test(`early theme: ${name}, OS ${osDark ? 'dark' : 'light'}`, () => {
      const attributes = new Map([['data-theme', 'stale']]);
      const reads = [];
      const context = vm.createContext({
        window: {},
        document: {
          documentElement: {
            setAttribute: (k, v) => attributes.set(k, v),
            removeAttribute: k => attributes.delete(k),
          },
        },
        localStorage: { getItem(k) { reads.push(k); return value; } },
        matchMedia: () => ({ matches: osDark }),
      });
      vm.runInContext(source, context);
      assert.equal(attributes.get('data-theme') ?? null, expected);
      assert.deepEqual(reads, ['nightlight.theme']);
      vm.runInContext(source, context);
      assert.equal(reads.length, 1);
    });
  }
}

test('build structure: both output shapes apply theme first and packaged JS stays deferred', async () => {
  const outputs = new Map();
  const context = vm.createContext({
    build: async options => ({
      outputFiles: [{
        text:
          basename(options.entryPoints[0]) === 'startup.js' ? source :
          basename(options.entryPoints[0]) === 'app.css' ? 'body{color:black}' : '/* fixture bundle */',
      }],
    }),
    readFile: async path => readFileSync(path, 'utf8'),
    writeFile: async (path, text) => outputs.set(basename(path), text),
    mkdir: async () => {},
    resolve,
    rm: async () => {},
    fileURLToPath,
    dirname,
    join,
    Buffer,
    console: { log() {} },
  });
  const buildSource = readFileSync(new URL('build.mjs', project), 'utf8')
    .replace(/^import\s+[^;]+;\s*$/gm, '')
    .replace('import.meta.url', JSON.stringify(new URL('build.mjs', project).href));
  await vm.runInContext('(async () => {\n' + buildSource + '\n})()', context);
  const packaged = outputs.get('index.html');
  const standalone = outputs.get('Night Light.html');
  assert.equal(outputs.get('startup.js'), source);
  assert.match(packaged, /<script src="startup\.js"><\/script>/);
  assert.match(packaged, /<script src="app\.js" defer><\/script>/);
  assert.ok(packaged.indexOf('src="startup.js"') < packaged.indexOf('href="app.css"'));
  assert.ok(packaged.indexOf('src="startup.js"') < packaged.indexOf('<body>'));
  assert.ok(standalone.indexOf(source) > 0);
  assert.ok(standalone.indexOf(source) < standalone.indexOf('<style>'));
  assert.ok(standalone.indexOf(source) < standalone.indexOf('<body>'));
  for (const html of [packaged, standalone]) {
    assert.doesNotMatch(html, /__(?:STARTUP|CSS|JS)__/);
  }
  assert.doesNotMatch(standalone, /<script[^>]+src=/, 'no external script required by standalone');
  const app = readFileSync(new URL('src/main.js', project), 'utf8');
  assert.match(app, /import '\.\/startup\.js';/, 'fallback shares the exact bootstrap implementation');
  const config = JSON.parse(readFileSync(new URL('src-tauri/tauri.conf.json', project), 'utf8'));
  assert.match(config.app.security.csp, /script-src 'self'/);
  assert.doesNotMatch(config.app.security.csp.split('script-src')[1].split(';')[0], /unsafe-inline/);
});
