import { existsSync } from 'node:fs';
import { ControlPlaneStore } from '../dist/control-plane/store.js';
export function fixtureStore(path,policies,now,mode,grants) {
  return new ControlPlaneStore(path,policies,now,mode ?? (existsSync(path)?'existing':'initialize'),grants);
}
