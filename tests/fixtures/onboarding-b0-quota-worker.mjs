import { workerData, parentPort } from 'node:worker_threads';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { OfflineOnboardingStore, OfflineOnboardingApi, MockFixtureTransport, fixtureDatabase } from '../../dist/onboarding/index.js';
const {fixture,config,now,barrier,headers}=workerData;
const store=new OfflineOnboardingStore(fixture,config,()=>now), transport=new MockFixtureTransport();
const channel=transport.operator(config.service.operator_origin), api=new OfflineOnboardingApi(store,transport);
if(workerData.storage_probe){
  const original=fs.statSync,journal=fixtureDatabase(fixture)+'-journal';let probed=false;
  fs.statSync=(path,...args)=>{
    if(path===journal && !probed){
      probed=true;parentPort.postMessage({storage_probe:true});
      Atomics.wait(new Int32Array(workerData.storage_probe),0,0,5000);
    }
    return original(path,...args);
  };
  syncBuiltinESMExports();
}
parentPort.postMessage({ready:true});
Atomics.wait(new Int32Array(barrier),0,0);
try {
  const r=await api.handle({method:'GET',path:'/onboarding/v1/nonce',headers},channel);
  parentPort.postMessage({status:r.status,code:r.body.error?.code??'ok'});
} finally {store.close();}
