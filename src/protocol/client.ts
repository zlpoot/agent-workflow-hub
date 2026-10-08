import { ProtocolError, isJson } from './validation.js';

// C1-C HTTP registration metadata. The closed C1-A Executor entity is unchanged.
export interface ClientMetadata {
  schema_version: '1.0'; executor_type: string; machine_name: string; arch: string; client_version: string;
}
export function assertClientMetadata(value: unknown): ClientMetadata {
  const v = value as ClientMetadata | null;
  if (!isJson(value) || !v || Array.isArray(v) || Object.keys(v).sort().join(',') !== 'arch,client_version,executor_type,machine_name,schema_version' ||
      v.schema_version !== '1.0' || typeof v.executor_type !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(v.executor_type) ||
      typeof v.machine_name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,252}$/.test(v.machine_name) ||
      typeof v.arch !== 'string' || !/^[a-z0-9_]{1,32}$/.test(v.arch) ||
      typeof v.client_version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(v.client_version))
    throw new ProtocolError('schema', 'Invalid Client registration metadata');
  return v;
}
