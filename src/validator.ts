export interface Diagnostic {
  category: 'schema' | 'ready' | 'input';
  path: string;
  reason: string;
}

export interface Result {
  schema_valid: boolean;
  ready_claim_valid: boolean;
  authority_verified: false;
  errors: Diagnostic[];
}

export interface BuilderHandoff {
  schema_version: '0.1';
  kind: 'builder_handoff';
  work_item: { repo: string; issue: number };
  candidate: { pr: number; base_sha: string; head_sha: string };
  producer: { executor: string; run_id: string };
  verification: {
    subject_sha: string;
    lifecycle: 'completed' | 'failed' | 'cancelled';
    outcome: 'pass' | 'fail' | 'inconclusive';
    checks: { command: string; exit_code: number }[];
    evidence_refs: string[];
  };
  handoff: { next_step: 'review'; publication: 'pending' | 'confirmed' | 'failed' };
}

export const isFullSha = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-fA-F]{40}$/.test(value);

export function inputFailure(path: string, reason: string): Result {
  return {
    schema_valid: false,
    ready_claim_valid: false,
    authority_verified: false,
    errors: [{ category: 'input', path, reason }],
  };
}

// Validate untrusted values before accessing them as a BuilderHandoff.
// Each object has a closed field list; no extra field confers authority.
export function validateSchema(value: unknown): Diagnostic[] {
  const errors: Diagnostic[] = [];
  const error = (path: string, reason: string) => errors.push({ category: 'schema', path, reason });
  const object = (v: unknown, path: string, keys: string[]): v is Record<string, unknown> => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      error(path, 'Expected an object');
      return false;
    }
    for (const key of keys) {
      if (!Object.hasOwn(v, key)) error(`${path}.${key}`, 'Required field is missing');
    }
    for (const key of Object.keys(v).sort()) {
      if (!keys.includes(key)) error(`${path}.${key}`, 'Unknown field is not allowed');
    }
    return true;
  };
  const field = (v: Record<string, unknown>, key: string, path: string,
    predicate: (value: unknown) => boolean, reason: string) => {
    if (Object.hasOwn(v, key) && !predicate(v[key])) error(`${path}.${key}`, reason);
  };
  const nonempty = (v: unknown) => typeof v === 'string' && v.trim().length > 0;
  const integer = (v: unknown) => Number.isSafeInteger(v);
  const positive = (v: unknown) => typeof v === 'number' && integer(v) && v > 0;
  const enumeration = (...values: string[]) => (v: unknown) =>
    typeof v === 'string' && values.includes(v);
  const sha = (v: Record<string, unknown>, key: string, path: string) =>
    field(v, key, path, isFullSha, 'Expected a full 40-character hexadecimal SHA');
  const nested = (v: Record<string, unknown>, key: string, path: string, keys: string[],
    validate: (value: Record<string, unknown>, path: string) => void) => {
    const childPath = `${path}.${key}`;
    if (Object.hasOwn(v, key) && object(v[key], childPath, keys)) validate(v[key], childPath);
  };
  const array = (v: unknown, path: string, validate: (item: unknown, path: string) => void) => {
    if (!Array.isArray(v) || v.length === 0) {
      error(path, 'Expected a non-empty array');
      return;
    }
    v.forEach((item, index) => validate(item, `${path}[${index}]`));
  };

  if (!object(value, '$', ['schema_version', 'kind', 'work_item', 'candidate', 'producer', 'verification', 'handoff'])) return errors;
  field(value, 'schema_version', '$', enumeration('0.1'), 'Unsupported schema version; expected "0.1"');
  field(value, 'kind', '$', enumeration('builder_handoff'), 'Expected "builder_handoff"');
  nested(value, 'work_item', '$', ['repo', 'issue'], (v, p) => {
    field(v, 'repo', p, (r) => typeof r === 'string' && /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(r), 'Expected owner/name repository format');
    field(v, 'issue', p, positive, 'Expected a positive safe integer');
  });
  nested(value, 'candidate', '$', ['pr', 'base_sha', 'head_sha'], (v, p) => {
    field(v, 'pr', p, positive, 'Expected a positive safe integer');
    sha(v, 'base_sha', p);
    sha(v, 'head_sha', p);
  });
  nested(value, 'producer', '$', ['executor', 'run_id'], (v, p) => {
    field(v, 'executor', p, nonempty, 'Expected a non-blank string');
    field(v, 'run_id', p, nonempty, 'Expected a non-blank string');
  });
  nested(value, 'verification', '$', ['subject_sha', 'lifecycle', 'outcome', 'checks', 'evidence_refs'], (v, p) => {
    sha(v, 'subject_sha', p);
    field(v, 'lifecycle', p, enumeration('completed', 'failed', 'cancelled'), 'Expected completed, failed or cancelled');
    field(v, 'outcome', p, enumeration('pass', 'fail', 'inconclusive'), 'Expected pass, fail or inconclusive');
    if (Object.hasOwn(v, 'checks')) array(v.checks, `${p}.checks`, (check, cp) => {
      if (!object(check, cp, ['command', 'exit_code'])) return;
      field(check, 'command', cp, nonempty, 'Expected a non-blank string');
      field(check, 'exit_code', cp, integer, 'Expected a safe integer');
    });
    if (Object.hasOwn(v, 'evidence_refs')) array(v.evidence_refs, `${p}.evidence_refs`, (ref, rp) => {
      try {
        if (typeof ref !== 'string' || /\s/.test(ref) || !/^https:\/\//i.test(ref)) throw new Error();
        const url = new URL(ref);
        if (url.protocol !== 'https:' || !url.hostname) throw new Error();
      } catch {
        error(rp, 'Expected an absolute https:// URL without whitespace');
      }
    });
  });
  nested(value, 'handoff', '$', ['next_step', 'publication'], (v, p) => {
    field(v, 'next_step', p, enumeration('review'), 'Expected "review"');
    field(v, 'publication', p, enumeration('pending', 'confirmed', 'failed'), 'Expected pending, confirmed or failed');
  });
  return errors;
}

export function validateHandoff(value: unknown, expectedHead: string): Result {
  if (!isFullSha(expectedHead)) return inputFailure('--expected-head', 'Expected a full 40-character hexadecimal SHA');
  const errors = validateSchema(value);
  if (errors.length > 0) return { schema_valid: false, ready_claim_valid: false, authority_verified: false, errors };
  const record = value as BuilderHandoff;
  const requireReady = (condition: boolean, path: string, reason: string) => {
    if (!condition) errors.push({ category: 'ready', path, reason });
  };
  requireReady(record.verification.lifecycle === 'completed', '$.verification.lifecycle', 'Ready requires completed verification');
  requireReady(record.verification.outcome === 'pass', '$.verification.outcome', 'Ready requires a pass outcome');
  record.verification.checks.forEach((check, index) =>
    requireReady(check.exit_code === 0, `$.verification.checks[${index}].exit_code`, 'Ready requires exit code 0'));
  requireReady(record.verification.subject_sha.toLowerCase() === record.candidate.head_sha.toLowerCase(), '$.verification.subject_sha', 'Verification subject must match candidate head SHA');
  requireReady(record.candidate.head_sha.toLowerCase() === expectedHead.toLowerCase(), '$.candidate.head_sha', 'Candidate head must match --expected-head');
  requireReady(record.handoff.publication === 'confirmed', '$.handoff.publication', 'Ready requires confirmed publication');
  return { schema_valid: true, ready_claim_valid: errors.length === 0, authority_verified: false, errors };
}
