import { Ajv2020 } from 'ajv/dist/2020.js';
import { fullFormats } from 'ajv-formats/dist/formats.js';
import schema from './schema.json' with { type: 'json' };
import type { ProtocolEntities, Json } from './types.js';

export interface ProtocolDiagnostic { path: string; reason: string }
export interface ProtocolValidation {
  valid: boolean; authority_verified: false; errors: ProtocolDiagnostic[];
}
export class ProtocolError extends Error {
  constructor(readonly code: 'schema' | 'binding' | 'state' | 'sequence' | 'idempotency' | 'timestamp', message: string) {
    super(message);
  }
}
const ajv = new Ajv2020({ allErrors: true, strict: true, ownProperties: true });
ajv.addFormat('date-time', fullFormats['date-time']!);
ajv.addSchema(schema);
const validators = Object.fromEntries(
  (['manifest', 'project', 'profile_policy', 'executor', 'work_item', 'run', 'event'] as const)
    .map(kind => [kind, ajv.compile({ $ref: `${schema.$id}#/$defs/${kind}` })]),
);

// Protocol values are JSON data, including extensions; no cycles, accessors or class instances.
export function isJson(value: unknown, ancestors = new Set<object>()): value is Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  ancestors.add(value);
  const keys = Reflect.ownKeys(value).filter(k => !(Array.isArray(value) && k === 'length'));
  const valid = keys.every(key => {
    const property = Object.getOwnPropertyDescriptor(value, key)!;
    return typeof key === 'string' && property.enumerable && 'value' in property && isJson(property.value, ancestors);
  }) && (!Array.isArray(value) || keys.length === value.length && keys.every((key, i) => key === String(i)));
  ancestors.delete(value);
  return valid;
}

export function validateEntity<K extends keyof ProtocolEntities>(kind: K, value: unknown): ProtocolValidation {
  const errors: ProtocolDiagnostic[] = [];
  const result = () => ({ valid: errors.length === 0, authority_verified: false as const, errors });
  if (!isJson(value)) {
    errors.push({ path: '$', reason: 'Expected finite, plain JSON data' });
    return result();
  }
  if (!Object.hasOwn(validators, kind)) {
    errors.push({ path: '$', reason: 'Unsupported entity kind' });
    return result();
  }
  const validator = validators[kind]!;
  if (!validator(value)) {
    errors.push(...(validator.errors ?? []).map(e => ({ path: '$' + e.instancePath, reason: e.message ?? 'Invalid schema' })));
    return result();
  }
  if (kind === 'run') {
    const run = value as unknown as ProtocolEntities['run'];
    const require = (condition: boolean, path: string, reason: string) => { if (!condition) errors.push({ path, reason }); };
    require(run.created_at <= run.updated_at, '$.updated_at', 'Run timestamps must be ordered');
    if (run.started_at !== null) require(run.created_at <= run.started_at && run.started_at <= run.updated_at, '$.started_at', 'Start must be between creation and update');
    if (run.state === 'created') require(run.started_at === null && run.completed_at === null && run.updated_at === run.created_at, '$.state', 'Created Run must have initial timestamps');
    else if (run.state !== 'failed') require(run.started_at !== null, '$.started_at', 'Started Run needs a start timestamp');
    const terminal = run.state === 'completed' || run.state === 'failed';
    require(terminal ? run.completed_at === run.updated_at : run.completed_at === null, '$.completed_at', 'Only terminal Runs have a completion timestamp equal to update');
  }
  if (kind === 'event') {
    const event = value as unknown as ProtocolEntities['event'];
    if (event.type === 'VERIFICATION_PASSED' && event.payload.data.checks.some(c => c.exit_code !== 0))
      errors.push({ path: '$.payload.data.checks', reason: 'Passing verification requires all exit codes zero' });
  }
  return result();
}

export function assertEntity<K extends keyof ProtocolEntities>(kind: K, value: unknown): ProtocolEntities[K] {
  if (!validateEntity(kind, value).valid) throw new ProtocolError('schema', 'Invalid protocol entity');
  return value as ProtocolEntities[K];
}

export function validateBindings(input: unknown): ProtocolValidation {
  const errors: ProtocolDiagnostic[] = [];
  const kinds = ['manifest', 'project', 'profile_policy', 'executor', 'work_item', 'run'] as const;
  if (!isJson(input) || input === null || typeof input !== 'object' || Array.isArray(input))
    return { valid: false, authority_verified: false, errors: [{ path: '$', reason: 'Expected a JSON Registry binding bundle' }] };
  const records = input as Record<string, unknown>;
  for (const key of Object.keys(records)) if (!(kinds as readonly string[]).includes(key))
    errors.push({ path: '$.' + key, reason: 'Unknown binding field' });
  for (const kind of kinds) {
    const checked = validateEntity(kind, records[kind]);
    errors.push(...checked.errors.map(e => ({ ...e, path: kind + e.path.slice(1) })));
  }
  if (errors.length) return { valid: false, authority_verified: false, errors };
  const manifest = records.manifest as ProtocolEntities['manifest'], project = records.project as ProtocolEntities['project'];
  const policy = records.profile_policy as ProtocolEntities['profile_policy'], executor = records.executor as ProtocolEntities['executor'];
  const workItem = records.work_item as ProtocolEntities['work_item'], run = records.run as ProtocolEntities['run'];
  const require = (condition: boolean, path: string) => { if (!condition) errors.push({ path, reason: 'Registry binding mismatch' }); };
  require(manifest.project.id === project.id && manifest.project.repository === project.repository, 'manifest.project');
  require(manifest.profile.ref === project.profile_ref && project.profile_ref === policy.ref, 'manifest.profile');
  require(policy.repository === project.repository && run.source.repository === project.repository, 'run.source.repository');
  require(workItem.project_id === project.id && run.project_id === project.id && run.work_item_id === workItem.id, 'run.work_item_id');
  require(run.profile.ref === policy.ref && run.profile.version === policy.version, 'run.profile');
  require(run.executor_id === executor.id && run.machine_id === executor.machine.id, 'run.executor_id');
  if (policy.executor_restrictions) {
    require(policy.executor_restrictions.executor_ids.includes(executor.id), 'profile_policy.executor_restrictions.executor_ids');
    require(policy.executor_restrictions.machine_ids.includes(executor.machine.id), 'profile_policy.executor_restrictions.machine_ids');
  }
  return { valid: errors.length === 0, authority_verified: false, errors };
}
