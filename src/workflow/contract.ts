/** Domain-neutral envelopes. Source and Executor adapters own domain facts and authority checks. */
export interface Reference { source: string; kind: string; id: string; uri?: string }
export interface Provenance { source: string; subject: Reference; digest?: string }
export interface HumanGate { id: string; role: string; disposition: 'pending' | 'accepted' | 'rejected'; provenance: Provenance[] }
export interface WorkflowStage {
  contract_version: '1.0'; workflow: string; stage: string;
  project: Reference; work_item: Reference; executor: Reference; machine: Reference;
  authorization: Provenance; inputs: Reference[]; next_gate: HumanGate;
}
export interface StageFacts { run: Reference; events: Reference[]; outputs: Reference[]; evidence: Provenance[]; next_gate: HumanGate }
export type StageResult = { status: 'awaiting_review'; contract: WorkflowStage; facts: StageFacts } |
  { status: 'BLOCKED'; code: string; recovery: string; contract?: WorkflowStage };
export interface ExecutorAdapter {
  preflight(): Promise<WorkflowStage>;
  execute(contract: WorkflowStage): Promise<void>;
  postcondition(contract: WorkflowStage): Promise<StageFacts>;
}
/** No scheduler, model API, Provider writer, or independent Review lives in this kernel. */
export async function executeStage(adapter: ExecutorAdapter): Promise<StageResult> {
  let contract: WorkflowStage | undefined;
  try {
    contract = await adapter.preflight();
    await adapter.execute(contract);
    const facts = await adapter.postcondition(contract);
    if (!facts.run || !facts.events.length || !facts.outputs.length || !facts.evidence.length || facts.next_gate.disposition !== 'pending')
      throw new Error('stage_postcondition');
    return {status:'awaiting_review',contract,facts};
  } catch (error) {
    return {status:'BLOCKED',code:error instanceof Error && 'code' in error ? String(error.code) : 'stage_postcondition_or_operation',
      recovery:'Retain Session/Journal/Outbox/Receipt and raw failures. Observe uncertain Provider effects before recovery; never repeat an unacknowledged write.',...(contract ? {contract} : {})};
  }
}
