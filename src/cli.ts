import { readFile } from 'node:fs/promises';
import { inputFailure, isFullSha, validateHandoff, type Result } from './validator.js';

const usage = 'Usage: pnpm handoff:check <handoff.json> --expected-head <full-sha>';

async function main(args: string[]): Promise<{ result: Result; exitCode: number }> {
  if (args.length !== 3 || !args[0] || args[0].startsWith('-') || args[1] !== '--expected-head' || !isFullSha(args[2])) {
    return { result: inputFailure('$args', usage), exitCode: 2 };
  }
  let contents: string;
  try {
    contents = await readFile(args[0], 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    return { result: inputFailure('$file', `Cannot read input file (${code})`), exitCode: 2 };
  }
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    return { result: inputFailure('$file', 'Input is not valid JSON (UTF-8 without BOM required)'), exitCode: 2 };
  }
  const result = validateHandoff(value, args[2]);
  return { result, exitCode: result.ready_claim_valid ? 0 : 1 };
}

try {
  const { result, exitCode } = await main(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = exitCode;
} catch {
  process.stdout.write(`${JSON.stringify(inputFailure('$', 'Unexpected CLI failure'))}\n`);
  process.exitCode = 2;
}
