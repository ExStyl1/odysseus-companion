import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse } from 'acorn';

import { CONFIG_DIR } from '../config/paths.ts';
import { NESSY_AGENT_PROJECT_DIR } from '../projects/nessy-agent-layout.ts';

type PureLiteral = string | number | boolean | null | PureLiteral[] | { [key: string]: PureLiteral };

/**
 * The `meta` block of a workflow recipe.
 *
 * REQUIREDNESS IS THE CONTRACT; THE KEY SET IS NOT. The only normative sentence
 * in Claude's documentation corpus is the `Workflow` tool's `script` parameter
 * (`agent-sdk/typescript.md`, fetched 2026-08-24): "Must begin with `export
 * const meta = { name, description }` as a literal, followed by the script body
 * using `agent()`, `parallel()`, `pipeline()`, and `phase()`. An optional
 * `phases` array in `meta` groups agents under named stages in the progress
 * view". It states what must be present and names one optional field. It never
 * states which keys are forbidden, and no page in the corpus does — `whenToUse`
 * appears on ZERO of the pages in `scripts/claude-doc-pages.tsv`, and so
 * does `phases` outside that one sentence. (That was measured over the 186-page
 * snapshot; the corpus is 191 pages as of 2026-08-25, and the five it gained —
 * `settings-reference`, `managed-settings`, `settings-example`,
 * `whats-new/2026-w33`, `whats-new/2026-w34` — were re-probed the same day:
 * `whenToUse` 0, `phases` 0 on each, positive control `permissions` 53 on
 * `settings-reference.md`. A page count is deliberately not repeated here, since
 * that is the number that went stale.) `workflows.md` § *What the saved
 * script looks like* is explicitly illustrative, not a schema: "here is the
 * shape of a small one so you can recognize what Claude generated".
 *
 * So this type is CLOSED for consumption and the parser is OPEN for loading.
 * Unknown keys are ignored rather than refused, because a hard-fail allow-list
 * over an unpublished, evolving key set turns every upstream field addition
 * into a silently amputated bundle. That is not hypothetical: Anthropic's own
 * `claude-security` plugin ships `whenToUse` in `workflows/scan.js`, and the
 * closed list refused the whole workflow while the same bundle's 7 agents,
 * 1 skill and 1 hook installed — leaving two `Workflow(claude-security:scan)`
 * grants pointing at nothing. It is also the third instance of the failure mode
 * AGENTS.md names (`Task`→`Agent`, `lsp` vs `lspServers`).
 *
 * What is NOT given up: `name` and `description` are still required literal
 * strings, and every known optional field is still type-checked, so a
 * misspelled REQUIRED field is caught by the requiredness check exactly as
 * before. The cost is measured and accepted: a misspelled OPTIONAL field
 * (`phasez`) now loads as absent instead of failing the file.
 */
export interface WorkflowMeta {
  name: string;
  description: string;
  /** Shown in the workflow list. Undocumented upstream; shipped by first-party plugins. */
  whenToUse?: string;
  phases?: PureLiteral[];
}

export interface WorkflowRecipeDiagnostic {
  path: string;
  message: string;
}

export interface LoadedWorkflowRecipe {
  meta: WorkflowMeta;
  path: string;
  scope: 'personal' | 'project';
}

export interface WorkflowLoaderOptions {
  cwd: string;
  repoRoot?: string;
  configDir?: string;
  includeProject?: boolean;
}

export interface WorkflowLoadResult {
  loaded: LoadedWorkflowRecipe[];
  diagnostics: WorkflowRecipeDiagnostic[];
  recipes: WorkflowRecipeStore;
  /** Canonicalization candidates for explicit scriptPath execution. */
  scriptRoots: string[];
}

export interface ParsedWorkflow {
  meta: WorkflowMeta;
  source: string;
}

const WORKFLOWS_DIR = 'workflows';
const PURE_META_ERROR = 'workflow meta must be a pure literal object; variables, calls, spreads, computed keys, and template interpolation are not allowed';
const WORKFLOW_RECIPE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface WorkflowRecipeStore {
  get: (key: string) => string | undefined | Promise<string | undefined>;
}

export function normalizeWorkflowRecipeKey(nameOrRef: unknown): string {
  if (typeof nameOrRef !== 'string') {
    throw new Error('workflow() nameOrRef must be a registry key');
  }
  const key = nameOrRef.trim();
  if (key !== nameOrRef || !WORKFLOW_RECIPE_KEY_PATTERN.test(key)) {
    throw new Error('workflow() nameOrRef must be a registry key');
  }
  return key;
}

function keyName(node: any): string | undefined {
  if (node?.type === 'Identifier') return node.name;
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  return undefined;
}

function pureLiteral(node: any): PureLiteral {
  if (node?.type === 'Literal'
    && (node.value === null || ['string', 'number', 'boolean'].includes(typeof node.value))) {
    return node.value;
  }
  if (node?.type === 'ArrayExpression') {
    if (node.elements.some((element: unknown) => element === null)) throw new Error(PURE_META_ERROR);
    return node.elements.map((element: unknown) => pureLiteral(element));
  }
  if (node?.type === 'ObjectExpression') {
    const value = Object.create(null) as { [key: string]: PureLiteral };
    for (const property of node.properties) {
      if (property.type !== 'Property'
        || property.computed
        || property.kind !== 'init'
        || property.method
        || property.shorthand) {
        throw new Error(PURE_META_ERROR);
      }
      const key = keyName(property.key);
      if (!key) throw new Error(PURE_META_ERROR);
      value[key] = pureLiteral(property.value);
    }
    return value;
  }
  throw new Error(PURE_META_ERROR);
}

export function parseWorkflowRecipe(source: string): ParsedWorkflow {
  let program: any;
  try {
    program = parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    });
  } catch (error) {
    throw new Error(`invalid workflow JavaScript: ${error instanceof Error ? error.message : String(error)}`);
  }

  const statement = program.body[0];
  const declaration = statement?.type === 'ExportNamedDeclaration' ? statement.declaration : undefined;
  const declarator = declaration?.type === 'VariableDeclaration'
    && declaration.kind === 'const'
    && declaration.declarations.length === 1
    ? declaration.declarations[0]
    : undefined;
  if (declarator?.id?.type !== 'Identifier'
    || declarator.id.name !== 'meta'
    || declarator.init?.type !== 'ObjectExpression') {
    throw new Error(PURE_META_ERROR);
  }

  const literal = pureLiteral(declarator.init);
  if (Array.isArray(literal) || literal === null || typeof literal !== 'object') {
    throw new Error(PURE_META_ERROR);
  }
  // Requiredness and known-field types are enforced; unknown keys are ignored
  // rather than refused. See `WorkflowMeta` for the contract this follows and
  // the measurement that changed it.
  if (typeof literal.name !== 'string'
    || typeof literal.description !== 'string'
    || (literal.whenToUse !== undefined && typeof literal.whenToUse !== 'string')
    || (literal.phases !== undefined && !Array.isArray(literal.phases))) {
    throw new Error('workflow meta must contain literal name and description strings, an optional literal whenToUse string, and an optional literal phases array');
  }

  const name = normalizeWorkflowRecipeKey(literal.name);
  return {
    meta: {
      name,
      description: literal.description,
      ...(literal.whenToUse === undefined ? {} : { whenToUse: literal.whenToUse }),
      ...(literal.phases === undefined ? {} : { phases: literal.phases }),
    },
    source: source.slice(statement.end).replace(/^\s+/, ''),
  };
}

function repositoryRoot(cwd: string): string {
  let current = cwd;
  while (true) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return cwd;
    current = parent;
  }
}

function projectAncestors(cwd: string, repoRoot: string): string[] {
  const child = relative(repoRoot, cwd);
  if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error(`workflow cwd must be inside repo root: ${cwd}`);
  }
  const ancestors: string[] = [];
  let current = cwd;
  while (true) {
    ancestors.push(current);
    if (current === repoRoot) return ancestors;
    current = dirname(current);
  }
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function loadDirectory(
  workflowsDir: string,
  scope: LoadedWorkflowRecipe['scope'],
  recipes: Map<string, LoadedWorkflowRecipe & { source: string }>,
  diagnostics: WorkflowRecipeDiagnostic[],
  scriptRoots: string[],
): void {
  try {
    if (scope === 'project') {
      const agentDir = dirname(workflowsDir);
      if (isSymlink(agentDir)) {
        diagnostics.push({ path: agentDir, message: 'Refused symlinked project .nessy-agent directory' });
        return;
      }
      if (isSymlink(workflowsDir)) {
        diagnostics.push({ path: workflowsDir, message: 'Refused symlinked project workflows directory' });
        return;
      }
    }
    if (!existsSync(workflowsDir)) return;
    scriptRoots.push(workflowsDir);

    const entries = readdirSync(workflowsDir, { withFileTypes: true })
      .filter(entry => entry.name.endsWith('.js') && (entry.isFile() || entry.isSymbolicLink()))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(workflowsDir, entry.name);
      if (isSymlink(path)) {
        diagnostics.push({
          path,
          message: `Refused symlinked ${scope} workflow file`,
        });
        continue;
      }
      try {
        const parsed = parseWorkflowRecipe(readFileSync(path, 'utf8'));
        recipes.set(parsed.meta.name, { meta: parsed.meta, path, scope, source: parsed.source });
      } catch (error) {
        diagnostics.push({
          path,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } catch (error) {
    diagnostics.push({
      path: workflowsDir,
      message: `Unable to load workflows: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

export function loadWorkflowRecipes(options: WorkflowLoaderOptions): WorkflowLoadResult {
  const cwd = resolve(options.cwd);
  const repoRoot = resolve(options.repoRoot ?? repositoryRoot(cwd));
  const configDir = resolve(options.configDir ?? CONFIG_DIR);
  const diagnostics: WorkflowRecipeDiagnostic[] = [];
  const recipes = new Map<string, LoadedWorkflowRecipe & { source: string }>();
  const scriptRoots: string[] = [];

  loadDirectory(join(configDir, WORKFLOWS_DIR), 'personal', recipes, diagnostics, scriptRoots);
  if (options.includeProject !== false) {
    for (const ancestor of projectAncestors(cwd, repoRoot).reverse()) {
      loadDirectory(
        join(ancestor, NESSY_AGENT_PROJECT_DIR, WORKFLOWS_DIR),
        'project',
        recipes,
        diagnostics,
        scriptRoots,
      );
    }
  }

  return {
    loaded: [...recipes.values()].map(({ source: _source, ...recipe }) => recipe),
    diagnostics,
    recipes: {
      get: key => recipes.get(key)?.source,
    },
    scriptRoots,
  };
}

function assertProjectSavePath(workflowsDir: string, target: string): void {
  const agentDir = dirname(workflowsDir);
  if (isSymlink(agentDir)) {
    throw new Error(`Refused symlinked project .nessy-agent directory: ${agentDir}`);
  }
  if (isSymlink(workflowsDir)) {
    throw new Error(`Refused symlinked project workflows directory: ${workflowsDir}`);
  }
  if (isSymlink(target)) {
    throw new Error(`Refused symlinked project workflow file: ${target}`);
  }
}

/**
 * Where a saved recipe goes. `project` is the historical behaviour and stays the
 * default; `personal` is the half P6.318 was missing.
 *
 * LOADING has been two-scope since this module was written —
 * `loadWorkflowRecipes` reads `CONFIG_DIR/workflows` and then every project
 * ancestor — so a personal recipe was already dispatchable as `/<name>` and
 * there was simply no way to write one from inside the app. That asymmetry is
 * the row: a run could be kept only where a repository could see it, which is
 * the wrong place for the workflows a person carries between repositories.
 */
export type WorkflowSaveScope = 'project' | 'personal';

export interface WorkflowSaveOptions extends WorkflowLoaderOptions {
  /** Default `project`, which is exactly today's behaviour. */
  scope?: WorkflowSaveScope;
}

/**
 * The personal directory gets the SAME symlink refusal the project one does, and
 * for the same reason: a symlinked `workflows` directory turns a save into a
 * write anywhere on disk. Its parent is `CONFIG_DIR` itself, which the app owns
 * and creates, so only the directory and the file are checked — refusing a
 * symlinked `CONFIG_DIR` would refuse a legitimate install whose whole config
 * directory is a link, which is a posture nobody asked for.
 */
function assertPersonalSavePath(workflowsDir: string, target: string): void {
  if (isSymlink(workflowsDir)) {
    throw new Error(`Refused symlinked personal workflows directory: ${workflowsDir}`);
  }
  if (isSymlink(target)) {
    throw new Error(`Refused symlinked personal workflow file: ${target}`);
  }
}

export function saveWorkflowRecipe(source: string, options: WorkflowSaveOptions): string {
  const parsed = parseWorkflowRecipe(source);
  if (options.scope === 'personal') {
    const workflowsDir = join(resolve(options.configDir ?? CONFIG_DIR), WORKFLOWS_DIR);
    const target = join(workflowsDir, `${parsed.meta.name}.js`);
    assertPersonalSavePath(workflowsDir, target);
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(target, source);
    return target;
  }
  const cwd = resolve(options.cwd);
  const repoRoot = resolve(options.repoRoot ?? repositoryRoot(cwd));
  const ancestors = projectAncestors(cwd, repoRoot);
  let workflowsDir = join(repoRoot, NESSY_AGENT_PROJECT_DIR, WORKFLOWS_DIR);

  for (const ancestor of ancestors) {
    const candidate = join(ancestor, NESSY_AGENT_PROJECT_DIR, WORKFLOWS_DIR);
    try {
      const stats = lstatSync(candidate);
      if (stats.isDirectory() || stats.isSymbolicLink()) {
        workflowsDir = candidate;
        break;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  const target = join(workflowsDir, `${parsed.meta.name}.js`);
  assertProjectSavePath(workflowsDir, target);
  mkdirSync(workflowsDir, { recursive: true });
  writeFileSync(target, source);
  return target;
}
