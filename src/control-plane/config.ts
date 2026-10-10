import { readExternalFile, absoluteDeploymentPath } from '../shared/external-files.js';
import { fail, safeData } from '../shared/security.js';
import { createAuthenticator, type RegisteredClient } from './security.js';
import { assertEntity, type ProfilePolicy } from '../protocol/index.js';
import { enrollmentGrants, type EnrollmentGrant } from '../shared/enrollment.js';

export interface RuntimeConfig {
  schema_version: '1.0'; database: string; trusted_config_file: string; port: number; https_config_file?: string;
}
export function readRuntimeConfig(path: string): RuntimeConfig {
  const config = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readExternalFile(path, 16 * 1024)));
  safeData(config);
  if (!config || Array.isArray(config) || config.schema_version !== '1.0' ||
      Object.keys(config).some(key => !['schema_version','database','trusted_config_file','port','https_config_file'].includes(key)) ||
      !['database','trusted_config_file','port'].every(key => Object.hasOwn(config, key)) ||
      typeof config.database !== 'string' || typeof config.trusted_config_file !== 'string' ||
      !Number.isInteger(config.port) || config.port < 1 || config.port > 65535 ||
      config.https_config_file !== undefined && typeof config.https_config_file !== 'string')
    fail(500, 'configuration', 'Invalid closed versioned Control Plane deployment configuration');
  absoluteDeploymentPath(config.database); absoluteDeploymentPath(config.trusted_config_file);
  if (config.https_config_file !== undefined) absoluteDeploymentPath(config.https_config_file);
  return config;
}
export function readTrustedConfig(path: string): { clients: RegisteredClient[]; profiles: ProfilePolicy[]; enrollments: EnrollmentGrant[] } {
  const config = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readExternalFile(path, 64 * 1024)));
  safeData(config);
  if (!config || Array.isArray(config) || !['clients,profiles','clients,enrollments,profiles'].includes(Object.keys(config).sort().join(',')) ||
      !Array.isArray(config.profiles) || !config.profiles.length || config.profiles.length > 256)
    fail(500, 'configuration', 'Trusted config must contain only explicit clients and profiles');
  const grants = enrollmentGrants(config.enrollments ?? []);
  createAuthenticator(config.clients, grants);
  config.profiles.forEach((policy: unknown) => assertEntity('profile_policy', policy));
  const versions = config.profiles.map((policy: ProfilePolicy) => policy.ref + '\0' + policy.version);
  if (new Set(versions).size !== versions.length) fail(500, 'configuration', 'Duplicate trusted Profile versions');
  return { ...config, enrollments: grants };
}
