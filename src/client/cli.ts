#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AwhClient, CLIENT_EVENT_TYPES } from './client.js';
import { ClientError, clientFail, inspectRepository, initManifest, readJson } from './local.js';
import { CLIENT_VERSION, CLIENT_PACKAGE } from './version.js';

export async function main(args: string[]): Promise<unknown> {
  if (args.length === 1 && args[0] === '--version') return { package: CLIENT_PACKAGE, version: CLIENT_VERSION, authority_verified: false };
  if (args.length === 1 && args[0] === '--help') return { commands: ['init --profile <ref> [--project-id <id>]', 'register', 'status', 'start --issue <n>',
    'event --type <type> --data <json-file>', 'event --retry', 'finish [--outcome failed --data <json-file>]'], event_types: CLIENT_EVENT_TYPES,
    configuration: '--config <absolute-external-json-file> before command or AWH_CLIENT_CONFIG', deliver: 'unavailable until C1-D/#22', authority_verified: false };
  let configPath = process.env.AWH_CLIENT_CONFIG;
  if (args[0] === '--config') { configPath = args[1]; args = args.slice(2); }
  const [command, ...rest] = args, options = new Map<string, string>();
  const allowed: Record<string, string[]> = { init: ['--profile','--project-id'], register: [], status: [], start: ['--issue'], event: ['--type','--data','--retry'], finish: ['--outcome','--data'] };
  if (!command || !Object.hasOwn(allowed, command)) clientFail('arguments', 'Unsupported Client command; no arbitrary execution or deliver operation');
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]!; if (!allowed[command]!.includes(key) || options.has(key)) clientFail('arguments', 'Unknown or duplicate Client option');
    if (key === '--retry') { if (rest.length !== 1) clientFail('arguments', 'event --retry accepts no other options'); options.set(key, 'true'); break; }
    const value = rest[i + 1]; if (!value || value.startsWith('--')) clientFail('arguments', 'Missing Client option value'); options.set(key, value);
  }
  if (command === 'init') {
    if (!options.has('--profile')) clientFail('arguments', 'init requires an explicitly requested Profile ref');
    const identity = inspectRepository(), id = options.get('--project-id') ?? identity.repository.split('/')[1]!;
    return { manifest: initManifest(identity, id, options.get('--profile')!), authority_verified: false };
  }
  if (!configPath) clientFail('configuration', 'Explicit external Client config is required; no credential or endpoint auto-discovery');
  if (command === 'start' && (!options.has('--issue') || !/^[1-9]\d*$/.test(options.get('--issue')!))) clientFail('arguments', 'start requires a positive Issue number');
  if (command === 'event' && !options.has('--retry') && (!options.has('--type') || !options.has('--data'))) clientFail('arguments', 'event requires --type and --data, or --retry');
  if (command === 'finish' && options.size && (options.get('--outcome') !== 'failed' || !options.has('--data'))) clientFail('arguments', 'finish accepts only explicit failed outcome with a JSON reason payload');
  const client = new AwhClient(configPath);
  if (command === 'register') return client.register(); if (command === 'status') return client.status();
  if (command === 'start') return client.start(Number(options.get('--issue')));
  if (command === 'event') return client.event(options.get('--retry') ? null : options.get('--type')!, options.has('--data') ? readJson(options.get('--data')!) : undefined);
  return client.finish(options.get('--outcome') === 'failed', options.has('--data') ? readJson(options.get('--data')!) : undefined);
}
// Node resolves ESM URLs, while npm's Unix bin may leave argv[1] as a symlink.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  main(process.argv.slice(2)).then(result => console.log(JSON.stringify(result))).catch(error => {
    const known = error instanceof ClientError;
    console.error(JSON.stringify({ error: { code: known ? error.code : 'client', message: known ? error.message : 'Client operation failed; configuration, input and remote diagnostics suppressed',
      ...(known && error.http_status ? { http_status: error.http_status } : {}) }, authority_verified: false })); process.exitCode = 2;
  });
}
