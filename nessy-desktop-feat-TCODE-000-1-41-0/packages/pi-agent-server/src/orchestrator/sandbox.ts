import { parse } from 'acorn';

export interface WorkflowRuntimeApi {
  agent: (promptOrDef: unknown, opts?: unknown) => Promise<unknown>;
  workflow: (nameOrRef: unknown, args?: unknown) => Promise<unknown>;
  parallel: (thunks: Array<() => unknown>) => Promise<unknown[]>;
  pipeline: (items: unknown[], ...stages: Array<(item: unknown) => unknown>) => Promise<unknown[]>;
  phase: (title: string) => string;
  log: (message: string) => string;
  args: unknown;
  budget: {
    total?: number;
    spent: () => number;
    remaining: () => number | undefined;
  };
}

export interface CompileWorkflowScriptOptions {
  /**
   * Maximum uninterrupted synchronous wall-clock slice, in milliseconds, before
   * the evaluator aborts. Each `await` resumption resets the budget, so a
   * legitimate workflow that yields between light synchronous work is unaffected;
   * a runaway synchronous loop (`while (true) {}`, unbounded recursion) is
   * bounded instead of blocking the Pi subprocess event loop.
   */
  maxSyncMs?: number;
  /** Maximum accumulated `log()` output, in bytes, before the evaluator aborts. */
  maxOutputBytes?: number;
}

const DEFAULT_MAX_SYNC_MS = 2_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;

/** Thrown when a workflow script exceeds a host evaluation limit. */
export class WorkflowEvaluationLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowEvaluationLimitError';
  }
}

const BLOCKED_NODE_TYPES = new Set([
  'ImportDeclaration',
  'ExportAllDeclaration',
  'ExportDefaultDeclaration',
  'ExportNamedDeclaration',
  'ImportExpression',
  'WithStatement',
]);

const BLOCKED_IDENTIFIERS = new Set(['require', 'process', 'globalThis', 'eval', 'Function', 'Date']);
const BLOCKED_PROPERTIES = new Set(['constructor', '__proto__', 'prototype']);

// Injected runtime bindings. Named with a reserved-looking prefix and rejected as
// identifiers below so a script cannot reference or shadow them.
const GUARD_IDENTIFIER = '__nessy_guard__';
const AWAIT_RESET_IDENTIFIER = '__nessy_await__';
const RESERVED_INJECTED = new Set([GUARD_IDENTIFIER, AWAIT_RESET_IDENTIFIER]);

function propertyName(node: any): string | null {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  return null;
}

interface Instrumentation {
  /** Offsets (just inside a `{`) where a bare guard statement is inserted. */
  guardOffsets: number[];
  /** Non-block statement bodies wrapped into a guarded block: `{ guard(); <body> }`. */
  bodyWraps: Array<{ start: number; end: number }>;
  /**
   * Concise (expression) arrow bodies wrapped into a guarded sequence:
   * `() => EXPR` -> `() => (guard(), (EXPR))`. Preserves expression-body value and
   * semantics while bounding recursion through arrow tail-calls.
   */
  exprWraps: Array<{ start: number; end: number }>;
}

function visit(node: any, instrumentation: Instrumentation): void {
  if (!node || typeof node !== 'object') return;

  if (typeof node.type === 'string') {
    if (BLOCKED_NODE_TYPES.has(node.type)) {
      throw new Error(`Workflow script rejected: disallowed ${node.type}`);
    }

    if (node.type === 'ThisExpression' || node.type === 'MetaProperty') {
      throw new Error(`Workflow script rejected: disallowed ${node.type}`);
    }

    if (node.type === 'Identifier'
      && (BLOCKED_IDENTIFIERS.has(node.name) || RESERVED_INJECTED.has(node.name))) {
      if (node.name === 'Date') {
        throw new Error('Workflow script rejected: disallowed Date; pass timestamps through args');
      }
      throw new Error(`Workflow script rejected: disallowed identifier ${node.name}`);
    }

    if (node.type === 'MemberExpression') {
      const name = propertyName(node.property);
      if (propertyName(node.object) === 'Math' && name === 'random') {
        throw new Error('Workflow script rejected: disallowed Math.random; pass random seeds through args');
      }
      if (name && BLOCKED_PROPERTIES.has(name)) {
        throw new Error(`Workflow script rejected: disallowed property ${name}`);
      }
    }

    if (node.type === 'NewExpression' && propertyName(node.callee) === 'Function') {
      throw new Error('Workflow script rejected: disallowed Function constructor');
    }

    if (node.type === 'NewExpression' && propertyName(node.callee) === 'Date') {
      throw new Error('Workflow script rejected: disallowed Date constructor; pass timestamps through args');
    }

    // Guard every loop back-edge. A guard at the top of the loop body bounds the
    // synchronous slice per iteration regardless of body shape (block, single
    // statement, or empty statement).
    if (node.type === 'WhileStatement' || node.type === 'DoWhileStatement'
      || node.type === 'ForStatement' || node.type === 'ForInStatement'
      || node.type === 'ForOfStatement') {
      recordLoopBody(node.body, instrumentation);
    }

    // A guard at every function entry bounds loop-free but unbounded synchronous
    // recursion (including arrow tail-call recursion).
    if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression'
      || node.type === 'ArrowFunctionExpression') {
      if (node.body && node.body.type === 'BlockStatement') {
        recordBlockGuard(node.body, instrumentation);
      } else if (node.type === 'ArrowFunctionExpression' && node.body
        && typeof node.body.start === 'number' && typeof node.body.end === 'number') {
        // Concise expression body: guard via a sequence expression.
        instrumentation.exprWraps.push({ start: node.body.start, end: node.body.end });
      }
    }
  }

  for (const [key, value] of Object.entries(node)) {
    if (key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
    if (Array.isArray(value)) {
      for (const child of value) visit(child, instrumentation);
    } else {
      visit(value, instrumentation);
    }
  }
}

function recordBlockGuard(body: any, instrumentation: Instrumentation): void {
  if (!body || typeof body !== 'object') return;
  if (body.type === 'BlockStatement' && typeof body.start === 'number') {
    // Insert just inside the opening brace.
    instrumentation.guardOffsets.push(body.start + 1);
  }
}

function recordLoopBody(body: any, instrumentation: Instrumentation): void {
  if (!body || typeof body !== 'object' || typeof body.start !== 'number' || typeof body.end !== 'number') return;
  if (body.type === 'BlockStatement') {
    recordBlockGuard(body, instrumentation);
    return;
  }
  // Non-block loop body (single statement, empty statement `;`, or expression
  // statement): wrap it into a guarded block so every iteration back-edge is
  // instrumented. `while (x) y;` -> `while (x) { __nessy_guard__(); y; }`.
  instrumentation.bodyWraps.push({ start: body.start, end: body.end });
}

export function validateWorkflowScript(script: string): void {
  let ast;
  try {
    ast = parse(`async function __workflow__() {\n${script}\n}`, {
      ecmaVersion: 'latest',
      sourceType: 'script',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Workflow script rejected: ${message}`);
  }
  visit(ast, { guardOffsets: [], bodyWraps: [], exprWraps: [] });
}

/** Parse, validate, and return the instrumented script body plus injection metadata. */
function prepareWorkflowScript(script: string): string {
  // Parse the raw script body directly (not the wrapper) so recorded offsets map
  // onto `script`. The wrapper is only needed to permit top-level await/return
  // during validation; instrumentation offsets must be relative to `script`.
  let ast;
  try {
    ast = parse(script, { ecmaVersion: 'latest', sourceType: 'script', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Workflow script rejected: ${message}`);
  }
  const instrumentation: Instrumentation = { guardOffsets: [], bodyWraps: [], exprWraps: [] };
  visit(ast, instrumentation);

  // Await operand spans wrap into the anchor-reset helper.
  const awaitOperands = collectAwaitOperandEnds(ast);
  return spliceInstrumentation(script, instrumentation, awaitOperands);
}

function collectAwaitOperandEnds(node: any, ends: Array<{ start: number; end: number }> = []): Array<{ start: number; end: number }> {
  if (!node || typeof node !== 'object') return ends;
  if (node.type === 'AwaitExpression' && node.argument
    && typeof node.argument.start === 'number' && typeof node.argument.end === 'number') {
    ends.push({ start: node.argument.start, end: node.argument.end });
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
    if (Array.isArray(value)) {
      for (const child of value) collectAwaitOperandEnds(child, ends);
    } else {
      collectAwaitOperandEnds(value, ends);
    }
  }
  return ends;
}

function spliceInstrumentation(
  script: string,
  instrumentation: Instrumentation,
  awaitOperands: Array<{ start: number; end: number }>,
): string {
  // Each edit is a zero-width insertion at `offset`. When several insertions share
  // an offset, `order` fixes their relative sequence in the final string (lower
  // `order` ends up earlier). We apply edits by descending offset so earlier
  // offsets stay valid; within one offset we apply higher `order` first so that,
  // after the right-to-left prepends, the intended low-to-high order is preserved.
  const edits: Array<{ offset: number; order: number; text: string }> = [];

  // Guard statements just inside a block `{`.
  for (const offset of instrumentation.guardOffsets) {
    edits.push({ offset, order: 0, text: ` ${GUARD_IDENTIFIER}();` });
  }

  // Non-block loop bodies: wrap into `{ __nessy_guard__(); <body> }`.
  for (const body of instrumentation.bodyWraps) {
    // Open must be the outermost thing before body content, close the outermost
    // after it — use extreme orders so wraps enclose any await wrappers inside.
    edits.push({ offset: body.start, order: -100, text: `{ ${GUARD_IDENTIFIER}(); ` });
    edits.push({ offset: body.end, order: 100, text: ` }` });
  }

  // Concise arrow expression bodies: wrap into `(__nessy_guard__(), (<expr>))`.
  // The inner parens preserve object-literal bodies and operator precedence; the
  // sequence yields the original expression value after running the guard.
  for (const body of instrumentation.exprWraps) {
    edits.push({ offset: body.start, order: -100, text: `(${GUARD_IDENTIFIER}(), (` });
    edits.push({ offset: body.end, order: 100, text: `))` });
  }

  // Await operands: wrap into `__nessy_await__(<operand>)`.
  for (const operand of awaitOperands) {
    edits.push({ offset: operand.start, order: 1, text: `${AWAIT_RESET_IDENTIFIER}(` });
    edits.push({ offset: operand.end, order: -1, text: `)` });
  }

  edits.sort((a, b) => b.offset - a.offset || b.order - a.order);
  let out = script;
  for (const edit of edits) {
    out = out.slice(0, edit.offset) + edit.text + out.slice(edit.offset);
  }
  return out;
}

export function compileWorkflowScript(
  script: string,
  options: CompileWorkflowScriptOptions = {},
): (api: WorkflowRuntimeApi) => Promise<unknown> {
  validateWorkflowScript(script);
  const instrumented = prepareWorkflowScript(script);
  const maxSyncMs = options.maxSyncMs ?? DEFAULT_MAX_SYNC_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  const fn = new Function(
    'agent',
    'workflow',
    'parallel',
    'pipeline',
    'phase',
    'log',
    'args',
    'budget',
    GUARD_IDENTIFIER,
    AWAIT_RESET_IDENTIFIER,
    `"use strict"; return (async () => {\n${instrumented}\n})()`,
  ) as (
    agent: WorkflowRuntimeApi['agent'],
    workflow: WorkflowRuntimeApi['workflow'],
    parallel: WorkflowRuntimeApi['parallel'],
    pipeline: WorkflowRuntimeApi['pipeline'],
    phase: WorkflowRuntimeApi['phase'],
    log: WorkflowRuntimeApi['log'],
    args: WorkflowRuntimeApi['args'],
    budget: WorkflowRuntimeApi['budget'],
    guard: () => void,
    awaitReset: <T>(value: T) => T,
  ) => Promise<unknown>;

  return api => {
    // Host clock reference (the sandbox bans Date inside scripts; the deadline
    // guard uses this injected reference instead).
    const now = () => Date.now();
    let anchor = now();
    let outputBytes = 0;

    const guard = () => {
      if (now() - anchor > maxSyncMs) {
        throw new WorkflowEvaluationLimitError(
          `workflow evaluation exceeded ${maxSyncMs}ms of uninterrupted synchronous execution`,
        );
      }
    };
    const awaitReset = <T>(value: T): T => {
      // Resolving through this wrapper yields the microtask queue; reset the
      // synchronous-slice anchor so post-await work starts fresh.
      if (value && typeof (value as any).then === 'function') {
        return (Promise.resolve(value as any).then(resolved => { anchor = now(); return resolved; }) as unknown) as T;
      }
      anchor = now();
      return value;
    };

    const boundedLog: WorkflowRuntimeApi['log'] = message => {
      const line = api.log(message);
      outputBytes += Buffer.byteLength(String(line), 'utf8');
      if (outputBytes > maxOutputBytes) {
        throw new WorkflowEvaluationLimitError(
          `workflow evaluation exceeded ${maxOutputBytes} bytes of output`,
        );
      }
      return line;
    };

    return fn(
      api.agent,
      api.workflow,
      api.parallel,
      api.pipeline,
      api.phase,
      boundedLog,
      api.args,
      api.budget,
      guard,
      awaitReset,
    );
  };
}
