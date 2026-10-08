// Generate the runtime schema and OpenAPI together; no server, config or credentials.
import { writeFileSync, mkdirSync } from 'node:fs';
const object = properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const id = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' };
const text = { type: 'string', minLength: 1, maxLength: 128 };
const repository = { type: 'string', pattern: '^[A-Za-z0-9-]+/[A-Za-z0-9_.-]+$', maxLength: 200 };
const ref = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*$', maxLength: 128 };
const hash = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const timestamp = { type: 'string', format: 'date-time' };
const link = name => ({ $ref: '#/$defs/' + name });
const binding = { project_id: id, repository, profile_ref: ref, profile_version: id };
const scope = { ...binding, client_id: id, executor_id: id, executor_type: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,63}$' },
 machine_id: id, platform: { enum: ['windows', 'macos', 'linux'] }, service_id: id,
 endpoint: { type: 'string', minLength: 1, maxLength: 200 }, ca_sha256: { anyOf: [hash, { type: 'null' }] } };
const common = { authority_verified: { const: false }, source: { const: 'offline_fixture' } };
const schemas = {
 ProjectRequest: object(binding), Decision: object({ decision: { enum: ['approve', 'reject'] } }), Empty: object({}),
 InvitationRequest: object({ ...scope, delivery_id: id }),
 ClaimRequest: object({ invitation_id: id, ...scope, git_root_verified: { const: true }, user_confirmed: { const: true } }),
 RequestView: object({ id, ...binding, state: { enum: ['pending', 'approved', 'rejected'] }, created_at: timestamp, ...common }),
 InvitationView: object({ id, project_id: id, state: { enum: ['active', 'claimed', 'revoked', 'expired', 'locked'] }, expires_at: timestamp, attempts_remaining: { type: 'integer', minimum: 0, maximum: 3 }, ...common }),
 ClaimView: object({ client_id: id, project_id: id, state: { enum: ['active'] }, git_identity: { const: 'client_local_claim' }, ...common }),
 Nonce: object({ nonce: id, expires_at: timestamp, ...common }),
 Check: object({ state: { enum: ['passed', 'blocked', 'not_checked'] }, code: { type: 'string', pattern: '^[a-z_]+$' } }),
 Diagnostics: object({ project_id: id, state: { enum: ['blocked', 'not_checked'] }, binding: { anyOf: [link('ProjectRequest'), { type: 'null' }] },
  policy: { anyOf: [object({ branch: text, verification_commands: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 200 }, maxItems: 16 } }), { type: 'null' }] },
  checks: object({ enrollment: link('Check'), client: link('Check'), git_identity: link('Check'), branch_verification: link('Check'), provider_app_permissions: link('Check') }), ...common }),
 AuditEntry: object({ cursor: { type: 'integer', minimum: 1 }, at: timestamp, actor: id, action: { type: 'string', pattern: '^[a-z_]+$' }, target: id,
  project_id: { anyOf: [id, { type: 'null' }] }, repository: { anyOf: [repository, { type: 'null' }] }, result: { enum: ['accepted', 'denied'] }, code: { type: 'string', pattern: '^[a-z_]+$' } }),
 Audit: object({ entries: { type: 'array', maxItems: 100, items: link('AuditEntry') }, next_cursor: { type: 'integer', minimum: 0 }, ...common }),
 Error: object({ error: object({ code: { type: 'string', pattern: '^[a-z_]+$' }, message: { type: 'string', maxLength: 160 } }), ...common })
};
const schema = { $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'https://agent-workflow-hub.invalid/onboarding/v1', $defs: schemas };
mkdirSync(new URL('../src/onboarding/', import.meta.url), { recursive: true });
writeFileSync(new URL('../src/onboarding/schema.json', import.meta.url), JSON.stringify(schema, null, 2) + '\n');
const apiRef = name => ({ $ref: '#/components/schemas/' + name });
const response = name => ({ description: '脱敏 fixture 响应；不代表生产验收或 GitHub 权限。', content: { 'application/json': { schema: apiRef(name) } } });
const paths = {};
for (const [path,method,name,security,body,output] of [
 ['/onboarding/v1/nonce','get','issueNonce','OperatorSession',null,'Nonce'],
 ['/onboarding/v1/requests','post','requestProject','OperatorSession','ProjectRequest','RequestView'],
 ['/onboarding/v1/requests/{id}/decision','post','decideProject','OperatorSession','Decision','RequestView'],
 ['/onboarding/v1/requests/{id}','get','readProjectRequest','OperatorSession',null,'RequestView'],
 ['/onboarding/v1/invitations','post','createInvitation','OperatorSession','InvitationRequest','InvitationView'],
 ['/onboarding/v1/invitations/{id}/revoke','post','revokeInvitation','OperatorSession','Empty','InvitationView'],
 ['/onboarding/v1/projects/{id}/diagnostics','get','operatorDiagnostics','OperatorSession',null,'Diagnostics'],
 ['/onboarding/v1/audit','get','readAudit','OperatorSession',null,'Audit'],
 ['/pairing/v1/claim','post','claimInvitation','PairingMaterial','ClaimRequest','ClaimView'],
 ['/pairing/v1/diagnostics/{id}','get','clientDiagnostics','ClientCredential',null,'Diagnostics']
]) {
 const parameters = path.includes('{id}') ? [{ in: 'path', name: 'id', required: true, schema: id }] : [];
 if (name === 'readAudit') parameters.push({ in: 'query', name: 'after', required: false, schema: { type: 'integer', minimum: 0 } });
 if (method === 'post' && security === 'OperatorSession') parameters.push({ in: 'header', name: 'x-awh-nonce', required: true, schema: id }, { in: 'header', name: 'Origin', required: true, schema: { type: 'string' } });
 const operation = { operationId: name, summary: name, security: [{ [security]: [] }], parameters,
  responses: Object.fromEntries(['200','400','401','403','404','405','409','410','413','429','500','503'].map(code => [code, response(code === '200' ? output : 'Error')])) };
 if (body) operation.requestBody = { required: true, content: { 'application/json': { schema: apiRef(body) } } };
 if (name === 'createInvitation') operation.description = '仅返回非敏感 id/state/expiry。配对材料只经单独受信 CLI/Client delivery sink；无 browser secret。';
 if (name === 'claimInvitation') operation.description = '专用 Client 受信通道；拒绝浏览器 Cookie/Origin。credential 仅经私有 Client sink 发送，JSON 无 bearer。';
 (paths[path] ??= {})[method] = operation;
}
const components = JSON.parse(JSON.stringify(schemas).replaceAll('#/$defs/', '#/components/schemas/'));
writeFileSync(new URL('../contracts/onboarding-v1.openapi.json', import.meta.url), JSON.stringify({
 openapi: '3.1.0', info: { title: 'AWH Trusted Onboarding 离线契约', version: '1.0.0', description: 'Hub #31。仅 fixture dispatcher；未开放生产 Operator/Pairing 路由。生产通道、安全会话、旧 v2 集成需独立 Gate。' },
 paths, components: { schemas: components, securitySchemes: {
  OperatorSession: { type: 'apiKey', in: 'cookie', name: 'awh_operator', description: '独立受信 Operator session；不接受 Viewer 或 CP Client。POST 另需 Origin 与 one-use nonce。' },
  PairingMaterial: { type: 'apiKey', in: 'header', name: 'Authorization', description: 'Pairing awh_pair_<256-bit>，仅可信非浏览器 Client 通道；禁止日志/URL/browser。' },
  ClientCredential: { type: 'http', scheme: 'bearer', description: 'awh_cp_<256-bit> 专用 Client credential；只有已认领单 project/executor scope。' }
 } }
}, null, 2) + '\n');
