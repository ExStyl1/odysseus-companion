/**
 * UA3.2 — adapted from craft-agents-oss `v0.13.4:packages/shared/src/tasks/storage.ts` (Apache-2.0).
 *
 * Stated divergences (plan UA3.2 "Adaptations", spec §10 "Library"):
 *
 * 1. **`js-yaml` replaces upstream's `yaml`** — `js-yaml` is already a root dependency and already this package's
 *    YAML reader (`plugins/format-adapters/shared.ts`); `yaml` is not ours and is not added. Both directions use
 *    `CORE_SCHEMA`, js-yaml's YAML 1.2 core resolver — the schema upstream's `yaml` parses with by default — so a
 *    date-shaped scalar stays a string (js-yaml's DEFAULT_SCHEMA would make it a `Date`, which no `z.string()` field
 *    accepts) and no `!!js/*` or custom tag is honoured. `dump` takes `noRefs` (never emit anchors/aliases) and
 *    `skipInvalid` (drop an `undefined` value, as upstream's `stringify` omits it, instead of throwing).
 * 2. **`run-started` carries the run's `params`** — upstream logs none and its rehydrate re-resolves the spec's
 *    DEFAULTS (upstream defect 11 in spec §19: "Resume from the live `task.yaml` and default params"), so a resumed
 *    run silently lost the values it was started with. The field is optional: a log written without it reads as
 *    before. Its reader is the Conductor's resume (UA4.3).
 * 3. **`run-started` and `node-spawned` carry the orchestrator's `permissionMode`** (UA12.152): the mode the run
 *    started under, and the effective mode each child was dispatched in. A restart demotes a persisted
 *    `bypassPermissions` orchestrator to the new-session start mode (the session resume table), so the LIVE mode
 *    read at a rehydrate dispatch is not the mode the run was granted — the resumed child spawned narrower, its
 *    card was never answered and the run wedged. Both fields are optional: a log written without them (every run
 *    started before UA12.152) reads as before. Readers: the Conductor's hydrate (the recorded ceiling).
 *    UA12.173: `node-spawned.permissionMode` is the CHILD's mode (after a node override's clamp, e.g. `plan` under a
 *    bypass orchestrator), so reading it as the run's ceiling narrowed every later re-dispatch; the ceiling now rides
 *    its own optional `ceilingPermissionMode`, which is the carrier (a `node-spawned` without it carries nothing).
 *
 * The workspace `tasks/` root this module writes ({@link tasksRoot}: `CONFIG_DIR/workspaces/<id>/tasks`) is disjoint
 * from the Pi task-list root `CONFIG_DIR/tasks` that `sessions/retention-sweep.ts` sweeps — pinned by
 * `tasks-root-disjoint.test.ts`.
 */
/**
 * Task + run-state persistence.
 *
 * Layout under the workspace root (architecture §6, LOCKED #6):
 *   {workspaceRoot}/tasks/<slug>/task.yaml                    — the editable spec
 *   {workspaceRoot}/tasks/<slug>/runs/<runId>/run-log.jsonl   — append-only run log
 *   {workspaceRoot}/tasks/<slug>/runs/<runId>/nodes/<id>.json — per-node output
 *
 * The run log is the durability substrate: replaying it re-derives scheduling
 * decisions and reuses recorded node outputs (it never re-runs a node body).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, appendFileSync, rmSync } from 'fs';
import { join } from 'path';
import { CORE_SCHEMA, dump as dumpYaml, load as loadYaml } from 'js-yaml';
import { atomicWriteFileSync, stripBom } from '../utils/files.ts';
import type { PermissionMode } from '../agent/mode-types.ts';
import { validateTaskInput } from './validate.ts';
import { SLUG_RE, TaskSpecSchema, type TaskSpec } from './schema.ts';
import type { NodeOutput } from './refs.ts';
import type { ValidationResult } from '../config/validators.ts';

const TASKS_DIR = 'tasks';
const TASK_FILE = 'task.yaml';
const RUNS_DIR = 'runs';
const RUN_LOG = 'run-log.jsonl';
const NODES_DIR = 'nodes';

// ---------------------------------------------------------------------------
// Run-state types
// ---------------------------------------------------------------------------

/** Per-node lifecycle state recorded in the run log. Richer than the board's SubtaskRunState. */
export type NodeRunState = 'pending' | 'running' | 'done' | 'failed' | 'cancelled' | 'skipped';

/** Append-only run-log event. `t` is an ISO-8601 timestamp. */
export type RunLogEntry =
  | {
      t: string;
      kind: 'run-started';
      taskId: string;
      runId: string;
      orchestratorSessionId?: string;
      /** The resolved param values the run started with (Nessy; header, divergence 2). Absent in older logs. */
      params?: Record<string, unknown>;
      /** The orchestrator's permission mode at run start (Nessy; UA12.152, header divergence 3). Absent in older logs. */
      permissionMode?: PermissionMode;
    }
  | { t: string; kind: 'node-scheduled'; nodeId: string }
  | {
      t: string;
      kind: 'node-spawned';
      nodeId: string;
      sessionId: string;
      /** The effective mode this child was dispatched under (Nessy; UA12.152, header divergence 3). Absent in older logs. */
      permissionMode?: PermissionMode;
      /**
       * The CEILING this dispatch was clamped under — the orchestrator's mode, merged with the recorded grant on a
       * rehydrated run (Nessy; UA12.173, header divergence 3). The mode carrier the Conductor reads; absent in older logs.
       */
      ceilingPermissionMode?: PermissionMode;
    }
  | { t: string; kind: 'node-finished'; nodeId: string; sessionId: string; state: NodeRunState; reason?: string }
  /**
   * UB2.8 (B4-15) — the user stopped a step: it WAITS for them (no cancel, no pause) in its own
   * session, status `needs-review`; the turn that completes it later carries its output.
   * `reason` is `'stopped'` (a user's Stop or the timeout one causes).
   */
  | { t: string; kind: 'node-waiting'; nodeId: string; sessionId: string; reason: 'stopped' }
  | { t: string; kind: 'node-retry'; nodeId: string; attempt: number; reason: string }
  | { t: string; kind: 'run-paused' | 'run-resumed' | 'run-stopped' | 'run-completed' | 'run-failed' | 'run-verifying' }
  // UB6.6 — `via: 'decision'` when the verdict was read out of a reply WITHOUT a VERDICT
  // line by the decision model (opt-in layer); absent for a parsed line. `confidence`
  // rides only on decision verdicts: the winning option's confidence (0..1). The UI marks
  // inferred verdicts (`tasks.verdictInferred`).
  | { t: string; kind: 'verdict'; result: 'pass' | 'fail' | 'unparsed'; reason?: string; nodes?: string[]; via?: 'parsed' | 'decision'; confidence?: number }
  | { t: string; kind: 'budget-breach'; metric: 'tokens' | 'parallel' | 'iterations'; value: number; limit: number }
  /** UA4.1 (Nessy) — a turn ran in a node already marked done (the Conductor's settlement gate, spec §11 item 4). */
  | { t: string; kind: 'node-woke-after-done'; nodeId: string; sessionId: string }
  /**
   * UA12.171 (Nessy) — the orchestrator's permission mode was changed DELIBERATELY while this run was live (the
   * host's mode-change doors; the restart demotion writes none). The newest mode carrier: `TaskRunner` header item 15.
   */
  | { t: string; kind: 'mode-changed'; permissionMode: PermissionMode };

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function tasksRoot(workspaceRoot: string): string {
  return join(workspaceRoot, TASKS_DIR);
}
export function taskDir(workspaceRoot: string, slug: string): string {
  return join(workspaceRoot, TASKS_DIR, slug);
}
export function taskYamlPath(workspaceRoot: string, slug: string): string {
  return join(taskDir(workspaceRoot, slug), TASK_FILE);
}
export function runDir(workspaceRoot: string, slug: string, runId: string): string {
  return join(taskDir(workspaceRoot, slug), RUNS_DIR, runId);
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// task.yaml
// ---------------------------------------------------------------------------

/** Parse a task.yaml string → validated spec + issues. Does NOT throw on invalid specs. */
export function parseTaskYaml(yamlText: string): ValidationResult & { spec?: TaskSpec } {
  let raw: unknown;
  try {
    raw = loadYaml(stripBom(yamlText), { schema: CORE_SCHEMA });
  } catch (e) {
    return {
      valid: false,
      errors: [{ file: TASK_FILE, path: 'root', message: `Invalid YAML: ${(e as Error).message}`, severity: 'error' }],
      warnings: [],
    };
  }
  return validateTaskInput(raw);
}

/** Serialize a spec to a task.yaml string. */
export function serializeTaskYaml(spec: TaskSpec): string {
  return dumpYaml(spec, { schema: CORE_SCHEMA, noRefs: true, skipInvalid: true });
}

/** Load + validate the task.yaml for a slug. Returns null if no file exists. */
export function loadTaskSpec(
  workspaceRoot: string,
  slug: string,
): (ValidationResult & { spec?: TaskSpec }) | null {
  const path = taskYamlPath(workspaceRoot, slug);
  if (!existsSync(path)) return null;
  return parseTaskYaml(readFileSync(path, 'utf-8'));
}

/** Write a spec to disk as task.yaml. Validates the shape first; throws on invalid. */
export function saveTaskSpec(workspaceRoot: string, spec: TaskSpec): void {
  const parsed = TaskSpecSchema.safeParse(spec);
  if (!parsed.success) {
    throw new Error(`Refusing to save invalid task spec: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  }
  ensureDir(taskDir(workspaceRoot, parsed.data.id));
  atomicWriteFileSync(taskYamlPath(workspaceRoot, parsed.data.id), serializeTaskYaml(parsed.data));
}

/** List task slugs (subdirectories of tasks/ that contain a task.yaml). */
export function listTaskSlugs(workspaceRoot: string): string[] {
  const root = tasksRoot(workspaceRoot);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, d.name, TASK_FILE)))
    .map((d) => d.name)
    .sort();
}

// ---------------------------------------------------------------------------
// Run log
// ---------------------------------------------------------------------------

/** Append one entry to the run log (creates the run dir on first write). */
export function appendRunLog(workspaceRoot: string, slug: string, runId: string, entry: RunLogEntry): void {
  const dir = runDir(workspaceRoot, slug, runId);
  ensureDir(dir);
  appendFileSync(join(dir, RUN_LOG), JSON.stringify(entry) + '\n', 'utf-8');
}

/** Read + parse the run log in append order. Skips malformed lines. */
export function readRunLog(workspaceRoot: string, slug: string, runId: string): RunLogEntry[] {
  const path = join(runDir(workspaceRoot, slug, runId), RUN_LOG);
  if (!existsSync(path)) return [];
  const out: RunLogEntry[] = [];
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as RunLogEntry);
    } catch {
      // skip a corrupt/partial line rather than failing the whole replay
    }
  }
  return out;
}

/** List run ids for a task (sorted lexicographically). */
export function listRunIds(workspaceRoot: string, slug: string): string[] {
  const runs = join(taskDir(workspaceRoot, slug), RUNS_DIR);
  if (!existsSync(runs)) return [];
  return readdirSync(runs, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

// ---------------------------------------------------------------------------
// Per-run spec snapshot
// ---------------------------------------------------------------------------

const RUN_SPEC = 'spec.json';

/**
 * Snapshot the spec a run executed against, so the Results view can label nodes by the titles
 * that were live *at run time* — not the current task.yaml, which may have been edited since
 * (renaming/removing nodes would otherwise mislabel or drop historical outputs).
 */
export function writeRunSpecSnapshot(workspaceRoot: string, slug: string, runId: string, spec: TaskSpec): void {
  const dir = runDir(workspaceRoot, slug, runId);
  ensureDir(dir);
  atomicWriteFileSync(join(dir, RUN_SPEC), JSON.stringify(spec, null, 2));
}

/** Read a run's spec snapshot. Returns null for older runs written before snapshots existed. */
export function readRunSpecSnapshot(workspaceRoot: string, slug: string, runId: string): TaskSpec | null {
  const path = join(runDir(workspaceRoot, slug, runId), RUN_SPEC);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as TaskSpec;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Per-node output
// ---------------------------------------------------------------------------

/**
 * v0.15.1:packages/shared/src/tasks/storage.ts (UB1.14) — the per-node output path as its own helper, so a
 * caller can point at the full output: the TaskRunner's 40 000-character upstream-reply cut names this file
 * in the dependent's prompt.
 */
export function nodeOutputPath(workspaceRoot: string, slug: string, runId: string, nodeId: string): string {
  return join(runDir(workspaceRoot, slug, runId), NODES_DIR, `${nodeId}.json`);
}

export function writeNodeOutput(
  workspaceRoot: string,
  slug: string,
  runId: string,
  nodeId: string,
  output: NodeOutput,
): void {
  ensureDir(join(runDir(workspaceRoot, slug, runId), NODES_DIR));
  atomicWriteFileSync(nodeOutputPath(workspaceRoot, slug, runId, nodeId), JSON.stringify(output, null, 2));
}

export function readNodeOutput(
  workspaceRoot: string,
  slug: string,
  runId: string,
  nodeId: string,
): NodeOutput | null {
  const path = nodeOutputPath(workspaceRoot, slug, runId, nodeId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as NodeOutput;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Task folder removal (NESSY, UA3.8)
// ---------------------------------------------------------------------------

/**
 * UA3.8 — remove `{workspaceRoot}/tasks/<slug>/` (spec, run logs, node outputs); `true` when it existed. NESSY:
 * upstream v0.13.4 has no folder removal. The ONE removal path — `tasks:delete` and the orchestrator delete cascade
 * (`SessionManager.deleteSession`, rule in `server-core/src/tasks/orchestrator-folder.ts`) both call it, and neither
 * decides here whether a live session still carries the slug: that is the caller's check. A slug that is not a slug
 * is refused (`task-slug-invalid`) — it never becomes a path.
 */
export function deleteTaskFolder(workspaceRoot: string, slug: string): boolean {
  if (!SLUG_RE.test(slug)) throw new Error('task-slug-invalid');
  const dir = taskDir(workspaceRoot, slug);
  const existed = existsSync(dir);
  rmSync(dir, { recursive: true, force: true });
  return existed;
}
