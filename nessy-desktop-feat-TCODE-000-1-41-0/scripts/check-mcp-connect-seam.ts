/**
 * `DA3.6` — nothing may override `McpClientPool.connect`.
 *
 * ## The obligation this replaces
 *
 * The pool's overridable seam used to BE `connect`, whose third parameter was
 * optional:
 *
 *   connect(slug, config, isolatedConnectionKey?)
 *
 * so a subclass written with two parameters was a legal TypeScript override that
 * silently dropped the connection identity and filed its client under the SHARED
 * key while the reconcile waited on the isolated one. `connect`'s own docblock
 * asked, in prose, that every override forward the key. Prose did not hold: the
 * census of 2026-09-17 found 31 such sites across four test trees in three
 * packages, 28 of which dropped it — and `DA3.8` then found the SAME drop in
 * `connect` itself, which had been asking its subclasses to do what it was not
 * doing. An isolated connection was created and then unreachable through every
 * surface that routes by tool name or reports by connection verdict.
 *
 * The seam is now `protected openConnection({ slug, config, connectionKey })`,
 * which RETURNS a client and never files it: `connect` owns the identity and
 * does the filing, so there is nothing left for an override to drop. This script
 * is what keeps it that way. It is a `lint:chain` step because the failure it
 * prevents is invisible on the default posture — a dropped key changes nothing
 * until an operator sets `NESSY_MCP_CONNECTION_ISOLATION`, and then it changes
 * everything at once.
 *
 * ## What it checks, and what it deliberately does not
 *
 * One rule: in any file that declares a subclass of `McpClientPool`, no member
 * named `connect` may be declared. `connectInProcess` is a DIFFERENT seam and is
 * out of scope — API servers are keyed by `apiConnectionKey`, which carries no
 * isolation term, so an override there has no identity to lose. `disconnect` is
 * likewise untouched: it takes an EXACT connection key and cannot default one.
 *
 * ## Why it reads code and not text
 *
 * AGENTS.md: *a correction that spells the dead form re-creates the finding it
 * is repairing.* Two comments in this tree quote the retired
 * `override async connect(slug, config)` spelling precisely because they explain
 * why it is retired, and a text guard would report them forever — which teaches
 * the next reader that the gate cries wolf. So comment lines are skipped, block
 * comments included, and only a declaration outside them counts.
 *
 * Usage: `bun scripts/check-mcp-connect-seam.ts` (exits 1 on a finding).
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const POOL_CLASS = 'McpClientPool';

/** A member declaration named `connect`, with any access/override/async prefix. */
const CONNECT_MEMBER = /^\s*(?:public\s+|protected\s+|private\s+)?(?:override\s+)?(?:async\s+)?connect\s*\(/;

interface Finding {
  file: string;
  line: number;
  text: string;
}

/**
 * Every tracked source that declares a subclass of the pool.
 *
 * `git grep -l` rather than a walk over `git ls-files`: the walk read all ~4 600
 * tracked `.ts`/`.tsx` files and did not finish inside two minutes on this rig,
 * where per-file open latency dominates (AGENTS.md's I/O-confound bullet). `-a`
 * is passed because a source file in this tree may carry a NUL byte and plain
 * grep skips such a file SILENTLY, which would make an absence claim unfalsifiable;
 * `-I` is deliberately NOT passed beside it, because the two flags are opposites
 * and the last one wins.
 *
 * `git grep` reads tracked blobs, so an untracked new fixture is invisible to
 * this gate until it is added — which is the same window every other tree-scanning
 * gate in this repo has, and it closes at the commit that would introduce the bug.
 */
function poolSubclassSources(): string[] {
  const listed = spawnSync(
    'git',
    ['grep', '-alz', `extends ${POOL_CLASS}`, '--', '*.ts', '*.tsx'],
    { encoding: 'utf-8', maxBuffer: 1024 * 1024 * 64 },
  );
  // Exit 1 with no output is "no matches", which is a legitimate answer.
  if (listed.status !== 0 && listed.status !== 1) {
    throw new Error(`git grep failed: ${listed.stderr}`);
  }
  return listed.stdout.split('\0').filter(Boolean);
}

/**
 * Lines of `source` with every comment line blanked out.
 *
 * Deliberately coarse — it tracks whether a block comment is open and drops
 * single-line comment lines — because the only thing it has to get right is "this line is prose". A missed
 * string literal cannot produce a false POSITIVE here: the pattern above matches
 * a member declaration, not an arbitrary mention.
 */
function withoutComments(source: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of source.split('\n')) {
    const trimmed = raw.trim();
    if (inBlock) {
      out.push('');
      if (trimmed.includes('*/')) inBlock = false;
      continue;
    }
    if (trimmed.startsWith('/*')) {
      out.push('');
      if (!trimmed.includes('*/')) inBlock = true;
      continue;
    }
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) {
      out.push('');
      continue;
    }
    out.push(raw);
  }
  return out;
}

function findingsIn(file: string): Finding[] {
  // The pool's own module declares `connect`; it is the base, not an override.
  // It cannot match `extends McpClientPool` anyway, so this is belt and braces.
  if (file.endsWith('packages/shared/src/mcp/mcp-pool.ts')) return [];
  const lines = withoutComments(readFileSync(file, 'utf-8'));
  const found: Finding[] = [];
  lines.forEach((line, index) => {
    if (CONNECT_MEMBER.test(line)) {
      found.push({ file, line: index + 1, text: line.trim() });
    }
  });
  return found;
}

function main(): void {
  const sources = poolSubclassSources();
  const findings = sources.flatMap(findingsIn);
  if (findings.length === 0) {
    console.log(
      `lint:mcp-connect-seam — OK: none of the ${sources.length} ${POOL_CLASS} subclass file(s) declares \`connect\`.`,
    );
    return;
  }
  console.error(
    `lint:mcp-connect-seam — ${findings.length} subclass override(s) of \`${POOL_CLASS}.connect\`:`,
  );
  for (const finding of findings) {
    console.error(`  ${finding.file}:${finding.line}  ${finding.text}`);
  }
  console.error('');
  console.error(
    'Override `openConnection({ slug, config, connectionKey })` instead: return the client and let',
  );
  console.error(
    '`connect` file it. An override of `connect` can drop the connection identity, which is invisible',
  );
  console.error(
    'until NESSY_MCP_CONNECTION_ISOLATION is set and then breaks every routing and verdict surface at',
  );
  console.error('once (DA3.6, DA3.8). See `McpClientPool.connect`\'s docblock.');
  process.exitCode = 1;
}

main();
