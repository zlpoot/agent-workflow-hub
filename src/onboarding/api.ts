import { validId } from '../control-plane/security.js';
import { OfflineOnboardingStore } from './store.js';
import { authenticateOperator, canonical, deny, header, OnboardingError, safeId, serviceAccess, validate } from './security.js';
import { OBSERVATION, type Binding, type ClientPeer, type FixtureChannel, type FixtureRequest, type FixtureResponse, type PairingScope, type TrustedFixtureTransport } from './types.js';

// In-process OFFLINE dispatcher only. Not imported by CP server, CLI or Dashboard.
export class OfflineOnboardingApi {
  constructor(readonly store: OfflineOnboardingStore, readonly transport: TrustedFixtureTransport) {}
  private client(request: FixtureRequest, channel: FixtureChannel): ClientPeer {
    const peer = this.transport.peer(channel);
    if (!peer || peer.kind !== 'client' || !peer.verified) deny(401, 'client_channel');
    serviceAccess(peer.scope,this.store.config.service);
    if (['cookie','origin','sec-fetch-site','sec-fetch-mode','forwarded','x-forwarded-host','x-forwarded-proto','x-forwarded-for'].some(k => header(request,k) !== undefined)) deny(403, 'client_channel');
    return peer;
  }
  private requestShape(request: FixtureRequest): void {
    if (!request || Object.getPrototypeOf(request) !== Object.prototype || Object.keys(request).some(k => !['method','path','headers','body'].includes(k)) ||
        Reflect.ownKeys(request).some(k => typeof k !== 'string' || !('value' in Object.getOwnPropertyDescriptor(request,k)!))) deny(400, 'request');
    if (typeof request.method !== 'string' || typeof request.path !== 'string' || request.path.length > 1024 || !request.headers || Object.getPrototypeOf(request.headers) !== Object.prototype) deny(400, 'request');
    let bytes = 0;
    for (const k of Reflect.ownKeys(request.headers)) {
      const property = Object.getOwnPropertyDescriptor(request.headers,k)!;
      if (typeof k !== 'string' || !property.enumerable || !('value' in property) ||
          typeof property.value !== 'string' && (!Array.isArray(property.value) || !property.value.every((v: unknown) => typeof v === 'string'))) deny(400, 'request');
      bytes += k.length + String(property.value).length;
    }
    if (Object.keys(request.headers).length > 64 || bytes > 16*1024) deny(413, 'request_too_large');
    if (request.method !== 'GET' && request.method !== 'POST') deny(405, 'method_not_allowed');
    if (request.method === 'GET' && request.body !== undefined) deny(400, 'request');
  }
  async handle(request: FixtureRequest, channel: FixtureChannel): Promise<FixtureResponse> {
    try {
      this.requestShape(request);
      let result: Record<string,unknown>, responseSchema: Parameters<typeof validate>[0];
      if (request.path.startsWith('/onboarding/v1/')) {
        const peer = this.transport.peer(channel);
        if (!peer || peer.kind !== 'operator') deny(401, 'operator_unauthorized');
        const config = this.store.config, operator = authenticateOperator(request,peer,config.service,config.operators,this.store.now());
        if (request.method === 'POST') {
          if (header(request,'content-type') !== 'application/json' || header(request,'content-encoding') !== undefined) deny(400, 'content_type');
          const nonce = header(request,'x-awh-nonce'); if (!nonce || !validId(nonce)) deny(403, 'nonce');
          this.store.consumeNonce(operator,nonce);
        }
        const match = /^\/onboarding\/v1\/(requests|projects|invitations)\/([A-Za-z0-9_.:-]+)(?:\/(decision|diagnostics|revoke))?$/.exec(request.path);
        if (match) safeId(match[2]!);
        if (request.method === 'GET' && request.path === '/onboarding/v1/nonce') { result=this.store.nonce(operator); responseSchema='Nonce'; }
        else if (request.method === 'POST' && request.path === '/onboarding/v1/requests') {
          result=this.store.request(operator,validate<Binding>('ProjectRequest',request.body)); responseSchema='RequestView';
        } else if (request.method === 'POST' && match?.[1] === 'requests' && match[3] === 'decision') {
          const body=validate<{decision:'approve'|'reject'}>('Decision',request.body);
          result=this.store.decide(operator,match[2]!,body.decision); responseSchema='RequestView';
        } else if (request.method === 'GET' && match?.[1] === 'requests' && !match[3]) { result=this.store.readRequest(operator,match[2]!); responseSchema='RequestView'; }
        else if (request.method === 'POST' && request.path === '/onboarding/v1/invitations') {
          const {delivery_id,...scope}=validate<PairingScope & {delivery_id:string}>('InvitationRequest',request.body);
          const delivery=this.transport.delivery(delivery_id); if (!delivery) deny(403,'delivery_binding');
          result=this.store.createInvitation(operator,scope,delivery); responseSchema='InvitationView';
        } else if (request.method === 'POST' && match?.[1] === 'invitations' && match[3] === 'revoke') {
          validate('Empty',request.body); result=this.store.revoke(operator,match[2]!); responseSchema='InvitationView';
        } else if (request.method === 'GET' && match?.[1] === 'projects' && match[3] === 'diagnostics') {
          result=this.store.diagnostics(match[2]!,operator); responseSchema='Diagnostics';
        } else if (request.method === 'GET' && /^\/onboarding\/v1\/audit(?:\?after=(?:0|[1-9][0-9]{0,14}))?$/.test(request.path)) {
          const after=Number(request.path.split('=')[1] ?? '0'); if (!Number.isSafeInteger(after)) deny(400,'cursor');
          result=this.store.readAudit(operator,after); responseSchema='Audit';
        } else deny(404,'not_found');
      } else if (request.path.startsWith('/pairing/v1/')) {
        const peer=this.client(request,channel);
        if (request.method === 'POST' && request.path === '/pairing/v1/claim') {
          if (header(request,'content-type') !== 'application/json' || header(request,'content-encoding') !== undefined) deny(400,'content_type');
          const match=/^Pairing (awh_pair_[A-Za-z0-9_-]{43})$/.exec(header(request,'authorization') ?? ''); if (!match) deny(401,'pairing_denied');
          const {invitation_id,git_root_verified:_,user_confirmed:__,...scope}=validate<PairingScope & {invitation_id:string;git_root_verified:true;user_confirmed:true}>('ClaimRequest',request.body);
          result=this.store.claim(invitation_id,match[1]!,scope,peer); responseSchema='ClaimView';
        } else if (request.method === 'GET' && /^\/pairing\/v1\/diagnostics\/[A-Za-z0-9_.:-]+$/.test(request.path)) {
          const id=request.path.split('/').at(-1)!; safeId(id);
          const match=/^Bearer (awh_cp_[A-Za-z0-9_-]{43})$/.exec(header(request,'authorization') ?? '');
          const client=match ? this.store.authenticateClient(match[1]!) : null;
          if (!client || canonical(client) !== canonical(peer.scope)) deny(401,'client_unauthorized');
          result=this.store.diagnostics(id,undefined,client); responseSchema='Diagnostics';
        } else deny(404,'not_found');
      } else deny(404,'not_found');
      try { validate(responseSchema,result); } catch { deny(500,'projection'); }
      return {status:200,body:result};
    } catch (error) {
      const status=error instanceof OnboardingError ? error.status : (error as {errcode?:number})?.errcode===5 ? 503 : 500;
      const code=error instanceof OnboardingError ? error.code : status===503 ? 'busy' : 'internal';
      try { this.store.recordDenied(code); } catch { /* Database outage never grants trust. */ }
      return {status,body:{error:{code,message:'受信接入请求未通过安全校验'},...OBSERVATION}};
    }
  }
}
