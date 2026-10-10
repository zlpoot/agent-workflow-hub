#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { BuilderError, connectBuilder } from './builder.js';
import { DEFAULT_SELECTION, ProfileError, selectWorkflow, type BuilderSelection } from './profiles.js';
import { RELEASE_VERSION } from './release/version.js';

// Validate the entire command before reading a key or making any request.
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--version') { console.log(RELEASE_VERSION); process.exit(0); }
if (args.length === 1 && args[0] === '--help') {
  console.log('awh-builder [--profile <fixed-profile> --workflow <fixed-workflow>] <operation>\nOperations: preflight, push, pr-create, pr-update, pr-read, comment-create, comment-edit, comment-read, pr-ready. Fixed trusted policies only; App credentials required for network operations. Install help/version grants no authority.'); process.exit(0);
}
let selection: BuilderSelection = DEFAULT_SELECTION;
if (args[0] === '--profile' && args[2] === '--workflow') {
  selection = { profile: args[1] ?? '', workflow: args[3] ?? '' };
  args.splice(0, 4);
}
const sizes: Record<string, number> = { preflight: 1, push: 1, 'pr-create': 3, 'pr-update': 4,
  'pr-read': 2, 'comment-create': 3, 'comment-edit': 4, 'comment-read': 3, 'pr-ready': 5 };
const op = args[0] ?? '';
const number = (v: string | undefined) => {
  if (!v || !/^[1-9]\d*$/.test(v) || !Number.isSafeInteger(Number(v))) throw new BuilderError('Invalid object number');
  return Number(v);
};
const file = async (path: string | undefined) => {
  if (!path || path.startsWith('-')) throw new BuilderError('Invalid body file argument');
  try { return await readFile(path, 'utf8'); } catch { throw new BuilderError('Body file unavailable'); }
};
try {
  selectWorkflow(selection);
  if (!Object.hasOwn(sizes, op) || args.length !== sizes[op]) throw new BuilderError('Unsupported Builder operation or arguments');
  const pr = ['pr-update', 'pr-read', 'comment-create', 'comment-edit', 'comment-read', 'pr-ready'].includes(op) ? number(args[1]) : 0;
  const comment = ['comment-edit', 'comment-read'].includes(op) ? number(args[2]) : op === 'pr-ready' ? number(args[4]) : 0;
  if (op === 'pr-ready' && !/^[a-f0-9]{40}$/i.test(args[2] ?? '')) throw new BuilderError('Invalid expected head');
  let body = '';
  if (['pr-create', 'pr-update', 'comment-create', 'comment-edit', 'pr-ready'].includes(op))
    body = await file(args[op === 'pr-create' || op === 'comment-create' ? 2 : 3]);
  let record: unknown;
  if (op === 'pr-ready') { try { record = JSON.parse(body); } catch { throw new BuilderError('Invalid Handoff JSON'); } }
  const builder = await connectBuilder({}, selection);
  const result = op === 'preflight' ? builder.preflight() : op === 'push' ? await builder.push() :
    op === 'pr-create' ? await builder.createPR(args[1]!, body) :
    op === 'pr-update' ? await builder.updatePR(pr, args[2]!, body) :
    op === 'pr-read' ? await builder.readPR(pr) :
    op === 'comment-create' ? await builder.createComment(pr, body) :
    op === 'comment-edit' ? await builder.editComment(pr, comment, body) :
    op === 'comment-read' ? await builder.readComment(pr, comment) :
    await builder.ready(pr, args[2]!, record, comment);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (e) {
  process.stderr.write(`${JSON.stringify({ error: e instanceof BuilderError || e instanceof ProfileError ? e.message : 'Builder command failed (details suppressed)',
    ...(e instanceof BuilderError && e.stage ? { stage: e.stage } : {}),
    ...(e instanceof BuilderError && e.category ? { category: e.category } : {}),
    ...(e instanceof BuilderError && e.suppression_reason ? { suppression_reason: e.suppression_reason } : {}) })}\n`);
  process.exitCode = 2;
}
