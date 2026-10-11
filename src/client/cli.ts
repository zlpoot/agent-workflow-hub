#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AwhClient, CLIENT_EVENT_TYPES } from './client.js';
import { ClientError, clientFail, inspectRepository, initManifest, readJson } from './local.js';
import { CLIENT_VERSION, CLIENT_PACKAGE } from './version.js';
import { deliver, DeliveryError, deliveryDiagnostic } from './deliver.js';
import { readFileSync, lstatSync } from 'node:fs';
import { publicationDiagnostic } from '../builder.js';
import { doctor, formatDoctor, isDoctorReport } from './doctor.js';
import { residentControl, startResident } from './resident.js';

export async function main(args: string[]): Promise<unknown> {
  if (args.length === 1 && args[0] === '--version') return { package: CLIENT_PACKAGE, version: CLIENT_VERSION, authority_verified: false };
  if (args.length === 1 && args[0] === '--help') return { commands: ['resident start|status|stop', 'doctor [--json] [--probe-cp] [--policy-trust <external-file> --work-item <id> --work-item-version <version> --observations <json-file>]', 'init --profile <ref> [--project-id <id>]', 'register', 'status', 'timeline', 'sync', 'start --issue <n>',
    'event --type <type> --data <json-file>', 'event --retry', 'finish [--outcome failed --data <json-file>]', 'deliver [--issue <n>] [--recover-from-run <run-id>] --title <title> --body <utf8-file> [--hold-draft]', 'deliver --retry',
    'link-revision --run <run-id> --pr <n> --head <sha> --evidence-comment <id>', 'link-revision --retry',
    'reconcile-publication --revision <revision-id>', 'resume-publication --revision <revision-id> --authorization-comment <id>'], event_types: CLIENT_EVENT_TYPES,
    configuration: '--config <absolute-external-json-file> before command or AWH_CLIENT_CONFIG', doctor: 'read-only offline by default; explicit CP GET probe uses existing approved config; never grants authority', deliver: 'fixed Builder policy; explicit event-only retry', authority_verified: false };
  let configPath = process.env.AWH_CLIENT_CONFIG;
  if (args[0] === '--config') {
    if (!args[1] || configPath && configPath !== args[1]) clientFail('configuration', 'Conflicting or missing Client configuration source');
    configPath = args[1]; args = args.slice(2);
  }
  const [command, ...rest] = args, options = new Map<string, string>();
  if (command === 'resident') {
    if (rest.length === 1 && rest[0] === '--help') return { usage: 'awh --config <existing-external-config> resident start|status|stop',
      start: 'explicit foreground presence service; Ctrl+C or resident stop shuts it down; no task execution or auto-registration', authority_verified: false };
    if (!configPath || rest.length !== 1 || !['start', 'status', 'stop'].includes(rest[0]!)) clientFail('arguments', 'resident requires existing explicit config and exactly start, status or stop');
    if (rest[0] !== 'start') return residentControl(configPath, rest[0] as 'status' | 'stop');
    const service = await startResident(configPath); console.log(JSON.stringify({ resident: 'started', mode: 'foreground', authority_verified: false }));
    await service.done; return { resident: 'stopped', authority_verified: false };
  }
  if (command === 'doctor') {
    if (rest.length === 1 && rest[0] === '--help') return { usage: 'awh [--config <absolute-external-json-file>] doctor [--json] [--probe-cp] [--policy-trust <absolute-external-file> --work-item <id> --work-item-version <version> --observations <json-file>]',
      statuses: ['passed','blocked','not_checked'], read_only: true, offline_default: true, authority_verified: false };
    for (let i = 0; i < rest.length; i++) {
      const key = rest[i]!;
      if (!['--json','--probe-cp','--policy-trust','--work-item','--work-item-version','--observations'].includes(key) || options.has(key)) clientFail('arguments','Unknown or duplicate Doctor option');
      if (key === '--json' || key === '--probe-cp') { options.set(key,'true'); continue; }
      const value = rest[++i]; if (!value || value.startsWith('--')) clientFail('arguments','Missing Doctor option value'); options.set(key,value);
    }
    const selected = options.has('--work-item') || options.has('--work-item-version');
    if (selected && (!options.has('--work-item') || !options.has('--work-item-version'))) clientFail('arguments','Explicit Work Item ID and version required');
    return doctor({ configPath, probeCp: options.has('--probe-cp'), trustPath: options.get('--policy-trust'), observationPath: options.get('--observations'),
      ...(selected ? { workItem: { id: options.get('--work-item')!, version: options.get('--work-item-version')! } } : {}) });
  }
  const allowed: Record<string, string[]> = { init: ['--profile','--project-id'], register: [], status: [], timeline: ['--run'], sync: [], start: ['--issue'], event: ['--type','--data','--retry'], finish: ['--outcome','--data'], deliver: ['--issue','--title','--body','--hold-draft','--retry','--recover-from-run'], 'link-revision': ['--run','--pr','--head','--evidence-comment','--retry'],
    'reconcile-publication':['--revision'], 'resume-publication':['--revision','--authorization-comment'] };
  if (!command || !Object.hasOwn(allowed, command)) clientFail('arguments', 'Unsupported Client command; no arbitrary execution');
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]!; if (!allowed[command]!.includes(key) || options.has(key)) clientFail('arguments', 'Unknown or duplicate Client option');
    if (key === '--retry') { if (rest.length !== 1) clientFail('arguments', '--retry accepts no other options'); options.set(key, 'true'); break; }
    if (key === '--hold-draft') { options.set(key, 'true'); i--; continue; }
    const value = rest[i + 1]; if (!value || value.startsWith('--')) clientFail('arguments', 'Missing Client option value'); options.set(key, value);
  }
  if (command === 'init') {
    if (!options.has('--profile')) clientFail('arguments', 'init requires an explicitly requested Profile ref');
    const identity = inspectRepository(), id = options.get('--project-id') ?? identity.repository.split('/')[1]!;
    return { manifest: initManifest(identity, id, options.get('--profile')!), authority_verified: false };
  }
  if (command === 'deliver' && !options.has('--retry') && (!options.has('--title') || !options.has('--body'))) clientFail('arguments', 'deliver requires --title and --body, or --retry');
  if (!configPath) clientFail('configuration', 'Explicit external Client config is required; no credential or endpoint auto-discovery');
  if (command === 'start' && (!options.has('--issue') || !/^[1-9]\d*$/.test(options.get('--issue')!))) clientFail('arguments', 'start requires a positive Issue number');
  if (command === 'event' && !options.has('--retry') && (!options.has('--type') || !options.has('--data'))) clientFail('arguments', 'event requires --type and --data, or --retry');
  if (command === 'finish' && options.size && (options.get('--outcome') !== 'failed' || !options.has('--data'))) clientFail('arguments', 'finish accepts only explicit failed outcome with a JSON reason payload');
  const client = new AwhClient(configPath);
  if (command === 'reconcile-publication' || command === 'resume-publication') {
    if (!/^revision-[a-f0-9]{64}$/.test(options.get('--revision') ?? '') || options.size !== (command === 'reconcile-publication' ? 1 : 2) ||
        command === 'resume-publication' && !/^[1-9]\d*$/.test(options.get('--authorization-comment') ?? ''))
      clientFail('arguments','Publication reconciliation/resume requires explicit receipt and, for resume, Human authorization comment');
    return command === 'reconcile-publication' ? client.reconcilePublication(options.get('--revision')!) :
      client.resumePublication({revision:options.get('--revision')!,authorizationComment:Number(options.get('--authorization-comment'))});
  }
  if (command === 'link-revision') {
    if (options.has('--retry')) return client.retryRevision();
    if (options.size !== 4 || !['--pr','--evidence-comment'].every(k => /^[1-9]\d*$/.test(options.get(k) ?? '')))
      clientFail('arguments', 'link-revision requires explicit Run, PR, exact HEAD and evidence comment ID');
    return client.linkRevision({ run: options.get('--run')!, pr: Number(options.get('--pr')), head: options.get('--head')!, evidenceComment: Number(options.get('--evidence-comment')) });
  }
  if (command === 'deliver') {
    if (options.has('--retry')) return client.retryDelivery();
    if (options.has('--issue') && (!/^[1-9]\d*$/.test(options.get('--issue')!) || !Number.isSafeInteger(Number(options.get('--issue'))))) clientFail('arguments', 'deliver requires a positive safe Issue number');
    let body: string;
    try { const stat = lstatSync(options.get('--body')!); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16000) throw new Error(); body = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(options.get('--body')!)); } catch { return clientFail('file', 'PR body must be a bounded regular UTF-8 file (contents suppressed)'); }
    return deliver(client, { title: options.get('--title')!, body, holdDraft: options.has('--hold-draft'), ...(options.has('--issue') ? { issue: Number(options.get('--issue')) } : {}), ...(options.has('--recover-from-run') ? { recoverFromRun: options.get('--recover-from-run')! } : {}) });
  }
  if (command === 'timeline') return client.timeline(options.get('--run')); if (command === 'sync') return client.syncDelivery();
  if (command === 'register') return client.register(); if (command === 'status') return client.status();
  if (command === 'start') return client.start(Number(options.get('--issue')));
  if (command === 'event') return client.event(options.get('--retry') ? null : options.get('--type')!, options.has('--data') ? readJson(options.get('--data')!) : undefined);
  return client.finish(options.get('--outcome') === 'failed', options.has('--data') ? readJson(options.get('--data')!) : undefined);
}
// Node resolves ESM URLs, while npm's Unix bin may leave argv[1] as a symlink.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  main(process.argv.slice(2)).then(result => {
    console.log(isDoctorReport(result) && !process.argv.slice(2).includes('--json') ? formatDoctor(result) : JSON.stringify(result));
    if (isDoctorReport(result) && result.status === 'blocked') process.exitCode = 2;
  }).catch(error => {
    const known = error instanceof ClientError;
    console.error(JSON.stringify({ error: error instanceof DeliveryError ? deliveryDiagnostic(error) : publicationDiagnostic(error) ?? { code: known ? error.code : 'client', message: known ? error.message : 'Client operation failed; configuration, input and remote diagnostics suppressed',
      ...(known && error.http_status ? { http_status: error.http_status } : {}) }, authority_verified: false })); process.exitCode = 2;
  });
}
