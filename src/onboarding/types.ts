import type { ProfilePolicy } from '../protocol/index.js';

export interface Binding { project_id: string; repository: string; profile_ref: string; profile_version: string }
export interface PairingScope extends Binding {
  client_id: string; executor_id: string; executor_type: string; machine_id: string;
  platform: 'windows' | 'macos' | 'linux'; service_id: string; endpoint: string; ca_sha256: string | null;
}
export interface OperatorSession {
  id: string; role: 'requester' | 'operator'; repository_scope: string[]; session_sha256: string; expires_at: number;
}
export interface OperatorPrincipal { id: string; role: 'requester' | 'operator'; repository_scope: readonly string[]; session_sha256: string }
export interface ServiceBinding { service_id: string; endpoint: string; ca_sha256: string | null; operator_origin: string }
export interface ReservedClient { client_id: string; executor_id: string; machine_id: string; project_id: string }
export interface FixtureConfig {
  service: ServiceBinding; profiles: ProfilePolicy[]; operators: OperatorSession[];
  reserved_projects: Binding[]; reserved_clients: ReservedClient[];
}
export interface FixtureRequest { method: string; path: string; headers: Record<string, string | string[]>; body?: unknown }
export interface FixtureResponse { status: number; body: Record<string, unknown> }
export type FixtureChannel = object;
export interface ClientPeer {
  kind: 'client'; scope: PairingScope; verified: boolean;
  deliverInvitation: (id: string, material: string) => void;
  provisionCredential: (credential: string) => void;
}
export interface OperatorPeer { kind: 'operator'; origin: string; local_address: string; remote_address: string; verified: boolean }
export type FixturePeer = ClientPeer | OperatorPeer;
export interface TrustedFixtureTransport {
  peer(channel: FixtureChannel): FixturePeer | null;
  delivery(id: string): ClientPeer | null;
}
export const OBSERVATION = Object.freeze({ authority_verified: false as const, source: 'offline_fixture' as const });
