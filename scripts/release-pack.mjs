import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, realpathSync, existsSync, rmSync, renameSync, chmodSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire, isBuiltin } from 'node:module';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import { npmEntry, npmEnv } from './npm-tool.mjs';
import { ids, specs, provenancePaths, sha256, tree, checkCandidate } from './release-lib.mjs';
import { zipFiles, executableTar } from './release-archive.mjs';

const root=dirname(dirname(fileURLToPath(import.meta.url))), args=process.argv.slice(2), target='universal';
assert(args.length===2 && args[0]==='--output','release-pack --output <new-empty-directory>');
assert(['win32-x64','darwin-arm64'].includes(process.platform+'-'+process.arch),'Use an actual supported build host; artifact target is independent');
const git = params => { const r=spawnSync('git',params,{cwd:root,encoding:'utf8',windowsHide:true}); assert.equal(r.status,0,'Git source inspection failed'); return r.stdout.trim(); };
assert.equal(git(['status','--porcelain']),'','Commit all source changes before building candidates');
const source=git(['rev-parse','HEAD']), output=resolve(args[1]); assert(!existsSync(output),'Candidate output must be a new directory; immutable bytes are never overwritten'); mkdirSync(output,{recursive:true});
const stage=mkdtempSync(join(output,'.stage-')), env=npmEnv(join(stage,'.cache'));
const run=(cmd,argv,options={})=>{const r=spawnSync(cmd,argv,{cwd:root,env,encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024,windowsHide:true,...options}); assert.equal(r.status,0,'Local build/pack failed: '+r.stderr);return r.stdout.trim();};
try {
  // Recompile at the inspected clean source: never consume stale checkout dist.
  run(process.execPath,[join(root,'node_modules/typescript/bin/tsc')]); run(process.execPath,[join(root,'scripts/dashboard-build.mjs')]);
  const packageRoot=JSON.parse(readFileSync(join(root,'package.json'))), versions=createRequire(join(root,'package.json'));
  const build_environment={os:process.platform,cpu:process.arch,node:process.version,npm:run(process.execPath,[npmEntry(),'--version']),pnpm:'not-used',typescript:versions('typescript/package.json').version,esbuild:versions('esbuild/package.json').version};
  const provenance=Object.fromEntries(provenancePaths.map(p=>[p,sha256(readFileSync(join(root,p)))])), artifacts=[];
  const metadata=(component,files,dependencies)=>({schema_version:'1.0',kind:'awh_build',component,target:component==='awh-dashboard-ui'?'static':target,source_commit:source,source_clean:true,version:specs[component].version,node_major_min:24,build_environment,provenance,runtime_dependencies:dependencies,files:Object.fromEntries(Object.entries(files).map(([p,b])=>[p,sha256(b)]))});
  for(const component of ids) {
    const spec=specs[component], pkgStage=join(stage,component); mkdirSync(pkgStage);
    let build, filename;
    if(component==='awh-dashboard-ui') {
      const files=tree(join(root,'dist/dashboard-ui')); files['dashboard-v1.openapi.json']=readFileSync(join(root,'contracts/dashboard-v1.openapi.json'));
      build=metadata(component,files,{}); files['awh-build.json']=Buffer.from(JSON.stringify(build,null,2)+'\n'); filename=`${component}-${spec.version}-static.zip`; writeFileSync(join(output,filename),zipFiles(files),{flag:'wx'});
    } else {
      const seen=new Set(), direct=new Set();
      const visit=path=>{
        path=resolve(path); const rel=relative(join(root,'dist'),path).replaceAll('\\','/'); assert(rel && !rel.startsWith('../') && !rel.startsWith('/') && existsSync(path),'Missing/escaping runtime import');
        if(seen.has(rel))return; seen.add(rel); if(path.endsWith('.json'))return; assert(path.endsWith('.js'),'Unsupported runtime file');
        const ast=ts.createSourceFile(path,readFileSync(path,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
        const dependency=literal=>{assert(ts.isStringLiteral(literal),'Nonliteral runtime dependency'); const name=literal.text;
          if(name.startsWith('.'))visit(resolve(dirname(path),name)); else if(!isBuiltin(name)){ const pkg=name.startsWith('@')?name.split('/').slice(0,2).join('/'):name.split('/')[0]; assert(Object.hasOwn(packageRoot.dependencies,pkg),'Undeclared runtime dependency'); direct.add(pkg); }
        };
        const scan=node=>{if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier)dependency(node.moduleSpecifier);
          if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword){assert.equal(node.arguments.length,1); dependency(node.arguments[0]);}
          ts.forEachChild(node,scan);};scan(ast);
      };
      spec.roots.forEach(p=>visit(join(root,'dist',p)));
      for(const p of seen) { const dest=join(pkgStage,'dist',p); mkdirSync(dirname(dest),{recursive:true}); cpSync(join(root,'dist',p),dest); }
      // Exact contract bytes accompany every package, independent of external configuration.
      mkdirSync(join(pkgStage,'contracts')); cpSync(join(root,'contracts/dashboard-v1.openapi.json'),join(pkgStage,'contracts/dashboard-v1.openapi.json'));
      for(const doc of spec.docs){mkdirSync(join(pkgStage,'docs'),{recursive:true});cpSync(join(root,'docs',doc),join(pkgStage,'docs',doc));}
      const dependencies={}, copied={};
      const copyDependency=(name,req)=>{
        let path=dirname(req.resolve(name));
        while(!existsSync(join(path,'package.json'))||JSON.parse(readFileSync(join(path,'package.json'))).name!==name){const parent=dirname(path);assert.notEqual(parent,path);path=parent;}
        const data=JSON.parse(readFileSync(join(path,'package.json')));assert(readFileSync(join(root,'pnpm-lock.yaml'),'utf8').includes(`  ${name}@${data.version}:`),'Runtime dependency not present at exact lock version');if(direct.has(name))assert.equal(data.version,packageRoot.dependencies[name]);if(copied[name]){assert.equal(copied[name],data.version,'Runtime version conflict');return;}copied[name]=data.version;
        // Exclude dependency development fixtures/tooling; retained runtime JS is audited below.
        const excluded=new Set(['node_modules','test','tests','spec','benchmark','.github','.gitattributes','eslint.config.js','.eslintrc.yml','tsconfig.json']);
        // AJV's opt-in RE2 adapter is not used by AWH's fixed validators and needs an uninstalled native addon.
        // Omit that adapter, not its imports from the audit: any retained reference still fails closure validation.
        const omitted=name==='ajv'?['dist/runtime/re2.js','dist/runtime/re2.js.map','dist/runtime/re2.d.ts','lib/runtime/re2.ts']:[];
        cpSync(realpathSync(path),join(pkgStage,'node_modules',name),{recursive:true,dereference:true,filter:file=>{const rel=relative(path,file).replaceAll('\\','/');return !rel.split('/').some(p=>excluded.has(p)) && !omitted.includes(rel);}});
        assert(!data.os&&!data.cpu&&!data.gypfile && !Object.values(data.scripts??{}).some(s=>/node-gyp|prebuild-install/.test(s)),'Native dependency requires explicit platform build');
        assert(!Object.keys(data.optionalDependencies??{}).length,'Optional closure must be explicitly resolved');
        for(const child of Object.keys(data.dependencies??{}))copyDependency(child,createRequire(join(path,'package.json')));
      };
      for(const name of [...direct].sort()){dependencies[name]=packageRoot.dependencies[name];copyDependency(name,versions);}
      const pkg={name:spec.name,version:spec.version,private:true,type:'module',engines:{node:'>=24'},bin:spec.bin,
        ...(component==='awh-client'?{exports:{'.':'./dist/client/index.js'}}:{}),files:['dist','contracts','docs','awh-build.json'],dependencies,bundledDependencies:Object.keys(dependencies)};
      writeFileSync(join(pkgStage,'package.json'),JSON.stringify(pkg,null,2)+'\n');
      for(const bin of Object.values(spec.bin))chmodSync(join(pkgStage,bin),0o755);
      build=metadata(component,tree(pkgStage),copied);writeFileSync(join(pkgStage,'awh-build.json'),JSON.stringify(build,null,2)+'\n');
      const [packed]=JSON.parse(run(process.execPath,[npmEntry(),'pack','--json','--ignore-scripts','--offline','--pack-destination',output],{cwd:pkgStage}));
      assert.equal(packed.name,spec.name); filename=`${component}-${spec.version}-${target}.tgz`; renameSync(join(output,packed.filename),join(output,filename));
      // npm on Windows does not retain POSIX chmod bits. Normalize only declared bin headers;
      // content/closure hashes stay unchanged and final outer hash is computed afterwards.
      writeFileSync(join(output,filename),executableTar(readFileSync(join(output,filename)),Object.values(spec.bin)));
    }
    const bytes=readFileSync(join(output,filename)); artifacts.push({component,target:build.target,filename,source_commit:source,size_bytes:bytes.length,sha256:sha256(bytes),build});
  }
  assert.equal(git(['rev-parse','HEAD']),source,'Source changed during build');assert.equal(git(['status','--porcelain']),'','Source became dirty during build');
  const candidate={schema_version:'1.0',kind:'awh_release_candidate',source_commit:source,source_clean:true,target,artifacts,package_verification:'NOTRUN',runtime_write:'NOTRUN',full_delivery:'NOTRUN',release_gate:'NOT_AUTHORIZED'};
  checkCandidate(candidate,file=>readFileSync(join(output,file)));
  writeFileSync(join(output,'candidate-index.json'),JSON.stringify(candidate,null,2)+'\n',{flag:'wx'});
  const names=[...artifacts.map(a=>a.filename),'candidate-index.json']; writeFileSync(join(output,'CANDIDATE-SHA256SUMS'),names.map(f=>sha256(readFileSync(join(output,f)))+'  '+f).join('\n')+'\n',{flag:'wx'});
  console.log(JSON.stringify({source_commit:source,target,artifacts:artifacts.map(({build,...a})=>a),release_gate:'NOT_AUTHORIZED',mac_validation:target==='win32-x64'?'NOTRUN':'HOST_BUILD_ONLY'}));
} finally {
  const real=realpathSync(stage), base=realpathSync(output); assert.equal(dirname(real),base); assert(relative(base,real).startsWith('.stage-'));rmSync(real,{recursive:true,force:true});
}
