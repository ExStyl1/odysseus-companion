import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ChildSessionResult } from './spawner.ts';

interface JournalRecord {
  promptHash: string;
  result: ChildSessionResult;
}

/** Render a thrown value without assuming it renders. */
function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch {
    return '(unrenderable error)';
  }
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, stable(entry)]),
  );
}

export function hashWorkflowPrompt(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

export class WorkflowJournal {
  readonly dir: string;
  readonly path: string;
  private readonly cache = new Map<string, ChildSessionResult>();
  /**
   * P2.184 — what replay could NOT read, named for the run's own log.
   *
   * Read once by `workflow-tool.ts` into the run's `logs`, which
   * `contentForResult` renders back to the model and the user. Not a second
   * record: `logs` is the channel a workflow run already has, and the loss
   * belongs on it.
   */
  readonly loadWarnings: string[] = [];

  constructor(sessionPath: string | undefined, runId: string, resumeRunId?: string) {
    this.dir = join(sessionPath || process.cwd(), '.orchestrator');
    this.path = join(this.dir, `${runId}.jsonl`);
    mkdirSync(this.dir, { recursive: true });

    if (resumeRunId) {
      this.load(join(this.dir, `${resumeRunId}.jsonl`));
    }
  }

  get(promptHash: string): ChildSessionResult | undefined {
    const cached = this.cache.get(promptHash);
    return cached ? { ...cached } : undefined;
  }

  record(promptHash: string, result: ChildSessionResult): void {
    const copy = { ...result };
    this.cache.set(promptHash, copy);
    appendFileSync(this.path, `${JSON.stringify({ promptHash, result: copy } satisfies JournalRecord)}\n`);
  }

  /**
   * Replay a previous run's journal into the cache.
   *
   * P2.184 — A PER-ITEM LOOP MUST CONTAIN ITS OWN FAILURE, or one bad item
   * silently becomes zero items processed. This loop was the worst instance of
   * that class in the tree, because of WHICH item is bad: the journal is
   * append-only and written a line at a time, so the one line that can be torn
   * is the LAST one, after a crash — precisely the case an append-only journal
   * exists to survive. A bare `JSON.parse` per line meant that torn tail threw
   * out of `load`, out of the CONSTRUCTOR, and out of `execute` (the
   * `new WorkflowJournal(...)` at `workflow-tool.ts` sits outside its try), so
   * the resume the user asked for died with a raw `SyntaxError` that never
   * mentions the journal — and every good line before the bad one, i.e. the
   * entire completed run being resumed, was discarded to punish it.
   *
   * Now a torn line costs exactly that line, and an unreadable file costs the
   * replay rather than the run. Both are NAMED on `loadWarnings`, which is read
   * into the run's existing `logs`; a silent partial replay would be its own
   * defect, since the model would re-run agents it was told it would not.
   */
  private load(path: string): void {
    if (!existsSync(path)) return;
    let raw: string;
    try {
      raw = readFileSync(path, 'utf-8');
    } catch (error) {
      this.loadWarnings.push(
        `journal replay unavailable (${path}): ${errorText(error)} — every agent() call will run again`,
      );
      return;
    }
    let skipped = 0;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as JournalRecord;
        if (typeof parsed.promptHash === 'string' && parsed.result) {
          this.cache.set(parsed.promptHash, parsed.result);
        } else {
          skipped += 1;
        }
      } catch {
        skipped += 1;
      }
    }
    if (skipped > 0) {
      this.loadWarnings.push(
        `journal replay skipped ${skipped} unreadable line(s) in ${path}; `
          + `${this.cache.size} cached result(s) kept`,
      );
    }
  }
}
