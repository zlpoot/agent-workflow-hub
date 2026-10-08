import { readFileSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { build } from 'esbuild';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import standalone from 'ajv/dist/standalone/index.js';

// Generate static validators from the published contract. No browser eval or server imports.
const contract = JSON.parse(readFileSync('contracts/dashboard-v1.openapi.json', 'utf8'));
const ajv = new Ajv({ strict: false, code: { source: true }, allErrors: false });
addFormats(ajv); ajv.addSchema(contract, 'urn:awh:dashboard');
const names = ['Snapshot', 'TimelinePage', 'TimelineEvent', 'ViewRefresh', 'RunResponse'];
const exports = Object.fromEntries(names.map(name => [name, `urn:awh:dashboard#/components/schemas/${name}`]));
mkdirSync('dist/dashboard-ui', { recursive: true });
writeFileSync('dist/dashboard-ui/validators.cjs', standalone(ajv, exports));
await build({ entryPoints: ['dashboard/app.tsx'], bundle: true, outfile: 'dist/dashboard-ui/app.js',
  platform: 'browser', target: ['es2022'], minify: true, sourcemap: false,
  define: { 'process.env.NODE_ENV': '"production"' }, metafile: true }).then(result => {
  if (Object.keys(result.metafile.inputs).some(path => /src\/|node:(?:fs|sqlite|crypto)|builder/.test(path)))
    throw new Error('Server source crossed the browser build boundary');
  writeFileSync('dist/dashboard-ui/build-inputs.json', JSON.stringify(Object.keys(result.metafile.inputs), null, 2));
});
copyFileSync('dashboard/index.html', 'dist/dashboard-ui/index.html');
console.log('Dashboard browser bundle and static OpenAPI validators built');
