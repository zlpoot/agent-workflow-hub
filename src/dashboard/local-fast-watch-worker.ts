import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { ClientError } from '../client/local.js';
import { LocalFastWatcher } from '../workflow/local-fast-watcher.js';

type Action = 'start' | 'resume-stage';
type Result = { status: string; reason?: string };
/** Run the existing Watcher off the HTTP event loop; its scope, repository lock and PID stay unchanged. */
export function runLocalFastWatchWorker(root: string, action: Action, signal: AbortSignal): Promise<Result> {
  if (signal.aborted) return Promise.resolve({ status: 'STOPPED' });
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./local-fast-watch-worker.js', import.meta.url), { workerData: { root, action } });
    let settled = false;
    const stop = () => worker.postMessage('stop');
    const finish = (result?: Result) => {
      if (settled) return;
      settled = true; signal.removeEventListener('abort', stop);
      if (result) resolve(result);
      else reject(new ClientError('local_fast_watch_worker', 'Watcher worker exited; preserve the existing task and inspect its lock.'));
    };
    signal.addEventListener('abort', stop, { once: true });
    worker.once('message', result => {
      if (!result || typeof result.status !== 'string' || !/^[A-Z_]+$/.test(result.status) ||
          result.reason !== undefined && !/^local_fast_[a-z_]+$/.test(result.reason)) finish();
      else finish({ status: result.status, ...(result.reason ? { reason: result.reason } : {}) });
    });
    worker.once('error', () => finish());
    worker.once('exit', () => finish());
  });
}

if (!isMainThread) {
  const controller = new AbortController();
  parentPort!.on('message', message => { if (message === 'stop') controller.abort(); });
  try {
    if (!workerData || Object.keys(workerData).sort().join(',') !== 'action,root' ||
        typeof workerData.root !== 'string' || !['start', 'resume-stage'].includes(workerData.action)) throw new Error('invalid_worker_request');
    const watcher = new LocalFastWatcher(workerData.root);
    const initial = workerData.action === 'resume-stage' ? await watcher.resumeStage(true, controller.signal) : null;
    const result = initial && (initial.status !== 'AWAITING_INDEPENDENT_REVIEW' || controller.signal.aborted)
      ? initial : await watcher.run(false, controller.signal);
    parentPort!.postMessage({ status: result.status, ...(result.reason ? { reason: result.reason } : {}) });
  } catch (error) {
    parentPort!.postMessage({ status: 'BLOCKED', reason: error instanceof ClientError ? error.code : 'local_fast_watch_operation' });
  } finally { parentPort!.close(); }
}
