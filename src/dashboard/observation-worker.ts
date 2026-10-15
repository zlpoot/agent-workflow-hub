import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { combineTaskAdapters, GitHubObservationAdapter, LocalFastObservationAdapter, type GitHubObservationConfig, type LocalFastObservationConfig } from './local-fast-observation.js';
import type { ObservationOptions, Task, TaskAdapter } from './tasks.js';

interface Configs { local: readonly LocalFastObservationConfig[]; projects: readonly LocalFastObservationConfig[]; github: readonly GitHubObservationConfig[] }
/** Request-driven read projection only. GUI's synchronous checks cannot expire its native reads or cache deadlines. */
export function createObservationWorker(configs: () => Configs): TaskAdapter & { close(): Promise<void> } {
  let worker: Worker | undefined, sequence = 0, closed = false;
  const pending = new Map<number, { resolve(tasks: Task[]): void; reject(error: Error): void }>();
  const failed = () => { for (const entry of pending.values()) entry.reject(new Error('observation_worker_unavailable')); pending.clear(); worker = undefined; };
  return {
    observe(projectIds: readonly string[], managed: readonly Task[] = [], options: ObservationOptions = {}) {
      if (closed || pending.size >= 64) return Promise.reject(new Error('observation_worker_unavailable'));
      if (!worker) {
        worker = new Worker(new URL('./observation-worker.js', import.meta.url), { workerData: { kind: 'awh-read-observation' } });
        worker.on('message', message => {
          const entry = pending.get(message?.id); if (!entry) return;
          pending.delete(message.id);
          if (Array.isArray(message.tasks)) entry.resolve(message.tasks);
          else entry.reject(new Error('observation_worker_unavailable'));
        });
        const current = worker;
        const unavailable = () => { if (worker === current) failed(); };
        worker.once('error', unavailable); worker.once('exit', unavailable);
      }
      const id = ++sequence;
      return new Promise<Task[]>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try { worker!.postMessage({ id, configs: configs(), projectIds, managed, options }); }
        catch { pending.delete(id); reject(new Error('observation_worker_unavailable')); }
      });
    },
    async close() {
      closed = true;
      const current = worker; if (!current) return;
      await new Promise<void>(resolve => { current.once('exit', () => resolve()); current.postMessage({ close: true }); });
    }
  };
}

if (!isMainThread && workerData?.kind === 'awh-read-observation') {
  const local: LocalFastObservationConfig[] = [], projects: LocalFastObservationConfig[] = [], github: GitHubObservationConfig[] = [];
  const reader = combineTaskAdapters(new LocalFastObservationAdapter(local), new LocalFastObservationAdapter(projects), new GitHubObservationAdapter(github));
  let closed = false;
  parentPort!.on('message', async message => {
    if (message?.close === true) { closed = true; parentPort!.close(); return; }
    if (closed || !Number.isSafeInteger(message?.id)) return;
    try {
      local.splice(0, local.length, ...message.configs.local); projects.splice(0, projects.length, ...message.configs.projects); github.splice(0, github.length, ...message.configs.github);
      const tasks = await reader.observe(message.projectIds, message.managed, message.options);
      if (!closed) parentPort!.postMessage({ id: message.id, tasks });
    } catch { if (!closed) parentPort!.postMessage({ id: message.id, error: 'observation_worker_unavailable' }); }
  });
}
