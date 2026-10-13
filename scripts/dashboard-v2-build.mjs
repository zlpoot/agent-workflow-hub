import { readFileSync, mkdirSync, writeFileSync, copyFileSync, statSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import standalone from 'ajv/dist/standalone/index.js';

// Independent V2 browser bundle. Shares the generated OpenAPI validators with V1 and
// keeps its own output directory so dashboard/app.js and dashboard/app.css stay untouched.
const output = 'dist/dashboard-v2';
mkdirSync(output, { recursive: true });

const validators = 'dist/dashboard-ui/validators.cjs';
if (!existsSync(validators)) {
  const contract = JSON.parse(readFileSync('contracts/dashboard-v1.openapi.json', 'utf8'));
  const ajv = new Ajv({ strict: false, code: { source: true }, allErrors: false });
  addFormats(ajv); ajv.addSchema(contract, 'urn:awh:dashboard');
  const names = ['Snapshot', 'TimelinePage', 'TimelineEvent', 'ViewRefresh', 'RunResponse', 'TaskResponse', 'TaskPage'];
  const exports = Object.fromEntries(names.map(name => [name, `urn:awh:dashboard#/components/schemas/${name}`]));
  mkdirSync('dist/dashboard-ui', { recursive: true });
  writeFileSync(validators, standalone(ajv, exports));
}

// Same boundary rule as dashboard-build.mjs, scoped to repository sources: no src/ server
// module, no node: fs/sqlite/crypto builtin and no builder code may reach the browser bundle.
// Third-party packages that ship a src/ folder (for example stylis) are not repository sources.
const crossesBoundary = path =>
  (/src\//.test(path) && !path.startsWith('node_modules/')) ||
  /node:(?:fs|sqlite|crypto)/.test(path) ||
  (/builder/.test(path) && !path.startsWith('node_modules/'));

await build({ entryPoints: ['dashboard/v2/app.tsx'], bundle: true, outfile: `${output}/app.js`,
  platform: 'browser', target: ['es2022'], minify: true, sourcemap: false,
  define: { 'process.env.NODE_ENV': '"production"' }, metafile: true }).then(result => {
  if (Object.keys(result.metafile.inputs).some(crossesBoundary))
    throw new Error('Server source crossed the browser build boundary');
  writeFileSync(`${output}/build-inputs.json`, JSON.stringify(Object.keys(result.metafile.inputs).sort(), null, 2) + '\n');
});
copyFileSync('dashboard/v2/index.html', `${output}/index.html`);

const report = ['app.js', 'app.css', 'index.html'].map(name => {
  const file = `${output}/${name}`;
  const bytes = statSync(file).size;
  return { file: `${output}/${name}`, bytes, gzip: gzipSync(readFileSync(file)).length };
});
writeFileSync(`${output}/build-size.json`, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ output, assets: report }, null, 2));
