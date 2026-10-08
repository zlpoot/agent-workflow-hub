import { parentPort, workerData } from 'node:worker_threads';
import { OfflineOnboardingStore, OfflineOnboardingApi, MockFixtureTransport } from '../../dist/onboarding/index.js';
const { fixture, config, scope, envelope, barrier, now } = workerData;
const store = new OfflineOnboardingStore(fixture,config,()=>now), transport = new MockFixtureTransport();
const client = transport.client(scope,'worker-private-delivery'), api = new OfflineOnboardingApi(store,transport);
const shared = new Int32Array(barrier);
parentPort.postMessage({ready:true});
Atomics.wait(shared,0,0,10000);
try {
  const result = await api.handle(envelope,client.channel);
  // Never transfer a raw credential/request/error text back into the test log.
  parentPort.postMessage({status:result.status,code:result.body.error?.code ?? 'ok'});
} finally { store.close(); parentPort.close(); }
