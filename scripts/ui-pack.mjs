import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipFiles } from './release-archive.mjs';

// Small deterministic uncompressed ZIP; only the closed browser asset set ships.
const root=dirname(dirname(fileURLToPath(import.meta.url))),args=process.argv.slice(2);
assert(args.length===0 || args.length===2 && args[0]==='--output','Use only --output <directory>');
const output=resolve(args[1] ?? join(root,'.handoff/packages'));mkdirSync(output,{recursive:true});
const names=['index.html','app.js','app.css','validators.cjs','v2/index.html','v2/app.js','v2/app.css'];
const files=Object.fromEntries(names.map(name=>[name,readFileSync(name.startsWith('v2/') ? join(root,'dist/dashboard-v2',name.slice(3)) : join(root,'dist/dashboard-ui',name))]));
const bytes=zipFiles(files),artifact=join(output,'awh-ui.zip');writeFileSync(artifact,bytes);
console.log(JSON.stringify({artifact,sha256:createHash('sha256').update(bytes).digest('hex'),files:names,published:false}));
