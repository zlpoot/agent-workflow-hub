/** Shared observation DTO. A comparison never grants Provider or execution authority. */
export type PreflightStatus = 'passed' | 'blocked' | 'not_checked';
export interface PolicyFacts {
  repository: string; issue_repository: string; issue: number; base: string; branch: string;
  executor: string; checks: readonly string[]; profile_ref: string; profile_version: string; work_item_version: string;
}
export interface PolicyDifference { field: keyof PolicyFacts; status: PreflightStatus; expected: string | number | readonly string[] | null; observed: string | number | readonly string[] | null }
export interface PolicyPreflight {
  schema_version: '1.0'; kind: 'policy_preflight'; stage: 'observe' | 'develop'; status: PreflightStatus;
  approved_effective: Partial<PolicyFacts>; differences: PolicyDifference[]; provider_scope: 'not_checked';
  execution: 'declarations_only'; deliver: 'blocked'; authority_verified: false;
}
export function comparePolicy(approved: Partial<PolicyFacts>, observed: Partial<PolicyFacts>, stage: 'observe' | 'develop' = 'observe'): PolicyPreflight {
  const fields: (keyof PolicyFacts)[] = ['repository','issue_repository','issue','base','branch','executor','checks','profile_ref','profile_version','work_item_version'];
  const differences = fields.map(field => ({ field,
    expected: approved[field] ?? null, observed: observed[field] ?? null,
    status: approved[field] === undefined || observed[field] === undefined ? 'not_checked' as const : JSON.stringify(approved[field]) === JSON.stringify(observed[field]) ? 'passed' as const : 'blocked' as const }));
  return { schema_version: '1.0', kind: 'policy_preflight', stage,
    status: differences.some(d => d.status === 'blocked') ? 'blocked' : differences.some(d => d.status === 'not_checked') ? 'not_checked' : 'passed',
    approved_effective: structuredClone(approved), differences, provider_scope: 'not_checked', execution: 'declarations_only', deliver: 'blocked', authority_verified: false };
}
export function formatPreflight(value: PolicyPreflight): string {
  return [`${value.stage}: ${value.status}`, ...value.differences.map(d => `${d.status} ${d.field}: approved=${JSON.stringify(d.expected)} observed=${JSON.stringify(d.observed)}`),
    'provider_scope=not_checked execution=declarations_only deliver=blocked authority_verified=false'].join('\n');
}
