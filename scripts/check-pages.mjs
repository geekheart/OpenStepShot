import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { runInNewContext } from 'node:vm';
import createOcct from '@tx-code/occt-js';

const { values } = parseArgs({ options: { stage: { type: 'string' } } });
const dist = new URL('../dist/', import.meta.url);
const samplePath = 'examples/sample-module.step';
const workerPath = 'step-worker.js';

const html = await readFile(new URL('index.html', dist), 'utf8');
const githubLink = html.match(/<a\b[^>]*\bid="github-link"[^>]*>/i)?.[0];
assert.ok(githubLink, 'The page must expose its GitHub repository');
assert.match(githubLink, /\bhref="https:\/\/github\.com\/geekheart\/OpenStepShot"/, 'GitHub link must point to the source repository');
const scriptTags = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/gi)];
const styleTags = [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"[^>]*>/gi)];
assert.equal(scriptTags.length, 1, 'Expected one local JavaScript entry');
assert.equal(styleTags.length, 1, 'Expected one local stylesheet');
assert.match(scriptTags[0][1], /^\.\/assets\/[\w.-]+\.js$/, 'JavaScript must resolve under a Pages repository subpath');
assert.match(styleTags[0][1], /^\.\/assets\/[\w.-]+\.css$/, 'CSS must resolve under a Pages repository subpath');

const scriptPath = scriptTags[0][1].slice(2);
const stylePath = styleTags[0][1].slice(2);
const app = await readFile(new URL(scriptPath, dist), 'utf8');
const parser = app.match(/new URL\(["'`](occt-js-[\w-]+\.js)["'`],\s*import\.meta\.url\)/);
const wasm = app.match(/new URL\(["'`](occt-js-[\w-]+\.wasm)["'`],\s*import\.meta\.url\)/);
assert.ok(parser && wasm, 'OCCT JavaScript and WASM must resolve relative to the application bundle');
assert.ok(app.includes(workerPath), 'The application must load the STEP worker');
assert.ok(app.includes(samplePath), 'The application must offer the public STEP example');
assert.doesNotMatch(app, /["'`]\/(?:step-worker\.js|examples\/sample-module\.step)["'`]/, 'The worker and example must resolve under a Pages repository subpath');

const parserPath = `assets/${parser[1]}`;
const wasmPath = `assets/${wasm[1]}`;
const siteFiles = [
  'index.html', scriptPath, stylePath, parserPath, wasmPath, workerPath, samplePath,
  'licenses/three.txt', 'licenses/occt-js.txt', 'licenses/sources.txt',
];
const files = new Map(await Promise.all(siteFiles.map(async (path) => {
  const contents = await readFile(new URL(path, dist));
  assert.ok(contents.length, `${path} is empty`);
  return [path, contents];
})));

const sample = files.get(samplePath);
assert.match(sample.toString('utf8', 0, 64), /^ISO-10303-21;/, 'The public example must be a STEP file');

let message;
const self = { postMessage: (result) => { message = result; } };
runInNewContext(files.get(workerPath).toString('utf8'), { self, OcctJS: createOcct, TextDecoder }, { filename: workerPath });
await self.onmessage({ data: { buffer: sample, wasmBinary: files.get(wasmPath) } });
assert.ok(message, 'The STEP worker did not report a result');
assert.equal(message.error, undefined, message.error);
assert.ok(message.roots.length, 'The STEP example must have model nodes');

const colors = new Set();
for (const mesh of message.meshes) {
  if (!mesh) continue;
  for (let i = 0; i < mesh.colors.length; i += 3) {
    const color = [mesh.colors[i], mesh.colors[i + 1], mesh.colors[i + 2]].map((value) => value.toFixed(4)).join(',');
    if (color !== '0.4700,0.5700,0.6200') colors.add(color);
  }
}
assert.ok(colors.size >= 2, 'The STEP example must retain at least two explicit colors');

if (values.stage) {
  const stage = resolve(values.stage);
  for (const path of siteFiles) {
    const destination = join(stage, path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(new URL(path, dist), destination);
  }
  console.log(`Staged ${siteFiles.length} checked Pages files in ${stage}`);
}
console.log(`Verified relative Pages assets and ${colors.size} STEP example colors`);
