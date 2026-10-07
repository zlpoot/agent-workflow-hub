import { parentPort, workerData } from 'node:worker_threads';
import { ControlPlaneStore } from '../dist/control-plane/index.js';
const { path, policy, principal, event, gate } = workerData;
const store = new ControlPlaneStore(path, [policy]);
parentPort.postMessage({ ready: true });
Atomics.wait(new Int32Array(gate), 0, 0);
try {
  const result = store.append(principal, event.run_id, event);
  store.close();
  parentPort.postMessage({ disposition: result.disposition, cursor: result.cursor });
} catch (error) { store.close(); parentPort.postMessage({ error: error.code ?? 'unexpected' }); }
