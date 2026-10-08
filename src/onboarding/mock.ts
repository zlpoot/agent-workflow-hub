import { randomBytes } from 'node:crypto';
import { validate, deny, hash } from './security.js';
import { OfflineOnboardingApi } from './api.js';
import type { ClientPeer, FixtureChannel, FixturePeer, FixtureRequest, FixtureResponse, OperatorPeer, OperatorSession, PairingScope, TrustedFixtureTransport } from './types.js';

// Test-only adapter. No sockets, HTTP, TLS, OS credentials, browser or project disk reads.
export class MockFixtureTransport implements TrustedFixtureTransport {
  readonly #channels=new WeakMap<FixtureChannel,FixturePeer>();
  readonly #deliveries=new Map<string,ClientPeer>();
  peer(channel: FixtureChannel): FixturePeer|null { return this.#channels.get(channel) ?? null; }
  delivery(id: string): ClientPeer|null { return this.#deliveries.get(id) ?? null; }
  operator(origin: string, changes: Partial<OperatorPeer>={}): FixtureChannel {
    const channel=Object.freeze({}); this.#channels.set(channel,{kind:'operator',origin,local_address:'127.0.0.1',remote_address:'127.0.0.1',verified:true,...changes}); return channel;
  }
  client(scope: PairingScope, deliveryId: string, changes: {verified?:boolean; fail_invitation?:boolean; fail_credential?:boolean}={}): MockPairingClient {
    validate('ClaimRequest',{...scope,invitation_id:'fixture-validation',git_root_verified:true,user_confirmed:true});
    if (this.#deliveries.has(deliveryId)) deny(500,'configuration');
    const client=new MockPairingClient(scope), channel=Object.freeze({});
    const peer: ClientPeer={kind:'client',scope:structuredClone(scope),verified:changes.verified ?? true,
      deliverInvitation:(id,secret)=>{ if(changes.fail_invitation) throw Error('Fixture invitation delivery rejected'); client.receiveInvitation(id,secret); },
      provisionCredential:secret=>{ client.receiveCredential(secret); if(changes.fail_credential) throw Error('Fixture credential delivery rejected'); }};
    client.setChannel(channel); this.#channels.set(channel,peer); this.#deliveries.set(deliveryId,peer); return client;
  }
}
export class MockPairingClient {
  readonly #scope: PairingScope;
  #channel: FixtureChannel={}; #id='missing'; #material=''; #credential=''; readonly #secrets:string[]=[];
  constructor(scope: PairingScope) { this.#scope=structuredClone(scope); }
  get channel(): FixtureChannel { return this.#channel; }
  setChannel(channel: FixtureChannel): void { this.#channel=channel; }
  receiveInvitation(id: string, secret: string): void { this.#id=id; this.#material=secret; this.#secrets.push(secret); }
  receiveCredential(secret: string): void { this.#credential=secret; this.#secrets.push(secret); }
  containsSecret(text: string): boolean { return this.#secrets.some(secret=>text.includes(secret)); }
  borrowInvitationFrom(other: MockPairingClient): void { this.#id=other.#id; this.#material=other.#material; }
  // Fixture worker transfer is memory-only to a simulated Client, never logged/serialized to disk/UI.
  workerClaimEnvelope(changes: Record<string,unknown>={}, material?:string): FixtureRequest {
    return {method:'POST',path:'/pairing/v1/claim',headers:{'content-type':'application/json',authorization:'Pairing '+(material ?? this.#material)},
      body:{invitation_id:this.#id,...this.#scope,git_root_verified:true,user_confirmed:true,...changes}};
  }
  claim(api: OfflineOnboardingApi, changes: Record<string,unknown>={}, material?:string): Promise<FixtureResponse> {
    return api.handle(this.workerClaimEnvelope(changes,material),this.#channel);
  }
  diagnostics(api: OfflineOnboardingApi, projectId=this.#scope.project_id): Promise<FixtureResponse> {
    return api.handle({method:'GET',path:'/pairing/v1/diagnostics/'+projectId,headers:{authorization:'Bearer '+this.#credential}},this.#channel);
  }
  // Existing CP authenticator compatibility: the request stays inside the simulated Client.
  authenticateWith(authenticate: (request: never)=>unknown): unknown {
    return authenticate({headers:{authorization:'Bearer '+this.#credential},headersDistinct:{authorization:['Bearer '+this.#credential]}} as never);
  }
}
export function mockOperator(id: string, role: OperatorSession['role'], repositories: string[], expires: number) {
  const cookie='awh_op_'+randomBytes(32).toString('base64url');
  return {cookie,session:{id,role,repository_scope:repositories,session_sha256:hash(cookie,'operator\0'),expires_at:expires} satisfies OperatorSession};
}
