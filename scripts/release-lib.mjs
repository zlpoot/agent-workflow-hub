import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join, posix } from 'node:path';
import { isBuiltin } from 'node:module';
import ts from 'typescript';
import { readTar, readZip, safeName } from './release-archive.mjs';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const ids = ['awh-client','awh-control-plane','awh-viewer','awh-dashboard-ui','awh-builder'];
export const targets = ['win32-x64','darwin-arm64'];
export const specs = {
  'awh-client': { name: '@zlpoot/awh-client', version: '0.4.6', bin: { awh: 'dist/client/cli.js' }, roots: ['client/cli.js','client/index.js'], docs: ['client.md','doctor.md','versioned-profile.md'] },
  'awh-control-plane': { name: '@zlpoot/awh-control-plane', version: '0.1.0-rc.1', bin: { 'awh-control-plane': 'dist/control-plane-cli.js' }, roots: ['control-plane-cli.js'], docs: [] },
  'awh-viewer': { name: '@zlpoot/awh-viewer', version: '0.1.0-rc.1', bin: { 'awh-viewer': 'dist/viewer-cli.js' }, roots: ['viewer-cli.js'], docs: [] },
  'awh-dashboard-ui': { name: null, version: '0.1.0-rc.1', bin: {}, roots: [], docs: [] },
  'awh-builder': { name: '@zlpoot/awh-builder', version: '0.1.0-rc.1', bin: { 'awh-builder': 'dist/builder-cli.js', 'awh-handoff-check': 'dist/cli.js' }, roots: ['builder-cli.js','cli.js'], docs: [] }
};
export const provenancePaths = ['pnpm-lock.yaml','src/profiles.ts','src/validator.ts','src/protocol/schema.json','contracts/dashboard-v1.openapi.json','src/protocol/handoff.ts'];
export const components = ids.map(id => ({id,package:specs[id].name,version:specs[id].version,entrypoints:id==='awh-dashboard-ui'?{'/dashboard':'index.html'}:specs[id].bin,
  requires:id==='awh-dashboard-ui'?{dashboard_api:'1.0.0',protected_same_origin_viewer:true}:id==='awh-builder'?{node_major_min:24,handoff:'0.1',github_app_identity:'installation',write_repository_scope:'single'}:
    {node_major_min:24,protocol:'1.0',cp_database_schema:2,...(id==='awh-viewer'?{dashboard_api:'1.0.0',default_enabled:false}:{})}}));
export function closed(o, fields) { assert(o && typeof o === 'object' && !Array.isArray(o)); assert.deepEqual(Object.keys(o).sort(),[...fields].sort(),'Unknown/missing fields'); }
export function tree(dir, prefix = '') {
  const result = {};
  for(const name of readdirSync(dir).sort()) { const path = join(dir,name), rel = prefix+name, stat = lstatSync(path); assert(!stat.isSymbolicLink(),'Runtime symlink forbidden'); if(stat.isDirectory()) Object.assign(result,tree(path,rel+'/')); else { assert(stat.isFile()); result[safeName(rel)] = readFileSync(path); } }
  return result;
}
export function checkBuild(build, component, target, source) {
  closed(build,['schema_version','kind','component','target','source_commit','source_clean','version','node_major_min','build_environment','provenance','runtime_dependencies','files']);
  assert.equal(build.schema_version,'1.0'); assert.equal(build.kind,'awh_build'); assert.equal(build.component,component); assert.equal(build.target,target); assert.equal(build.source_commit,source); assert.equal(build.source_clean,true);
  assert(/^[a-f0-9]{40}$/.test(source)); assert.equal(build.version,specs[component].version); assert.equal(build.node_major_min,24);
  closed(build.provenance,provenancePaths); for(const hash of Object.values(build.provenance)) assert(/^[a-f0-9]{64}$/.test(hash));
  closed(build.build_environment,['os','cpu','node','npm','pnpm','typescript','esbuild']);
  for(const value of Object.values(build.build_environment)) assert(typeof value === 'string' && value && !/^(?:unknown|n\/a|NOTRUN)$/i.test(value));
  for(const name of ['npm','typescript','esbuild'])assert(/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(build.build_environment[name]),'Actual tool version required');
  assert(build.build_environment.pnpm==='not-used'||/^\d+\.\d+\.\d+$/.test(build.build_environment.pnpm));
  const host = build.build_environment.os+'-'+build.build_environment.cpu; assert(targets.includes(host),'Actual supported build host required');
  assert(/^v(?:2[4-9]|[3-9]\d)\./.test(build.build_environment.node));
  for(const [file,hash] of Object.entries(build.files)) { safeName(file); assert(file !== 'awh-build.json' && /^[a-f0-9]{64}$/.test(hash)); }
}
export function checkArtifact(bytes, artifact, source) {
  closed(artifact,['component','target','filename','source_commit','size_bytes','sha256','build']);
  const { component,target } = artifact; assert(ids.includes(component)); assert(component === 'awh-dashboard-ui' ? target === 'static' : target === 'universal');
  assert.equal(artifact.filename,`${component}-${specs[component].version}-${target}.${target === 'static' ? 'zip' : 'tgz'}`);
  assert.equal(artifact.source_commit,source); assert.equal(artifact.size_bytes,bytes.length); assert(bytes.length>0); assert.equal(artifact.sha256,sha256(bytes));
  const archive = target === 'static' ? new Map([...readZip(bytes)].map(([p,b]) => [p,{body:b,mode:0}])) : readTar(bytes);
  const build = JSON.parse(archive.get('awh-build.json')?.body.toString() ?? 'null'); checkBuild(build,component,target,source); assert.deepEqual(build,artifact.build);
  assert.deepEqual([...archive.keys()].sort(),[...Object.keys(build.files),'awh-build.json'].sort(),'Incomplete/extra archive closure');
  for(const [path,hash] of Object.entries(build.files)) assert.equal(sha256(archive.get(path).body),hash,'Runtime file digest mismatch');
  if(target !== 'static') {
    const pkg = JSON.parse(archive.get('package.json').body); assert.equal(pkg.name,specs[component].name); assert.equal(pkg.version,specs[component].version); assert.equal(pkg.private,true); assert.equal(pkg.type,'module'); assert.equal(pkg.engines.node,'>=24'); assert(!Object.hasOwn(pkg,'os') && !Object.hasOwn(pkg,'cpu'),'Portable packages cannot constrain os/cpu'); assert.deepEqual(pkg.bin,specs[component].bin);
    checkPortableClosure(archive,build.runtime_dependencies);
    assert.deepEqual([...(pkg.bundledDependencies??[])].sort(),Object.keys(pkg.dependencies??{}).sort());
    assert.equal(sha256(archive.get('contracts/dashboard-v1.openapi.json')?.body??Buffer.alloc(0)),build.provenance['contracts/dashboard-v1.openapi.json'],'Missing/exact contract bytes');
    for(const path of Object.values(pkg.bin)) { assert(archive.get(path).body.toString().startsWith('#!/usr/bin/env node\n')); assert(archive.get(path).mode & 0o111,'Executable bin required'); }
    for(const [name,version] of Object.entries(build.runtime_dependencies)) assert.equal(JSON.parse(archive.get('node_modules/'+name+'/package.json')?.body.toString() ?? 'null')?.version,version,'Missing runtime dependency');
    for(const [path,entry] of archive) if(path.startsWith('dist/') && path.endsWith('.js')) {
      const ast=ts.createSourceFile(path,entry.body.toString(),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
      const dependency=literal=>{assert(ts.isStringLiteral(literal),'Nonliteral runtime import');const name=literal.text;
        if(name.startsWith('.')) { const rel=posix.normalize(posix.join(posix.dirname(path),name));assert(rel.startsWith('dist/') && archive.has(rel),'Missing/escaping runtime import'); }
        else if(!isBuiltin(name)) { const dependencyName=name.startsWith('@')?name.split('/').slice(0,2).join('/'):name.split('/')[0];assert(Object.hasOwn(pkg.dependencies,dependencyName)); }
      };
      const scan=node=>{if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier)dependency(node.moduleSpecifier);
        if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword){assert.equal(node.arguments.length,1);dependency(node.arguments[0]);}ts.forEachChild(node,scan);};scan(ast);
    }
    assert.deepEqual(Object.keys(pkg.dependencies ?? {}).sort(),Object.keys(build.runtime_dependencies).filter(n=>['ajv','ajv-formats'].includes(n)).sort());
    assert([...archive.keys()].every(p => !/^(?:src|tests|\.git|\.handoff|credentials)\//.test(p) && !/\.(?:pem|key|sqlite|token|jwt)$/.test(p)));
  } else {
    assert.deepEqual(Object.keys(build.runtime_dependencies),[]);
    for(const file of ['index.html','app.js','app.css','validators.cjs','build-inputs.json','dashboard-v1.openapi.json']) assert(archive.has(file));
    assert.equal(sha256(archive.get('dashboard-v1.openapi.json').body),build.provenance['contracts/dashboard-v1.openapi.json']);
  }
  return build;
}
export function readArtifact(artifact,source,read) {
  closed(artifact,['component','target','filename','source_commit','size_bytes','sha256','build']);
  assert(ids.includes(artifact.component));assert(artifact.component==='awh-dashboard-ui'?artifact.target==='static':artifact.target==='universal');
  assert.equal(artifact.filename,`${artifact.component}-${specs[artifact.component].version}-${artifact.target}.${artifact.target==='static'?'zip':'tgz'}`);
  return checkArtifact(read(artifact.filename),artifact,source);
}
export function checkCandidate(candidate, read) {
  closed(candidate,['schema_version','kind','source_commit','source_clean','target','artifacts','package_verification','runtime_write','full_delivery','release_gate']);
  assert.equal(candidate.schema_version,'1.0'); assert.equal(candidate.kind,'awh_release_candidate'); assert.equal(candidate.source_clean,true); assert.equal(candidate.target,'universal'); assert.equal(candidate.release_gate,'NOT_AUTHORIZED'); assert.equal(candidate.runtime_write,'NOTRUN'); assert.equal(candidate.full_delivery,'NOTRUN');
  const required=ids.map(id=>id+'\0'+(id==='awh-dashboard-ui'?'static':'universal'));
  assert.deepEqual(candidate.artifacts.map(a=>a.component+'\0'+a.target).sort(),required.sort()); assert.equal(new Set(candidate.artifacts.map(a=>a.filename)).size,5);
  assert.equal(candidate.package_verification,'NOTRUN','Build index cannot assert smoke PASS; keep later evidence external');
  for(const artifact of candidate.artifacts) readArtifact(artifact,candidate.source_commit,read);
  const reference=candidate.artifacts[0].build.provenance; for(const artifact of candidate.artifacts) assert.deepEqual(artifact.build.provenance,reference);
  return true;
}

// Audit actual archived bytes, not only dependency labels or the outer tar digest.
export function checkPortableClosure(archive, dependencies) {
  const packagePaths=Object.keys(dependencies).map(id=>'node_modules/'+id+'/package.json');
  const roots=[...archive.keys()].filter(p=>/^node_modules\/(?:@[^/]+\/)?[^/]+\/package\.json$/.test(p));
  assert.deepEqual(roots.sort(),packagePaths.sort(),'Runtime dependency inventory mismatch');
  for(const [path,{body}] of archive) {
    assert(!/\.(?:node|dll|dylib|so(?:\.\d+)*|exe|com|bat|cmd|ps1|a|o)$/i.test(path),'Platform binary/script forbidden: '+path);
    const magic=body.subarray(0,4).toString('hex');
    assert(!['7f454c46','feedface','cefaedfe','feedfacf','cffaedfe','cafebabe','bebafeca'].includes(magic) && body.subarray(0,2).toString()!=='MZ','Native binary forbidden: '+path);
    if(path.startsWith('node_modules/') && path.endsWith('/package.json')) {
      const pkg=JSON.parse(body);assert(!pkg.os && !pkg.cpu && !pkg.gypfile,'Platform-bound dependency');
      assert(!Object.keys(pkg.optionalDependencies??{}).length,'Unresolved optional dependency');
      assert(!['preinstall','install','postinstall'].some(k=>Object.hasOwn(pkg.scripts??{},k)),'Runtime lifecycle script forbidden');
    }
    if(!path.startsWith('node_modules/') || !/\.(?:js|cjs|mjs)$/.test(path))continue;
    const ast=ts.createSourceFile(path,body.toString(),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
    const dependency=literal=>{
      assert(literal && ts.isStringLiteral(literal),'Nonliteral dependency import'); const name=literal.text;
      if(isBuiltin(name))return;
      if(name.startsWith('.')) {
        const rel=posix.normalize(posix.join(posix.dirname(path),name));
        const parts=path.split('/'), boundary=parts[1].startsWith('@')?parts.slice(0,3).join('/'):parts.slice(0,2).join('/');
        assert(rel.startsWith(boundary+'/') && [rel,rel+'.js',rel+'.json',rel+'/index.js'].some(p=>archive.has(p)),'Missing/escaping dependency import');
      }else {
        const id=name.startsWith('@')?name.split('/').slice(0,2).join('/'):name.split('/')[0];assert(Object.hasOwn(dependencies,id),'Undeclared dependency closure');
        const pkg=JSON.parse(archive.get('node_modules/'+id+'/package.json').body);
        const rel=name===id?posix.join('node_modules',id,pkg.main??'index.js'):'node_modules/'+name;
        assert([rel,rel+'.js',rel+'.json',rel+'/index.js'].some(p=>archive.has(p)),'Missing bare dependency import');
      }
    };
    const scan=node=>{
      if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier)dependency(node.moduleSpecifier);
      if(ts.isCallExpression(node) && (node.expression.kind===ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression)&&node.expression.text==='require')){assert.equal(node.arguments.length,1);dependency(node.arguments[0]);}
      ts.forEachChild(node,scan);
    };scan(ast);
  }
}
