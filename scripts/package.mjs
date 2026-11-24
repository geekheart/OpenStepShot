import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';

const dist = new URL('../dist/', import.meta.url);
const assets = new URL('assets/', dist);
const app = await readFile(new URL('index.html', dist), 'utf8');
const scripts = app.match(/<script\b[^>]*\bsrc="\.\/([^"]+)"[^>]*><\/script>/);
const styles = app.match(/<link\b[^>]*rel="stylesheet"[^>]*\bhref="\.\/([^"]+)"[^>]*>/);
if (!scripts || !styles) throw new Error('Cannot find the built application script and stylesheet.');

const files = await readdir(assets);
const parser = files.find((name) => /^occt-js-.*\.js$/.test(name));
const wasm = files.find((name) => /^occt-js-.*\.wasm$/.test(name));
if (!parser || !wasm) throw new Error('Cannot find the built STEP parser assets.');

const [js, css, worker, runtime, binary, example] = await Promise.all([
  readFile(new URL(scripts[1], dist), 'utf8'),
  readFile(new URL(styles[1], dist), 'utf8'),
  readFile(new URL('step-worker.js', dist), 'base64'),
  readFile(new URL(parser, assets), 'base64'),
  readFile(new URL(wasm, assets), 'base64'),
  readFile(new URL('examples/sample-module.step', dist), 'base64'),
]);

const licenses = [
  ['three/LICENSE', 'three.txt'],
  ['@tx-code/occt-js/LICENSE', 'occt-js.txt'],
];
const licenseDirectory = new URL('licenses/', dist);
const sources = `Three.js (MIT): https://github.com/mrdoob/three.js/tree/r180
@tx-code/occt-js (LGPL-2.1): https://github.com/tx-code/occt-js
Open CASCADE Technology (LGPL-2.1 with exception): https://github.com/Open-Cascade-SAS/OCCT/tree/V7_9_3
`;
await mkdir(licenseDirectory, { recursive: true });
const notices = await Promise.all(licenses.map(async ([path, name]) => {
  const source = new URL('../node_modules/' + path, import.meta.url);
  await copyFile(source, new URL(name, licenseDirectory));
  return readFile(source, 'utf8');
}));
await writeFile(new URL('sources.txt', licenseDirectory), sources);

const payload = Object.entries({ worker, runtime, wasm: binary, example }).map(([name, data]) =>
  `<script type="application/octet-stream" id="offline-${name}">${data}</script>`).join('\n');
const licenseData = [sources, ...notices].join('\n\n').replaceAll('</script', '<\\/script');
const inlineScript = js.replace(/<\/script/gi, '<\\/script');
const offline = app
  .replace(styles[0], () => `<style>${css}</style>`)
  .replace(scripts[0], () => `${payload}\n<script type="text/plain" id="third-party-notices">${licenseData}</script>\n<script type="module">${inlineScript}</script>`);
await Promise.all([
  writeFile(new URL('../index.html', dist), offline),
  writeFile(new URL('STEP-Image-Exporter.html', dist), offline),
]);
