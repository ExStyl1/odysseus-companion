import { readFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { platform as osPlatform } from 'node:os';
import {
  AGENTS_MD_INSTRUCTION_FILE,
  agentsMdInstructionFilesIn,
  instructionFileExistsAt,
} from '../../../capabilities/instruction-files.ts';

export interface NestorMcpToolMetadata {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface NestorSkillMetadata {
  name: string;
  description: string;
}

/**
 * `WorkspaceTabsV1` verbatim — `open_tabs` / `visible_files`, both plain path
 * arrays (BACKEND/internal/usecase/vibe/a2aextensions/open_tabs_extension.go:18-21).
 * The key is read through `extensions.GetMetaObjectForKey`, which switches on
 * the metadata value's type and returns `ErrWrongExtensionType` for anything
 * that is not a JSON object (AGENTCORE/a2a/extensions/metadata.go:21-37) — the
 * array of `{path,title}` records this used to declare would have hit the
 * `default` branch and been dropped whole (silently: `createCodeAgentSpec`
 * routes the error through a log-only `logErr`). Shape only for now — no
 * producer passes tabs yet (F10).
 */
export interface NestorWorkspaceTabsMetadata {
  open_tabs: string[];
  visible_files: string[];
}

export interface BuildNestorCloudMetadataArgs {
  workspaceRootPath: string;
  workingDirectory: string;
  shell?: string;
  platform?: NodeJS.Platform | string;
  mode?: string;
  userInstructions?: string[];
  mcpTools?: NestorMcpToolMetadata[];
  skills?: NestorSkillMetadata[];
  workspaceTabs?: NestorWorkspaceTabsMetadata;
  readFile?: (path: string) => string;
  /**
   * Whether the project `workingDirectory` is explicitly trusted (W6). Project
   * `AGENTS.md` instruction files are read only when true; defaults to
   * untrusted (fail-closed).
   */
  projectTrusted?: boolean;
}

export interface NestorCloudMetadata extends Record<string, unknown> {
  environment_details: {
    system_info: {
      os: string;
      shell: string;
      working_dir: string;
      workspace_root: string;
    };
    analytics_request_details: {
      project_name: string;
    };
  };
  agent_settings: {
    mode: string;
    user_instructions?: string[];
  };
  agents_md?: {
    content: string;
  };
  mcp?: Array<{
    type: 'function';
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }>;
  skills?: NestorSkillMetadata[];
  workspace_tabs?: NestorWorkspaceTabsMetadata;
}

export function buildNestorCloudMetadata(args: BuildNestorCloudMetadataArgs): NestorCloudMetadata {
  const workspaceRoot = resolve(args.workspaceRootPath);
  const workingDirectory = resolve(args.workingDirectory || args.workspaceRootPath);
  const shell = args.shell ?? process.env.SHELL ?? 'unknown';
  const mode = args.mode ?? 'act';

  const metadata: NestorCloudMetadata = {
    environment_details: {
      system_info: {
        os: args.platform ?? osPlatform(),
        shell,
        working_dir: workingDirectory,
        workspace_root: workspaceRoot,
      },
      analytics_request_details: {
        project_name: basename(workspaceRoot),
      },
    },
    agent_settings: {
      mode,
      ...(args.userInstructions?.length ? { user_instructions: args.userInstructions } : {}),
    },
  };

  // Project AGENTS.md is repository-owned: read it only for a trusted project.
  const agentsMd = args.projectTrusted === true
    ? readApplicableAgentsMd({
      workspaceRootPath: workspaceRoot,
      workingDirectory,
      readFile: args.readFile,
    })
    : null;
  if (agentsMd) {
    metadata.agents_md = { content: agentsMd };
  }

  if (args.mcpTools?.length) {
    metadata.mcp = args.mcpTools.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description ?? '',
      parameters: tool.parameters ?? { type: 'object', properties: {} },
    }));
  }

  if (args.skills?.length) {
    metadata.skills = args.skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
    }));
  }

  if (args.workspaceTabs) {
    const openTabs = args.workspaceTabs.open_tabs ?? [];
    const visibleFiles = args.workspaceTabs.visible_files ?? [];
    if (openTabs.length || visibleFiles.length) {
      metadata.workspace_tabs = {
        open_tabs: [...openTabs],
        visible_files: [...visibleFiles],
      };
    }
  }

  return metadata;
}

/**
 * The gateway rejects any request body larger than this BEFORE the agent sees
 * it: `requestSizeInterceptor.Before` reads the `content-length` service param
 * and returns `too large request: size=%d, limit=%d: a2a.ErrInvalidRequest`
 * (AGENTCORE/a2a/interceptors/request_size_limit.go:26-36), which reaches us as
 * a `-32600` frame. The 1,000,000 `envDefault` on `CODE_AGENT_REQUEST_LIMIT_SIZE`
 * (BACKEND/internal/config/config.go:413) is NOT what runs — the helm chart
 * always sets the env var and every values file sets `request_limit_size:
 * "500000"` (service/nestor/helm/nestor/values.yaml:238 and its four siblings),
 * so the effective cap is half the documented default.
 *
 * BYTES, not characters: the interceptor compares `Content-Length`, and a
 * Cyrillic AGENTS.md is two bytes per character.
 */
export const NESTOR_REQUEST_LIMIT_BYTES = 500_000;

/**
 * Reserved for everything in the body that is neither the message text nor the
 * metadata: the JSON-RPC envelope, the message ids, `contextId`/`taskId`, the
 * part wrappers, and the escaping JSON adds to both blocks (`"` → `\"`, a
 * newline → `\n`), which the two raw byte counts do not see.
 */
export const NESTOR_REQUEST_HEADROOM_BYTES = 8_192;

/**
 * How many bytes of metadata this turn can afford. Negative when the message
 * alone overruns the cap — the caller still trims (dropping everything it can),
 * and the send fails at the gateway with the interceptor's own text.
 *
 * The message is measured SERIALIZED, exactly as the metadata half is: what the
 * gateway weighs is one JSON body, and JSON escaping is not a rounding error on
 * this side — a newline-heavy prompt DOUBLES (`\n` → `\` + `n`) and a
 * quote-heavy one grows with every quote, so the raw count could overrun the
 * 8,192-byte headroom by tens of kilobytes and put the whole request over a cap
 * the trimming believed it was under.
 */
export function nestorMetadataByteBudget(turnMessage: string): number {
  const serializedMessageBytes = Buffer.byteLength(JSON.stringify(turnMessage), 'utf8');
  return NESTOR_REQUEST_LIMIT_BYTES - serializedMessageBytes - NESTOR_REQUEST_HEADROOM_BYTES;
}

export type NestorMetadataTrimField = 'agents_md' | 'mcp_parameters' | 'skills';

export interface NestorMetadataTrim {
  field: NestorMetadataTrimField;
  /** Serialized bytes this step removed from the whole metadata object. */
  droppedBytes: number;
}

export interface NestorMetadataBudgetResult {
  metadata: NestorCloudMetadata;
  /** `Buffer.byteLength(JSON.stringify(metadata))` after trimming. */
  bytes: number;
  withinBudget: boolean;
  trims: NestorMetadataTrim[];
}

const AGENTS_MD_TRUNCATION_MARKER = '\n\n[truncated: request size budget]';
const EMPTY_TOOL_SCHEMA = { type: 'object', properties: {} } as const;

/**
 * Fit the metadata into `budgetBytes` of SERIALIZED UTF-8, trimming in the
 * order that costs the model the least: repository prose first (`agents_md` —
 * the unbounded concatenation of every applicable AGENTS.md), then the MCP
 * input schemas (the tool NAMES survive, so the model still knows what it may
 * call), then the skills catalog.
 *
 * Never mutates the input. `withinBudget: false` means even the stripped
 * metadata is over — the caller sends anyway and lets the gateway speak.
 */
export function trimNestorMetadataToByteBudget(
  metadata: NestorCloudMetadata,
  budgetBytes: number,
): NestorMetadataBudgetResult {
  let current: NestorCloudMetadata = { ...metadata };
  let bytes = serializedByteLength(current);
  const trims: NestorMetadataTrim[] = [];
  if (bytes <= budgetBytes) return { metadata: current, bytes, withinBudget: true, trims };

  if (current.agents_md) {
    const before = bytes;
    const original = current.agents_md.content;
    const markerBytes = Buffer.byteLength(AGENTS_MD_TRUNCATION_MARKER, 'utf8');
    let keep = Buffer.byteLength(original, 'utf8') - (bytes - budgetBytes) - markerBytes;
    // Each pass removes at least the measured overage of raw bytes, and JSON
    // escaping only ever makes the serialized saving larger, so this converges
    // in one or two passes; the cap is a guard, not the mechanism.
    for (let attempt = 0; attempt < 4 && keep > 0; attempt++) {
      const content = `${truncateUtf8ByBytes(original, keep)}${AGENTS_MD_TRUNCATION_MARKER}`;
      current = { ...current, agents_md: { content } };
      bytes = serializedByteLength(current);
      if (bytes <= budgetBytes) break;
      keep -= bytes - budgetBytes;
    }
    if (bytes > budgetBytes) {
      current = { ...current };
      delete current.agents_md;
      bytes = serializedByteLength(current);
    }
    trims.push({ field: 'agents_md', droppedBytes: before - bytes });
    if (bytes <= budgetBytes) return { metadata: current, bytes, withinBudget: true, trims };
  }

  if (current.mcp?.length) {
    const before = bytes;
    current = {
      ...current,
      mcp: current.mcp.map((tool) => ({ ...tool, parameters: { ...EMPTY_TOOL_SCHEMA, properties: {} } })),
    };
    bytes = serializedByteLength(current);
    trims.push({ field: 'mcp_parameters', droppedBytes: before - bytes });
    if (bytes <= budgetBytes) return { metadata: current, bytes, withinBudget: true, trims };
  }

  if (current.skills) {
    const before = bytes;
    current = { ...current };
    delete current.skills;
    bytes = serializedByteLength(current);
    trims.push({ field: 'skills', droppedBytes: before - bytes });
  }

  return { metadata: current, bytes, withinBudget: bytes <= budgetBytes, trims };
}

function serializedByteLength(metadata: NestorCloudMetadata): number {
  return Buffer.byteLength(JSON.stringify(metadata), 'utf8');
}

/**
 * Cut `text` at `maxBytes` UTF-8 bytes without splitting a character: a byte
 * matching `0b10xxxxxx` is a continuation byte, so walk back off it.
 */
function truncateUtf8ByBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  let end = Math.max(0, maxBytes);
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

/**
 * The ancestor walk that fills `agents_md`, through the shared rule holder
 * (P3.241). It used to name `AGENTS.md` itself and knew none of the collector's
 * rules: in a repo carrying an `AGENTS.override.md` it sent the remote agent the
 * file codex ignores and withheld the one codex obeys — a divergence at a
 * runtime switch, produced by nothing but a second copy of a filename.
 *
 * {@link agentsMdInstructionFilesIn} applies codex's per-directory supersession
 * (`agents_md_paths`, `rust-v0.148.0`: first candidate whose `metadata.is_file`
 * holds, before any body is read), so at most one file per directory is carried,
 * exactly as codex loads it. The field carries the `AGENTS.md` chain only, so
 * the helper is the AGENTS-family projection rather than the full instruction
 * list — `CLAUDE.md` reaching this request would be a new product decision, not
 * a convergence.
 */
function readApplicableAgentsMd(args: {
  workspaceRootPath: string;
  workingDirectory: string;
  readFile?: (path: string) => string;
}): string | null {
  const paths: string[] = [];
  const workspaceRoot = resolve(args.workspaceRootPath);
  let current = resolve(args.workingDirectory);
  if (!isInsideOrEqual(current, workspaceRoot)) {
    current = workspaceRoot;
  }

  for (;;) {
    for (const fileName of agentsMdInstructionFilesIn(current)) {
      paths.push(join(current, fileName));
    }
    if (current === workspaceRoot) break;
    const next = dirname(current);
    if (next === current) break;
    current = next;
  }

  const readFile = args.readFile ?? ((path: string) => readFileSync(path, 'utf-8'));
  const chunks: string[] = [];
  for (const path of paths.reverse()) {
    // `is_file`, not existence: codex selects candidates on `metadata.is_file`,
    // and a DIRECTORY named `AGENTS.md` would otherwise reach `readFileSync`.
    if (!instructionFileExistsAt(path)) continue;
    const content = readFile(path).trim();
    if (!content) continue;
    const label = relative(workspaceRoot, path) || AGENTS_MD_INSTRUCTION_FILE;
    chunks.push(`# ${label}\n\n${content}`);
  }

  return chunks.length ? chunks.join('\n\n') : null;
}

function isInsideOrEqual(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !rel.startsWith('/'));
}
