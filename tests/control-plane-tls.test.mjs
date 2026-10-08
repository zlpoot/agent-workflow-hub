import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHttpsConfig } from '../dist/control-plane/tls.js';
import { tlsFixture } from './tls-fixture.mjs';

test('HTTPS config requires private IPv4, exact current IP SAN, external bounded files and matching private key', t => {
  const dir=mkdtempSync(join(tmpdir(),'awh-tls-'));t.after(()=>{assert(dir.startsWith(join(tmpdir(),'awh-tls-')));rmSync(dir,{recursive:true});});
  const tls=tlsFixture({ip:'192.168.2.5'}), cert=join(dir,'leaf.pem'), key=join(dir,'leaf-key.pem'), path=join(dir,'https.json');
  writeFileSync(cert,tls.cert);writeFileSync(key,tls.key,{mode:0o600});
  const config={host:'192.168.2.5',port:8443,certificate_file:cert,private_key_file:key};
  const configure=changes=>writeFileSync(path,JSON.stringify({...config,...changes}));configure({});
  const valid=readHttpsConfig(path);assert.equal(valid.host,config.host);assert.equal(valid.port,8443);assert(valid.tls.cert.equals(tls.cert));
  for(const host of ['0.0.0.0','127.0.0.1','::','192.168.2.6','example.invalid','8.8.8.8','192.168.02.5','192.168.999.5']){configure({host});assert.throws(()=>readHttpsConfig(path));}
  for(const port of [0,65536,'8443',-1]){configure({port});assert.throws(()=>readHttpsConfig(path));}
  configure({extra:true});assert.throws(()=>readHttpsConfig(path));configure({certificate_file:'leaf.pem'});assert.throws(()=>readHttpsConfig(path));configure({});
  writeFileSync(key,tlsFixture().key);assert.throws(()=>readHttpsConfig(path));writeFileSync(key,tls.key);
  writeFileSync(cert,tlsFixture({ip:config.host,expired:true}).cert);assert.throws(()=>readHttpsConfig(path));writeFileSync(cert,tls.cert);
  writeFileSync(join(dir,'.git'),'fixture');assert.throws(()=>readHttpsConfig(path));
});
