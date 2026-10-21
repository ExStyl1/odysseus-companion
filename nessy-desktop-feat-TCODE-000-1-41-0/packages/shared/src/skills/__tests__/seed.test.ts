/**
 * Tests for bundled built-in skill seeding (C1) and its refresh policy (P2.281).
 *
 * Proves the Stop-Condition invariants for the first-run seed:
 * - a fresh skills root seeds every bundled slug;
 * - a USER-EDITED slug is left UNTOUCHED (non-destructive);
 * - a missing/empty bundle dir is a no-op;
 * - the seed is contained under the resolved skills root (default = CONFIG_DIR).
 *
 * And the P2.281 half — a corrected `SKILL.md` has to reach a profile that
 * already exists, or every skill correction this fork ships stops at the
 * installed base:
 * - a PRISTINE copy of an older bundle is refreshed;
 * - a receipt-less profile (everything in the field before P2.281) is refreshed
 *   through `PRE_RECEIPT_SHIPPED_HASHES`;
 * - an EDITED copy survives both paths and is reported as `customized`;
 * - a settled profile writes nothing on the next run.
 *
 * Uses real temp directories for both the bundled source and the target root
 * via the test-only `bundledRoot` / `skillsRoot` seams; production derives the
 * target from CONFIG_DIR and never accepts a path.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { cpSync, mkdtempSync, mkdirSync, readdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  BUNDLED_SKILL_SEED_RECEIPT_FILE,
  PRE_RECEIPT_SHIPPED_HASHES,
  ensureBundledSkills,
  hashSkillDir,
  readBundledSkillSeedReceipt,
} from '../seed.ts';
import { loadWorkspaceSkills } from '../storage.ts';

/** This repository's own bundled skills — the content a build actually ships. */
const packagedBundle = join(
  import.meta.dir,
  '..', '..', '..', '..', '..',
  'apps', 'electron', 'resources', 'skills',
);

let tempDir: string;
let bundledRoot: string;
// `skillsRoot` is a `<workspaceRoot>/skills` dir so the exported
// `loadWorkspaceSkills(workspaceRoot)` reads exactly what the seed wrote — the
// same slug-dir/SKILL.md shape `loadSkillFromDir` (its internal callee) reads.
let workspaceRoot: string;
let skillsRoot: string;

/** Write a bundled skill `<root>/<slug>/SKILL.md` (+ optional extra asset). */
function writeBundledSkill(root: string, slug: string, opts: { body?: string; asset?: { name: string; content: string } } = {}): void {
  const dir = join(root, slug);
  mkdirSync(dir, { recursive: true });
  const body = opts.body ?? `Instructions for ${slug}`;
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: "${slug}"\ndescription: "A ${slug} skill"\n---\n\n${body}\n`,
  );
  if (opts.asset) writeFileSync(join(dir, opts.asset.name), opts.asset.content);
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'seed-skills-test-'));
  bundledRoot = join(tempDir, 'bundled');
  workspaceRoot = join(tempDir, 'ws');
  skillsRoot = join(workspaceRoot, 'skills');
  mkdirSync(bundledRoot, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('ensureBundledSkills', () => {
  it('seeds every bundled slug into a fresh skills root', () => {
    writeBundledSkill(bundledRoot, 'alpha');
    writeBundledSkill(bundledRoot, 'beta', { asset: { name: 'reference.md', content: 'extra asset' } });

    const seeded = ensureBundledSkills({ bundledRoot, skillsRoot });

    expect(seeded.sort()).toEqual(['alpha', 'beta']);
    // Both land on disk in the loadSkillFromDir on-disk shape.
    expect(existsSync(join(skillsRoot, 'alpha', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(skillsRoot, 'beta', 'SKILL.md'))).toBe(true);
    // Optional assets are copied alongside SKILL.md.
    expect(readFileSync(join(skillsRoot, 'beta', 'reference.md'), 'utf-8')).toBe('extra asset');
    // Seeded skills are readable by the same on-disk loader the inventory uses.
    const loaded = loadWorkspaceSkills(workspaceRoot);
    const alpha = loaded.find(s => s.slug === 'alpha');
    expect(alpha).toBeDefined();
    expect(alpha?.metadata.name).toBe('alpha');
  });

  it('never overwrites a user-edited slug (idempotent, non-destructive)', () => {
    writeBundledSkill(bundledRoot, 'alpha', { body: 'BUNDLED VERSION' });

    // User already has an edited `alpha` on disk.
    mkdirSync(join(skillsRoot, 'alpha'), { recursive: true });
    const userSkill = join(skillsRoot, 'alpha', 'SKILL.md');
    writeFileSync(userSkill, '---\nname: "alpha"\ndescription: "user edited"\n---\n\nUSER VERSION\n');

    const seeded = ensureBundledSkills({ bundledRoot, skillsRoot });

    // Existing slug is skipped — not reported, not touched.
    expect(seeded).toEqual([]);
    expect(readFileSync(userSkill, 'utf-8')).toContain('USER VERSION');
    expect(readFileSync(userSkill, 'utf-8')).not.toContain('BUNDLED VERSION');

    // A second run is also a no-op (seed-once by slug-existence).
    expect(ensureBundledSkills({ bundledRoot, skillsRoot })).toEqual([]);
    expect(readFileSync(userSkill, 'utf-8')).toContain('USER VERSION');
  });

  it('seeds only the missing slugs when the root already has some', () => {
    writeBundledSkill(bundledRoot, 'alpha');
    writeBundledSkill(bundledRoot, 'beta');
    mkdirSync(join(skillsRoot, 'alpha'), { recursive: true });
    writeFileSync(join(skillsRoot, 'alpha', 'SKILL.md'), '---\nname: "alpha"\ndescription: "existing"\n---\n\nkeep\n');

    const seeded = ensureBundledSkills({ bundledRoot, skillsRoot });

    expect(seeded).toEqual(['beta']);
    expect(readFileSync(join(skillsRoot, 'alpha', 'SKILL.md'), 'utf-8')).toContain('keep');
    expect(existsSync(join(skillsRoot, 'beta', 'SKILL.md'))).toBe(true);
  });

  it('is a no-op when the bundle dir is missing', () => {
    const missingBundle = join(tempDir, 'does-not-exist');
    const seeded = ensureBundledSkills({ bundledRoot: missingBundle, skillsRoot });
    expect(seeded).toEqual([]);
    // The target root is not created when there is nothing to seed.
    expect(existsSync(skillsRoot)).toBe(false);
  });

  it('is a no-op when the bundle dir is empty', () => {
    const seeded = ensureBundledSkills({ bundledRoot, skillsRoot });
    expect(seeded).toEqual([]);
    expect(existsSync(skillsRoot)).toBe(false);
  });

  it('ignores bundled entries without a SKILL.md', () => {
    // A stray directory without SKILL.md is not a skill.
    mkdirSync(join(bundledRoot, 'not-a-skill'), { recursive: true });
    writeFileSync(join(bundledRoot, 'not-a-skill', 'README.txt'), 'nope');
    // A stray file at the bundle root is not a skill either.
    writeFileSync(join(bundledRoot, 'loose-file.md'), 'nope');
    writeBundledSkill(bundledRoot, 'real');

    const seeded = ensureBundledSkills({ bundledRoot, skillsRoot });

    expect(seeded).toEqual(['real']);
    expect(existsSync(join(skillsRoot, 'not-a-skill'))).toBe(false);
    expect(existsSync(join(skillsRoot, 'loose-file.md'))).toBe(false);
  });

  it('contains every seeded skill under the target skills root', () => {
    writeBundledSkill(bundledRoot, 'alpha');
    writeBundledSkill(bundledRoot, 'beta');

    const seeded = ensureBundledSkills({ bundledRoot, skillsRoot });

    // Every write stayed inside skillsRoot — nothing escaped the target root.
    for (const slug of seeded) {
      expect(existsSync(join(skillsRoot, slug, 'SKILL.md'))).toBe(true);
    }
  });

  it('ships a packaged built-in seed skill that parses through loadSkillFromDir', () => {
    // Point at the real packaged bundle to prove C1 is testable end-to-end:
    // the placeholder built-in skill must exist and load through the same loader
    // the native-sources inventory uses.
    const packagedBundle = join(
      import.meta.dir,
      '..', '..', '..', '..', '..',
      'apps', 'electron', 'resources', 'skills',
    );
    expect(existsSync(packagedBundle)).toBe(true);

    const seeded = ensureBundledSkills({ bundledRoot: packagedBundle, skillsRoot });
    expect(seeded.length).toBeGreaterThan(0);
    const loaded = loadWorkspaceSkills(workspaceRoot);
    expect(loaded.length).toBe(seeded.length);
    for (const skill of loaded) {
      expect(skill.metadata.name).toBeTruthy();
      expect(skill.metadata.description).toBeTruthy();
    }
  });
});

/**
 * P2.281 — a corrected `SKILL.md` reaching a profile that already exists.
 *
 * The seeded copy plays two roles at once in this fork: while it is untouched
 * it is our shipped artefact, and once edited it is the user's own override
 * (`skills.md#where-skills-live`: "A skill at any of these levels also
 * overrides a bundled skill with the same name"). These pin both directions —
 * the refresh that the old seed-once policy lost, and the edit it protected.
 */
describe('ensureBundledSkills — refresh while pristine (P2.281)', () => {
  const receiptFor = (root: string) => join(root, BUNDLED_SKILL_SEED_RECEIPT_FILE);

  it('refreshes a pristine copy when the bundled content changes', () => {
    writeBundledSkill(bundledRoot, 'alpha', { body: 'SHIPPED V1' });
    expect(ensureBundledSkills({ bundledRoot, skillsRoot })).toEqual(['alpha']);

    // The bundle ships a correction.
    writeBundledSkill(bundledRoot, 'alpha', { body: 'SHIPPED V2' });
    expect(ensureBundledSkills({ bundledRoot, skillsRoot })).toEqual(['alpha']);

    const onDisk = readFileSync(join(skillsRoot, 'alpha', 'SKILL.md'), 'utf-8');
    expect(onDisk).toContain('SHIPPED V2');
    expect(onDisk).not.toContain('SHIPPED V1');
    expect(readBundledSkillSeedReceipt(skillsRoot).skills.alpha?.reason).toBe('update');
  });

  it('drops files a previous bundle shipped and this one does not', () => {
    writeBundledSkill(bundledRoot, 'alpha', { body: 'V1', asset: { name: 'old.md', content: 'gone next time' } });
    ensureBundledSkills({ bundledRoot, skillsRoot });
    expect(existsSync(join(skillsRoot, 'alpha', 'old.md'))).toBe(true);

    rmSync(join(bundledRoot, 'alpha'), { recursive: true, force: true });
    writeBundledSkill(bundledRoot, 'alpha', { body: 'V2' });
    expect(ensureBundledSkills({ bundledRoot, skillsRoot })).toEqual(['alpha']);

    // A refresh REPLACES the directory rather than merging over it — a stale
    // supporting file left behind would still be read by `read_skill_resource`.
    expect(existsSync(join(skillsRoot, 'alpha', 'old.md'))).toBe(false);
    expect(readFileSync(join(skillsRoot, 'alpha', 'SKILL.md'), 'utf-8')).toContain('V2');
  });

  it('leaves a user-edited copy untouched and records it as customized', () => {
    writeBundledSkill(bundledRoot, 'alpha', { body: 'SHIPPED V1' });
    ensureBundledSkills({ bundledRoot, skillsRoot });

    const userSkill = join(skillsRoot, 'alpha', 'SKILL.md');
    writeFileSync(userSkill, '---\nname: "alpha"\ndescription: "mine"\n---\n\nMY VERSION\n');
    writeBundledSkill(bundledRoot, 'alpha', { body: 'SHIPPED V2' });

    expect(ensureBundledSkills({ bundledRoot, skillsRoot })).toEqual([]);
    expect(readFileSync(userSkill, 'utf-8')).toContain('MY VERSION');
    expect(readFileSync(userSkill, 'utf-8')).not.toContain('SHIPPED V2');
    expect(readBundledSkillSeedReceipt(skillsRoot).customized).toEqual(['alpha']);
  });

  it('refreshes a receipt-less profile whose content is a hash we shipped', () => {
    // Every profile in the field predates the receipt, which is the whole point
    // of the bootstrap table. `preReceiptShippedHashes` is the test seam for it;
    // production reads `PRE_RECEIPT_SHIPPED_HASHES`.
    writeBundledSkill(bundledRoot, 'alpha', { body: 'SHIPPED V1' });
    ensureBundledSkills({ bundledRoot, skillsRoot });
    const shippedV1 = hashSkillDir(join(skillsRoot, 'alpha'));
    expect(shippedV1).toBeTruthy();
    rmSync(receiptFor(skillsRoot), { force: true });

    writeBundledSkill(bundledRoot, 'alpha', { body: 'SHIPPED V2' });
    const written = ensureBundledSkills({
      bundledRoot,
      skillsRoot,
      preReceiptShippedHashes: { alpha: [shippedV1!] },
    });

    expect(written).toEqual(['alpha']);
    expect(readFileSync(join(skillsRoot, 'alpha', 'SKILL.md'), 'utf-8')).toContain('SHIPPED V2');
  });

  it('leaves a receipt-less profile alone when its content is not one we shipped', () => {
    writeBundledSkill(bundledRoot, 'alpha', { body: 'SHIPPED V1' });
    ensureBundledSkills({ bundledRoot, skillsRoot });
    const userSkill = join(skillsRoot, 'alpha', 'SKILL.md');
    writeFileSync(userSkill, '---\nname: "alpha"\ndescription: "mine"\n---\n\nMY VERSION\n');
    rmSync(receiptFor(skillsRoot), { force: true });

    writeBundledSkill(bundledRoot, 'alpha', { body: 'SHIPPED V2' });
    const written = ensureBundledSkills({
      bundledRoot,
      skillsRoot,
      preReceiptShippedHashes: { alpha: ['0'.repeat(64)] },
    });

    expect(written).toEqual([]);
    expect(readFileSync(userSkill, 'utf-8')).toContain('MY VERSION');
  });

  it('adopts an up-to-date receipt-less copy so the NEXT correction reaches it', () => {
    writeBundledSkill(bundledRoot, 'alpha', { body: 'SHIPPED V1' });
    ensureBundledSkills({ bundledRoot, skillsRoot });
    rmSync(receiptFor(skillsRoot), { force: true });

    // Same bundle, no receipt: nothing to write, but the hash is recorded.
    expect(ensureBundledSkills({ bundledRoot, skillsRoot })).toEqual([]);
    expect(readBundledSkillSeedReceipt(skillsRoot).skills.alpha?.reason).toBe('adopted');

    // Which is what lets the next correction land without the bootstrap table.
    writeBundledSkill(bundledRoot, 'alpha', { body: 'SHIPPED V2' });
    expect(ensureBundledSkills({ bundledRoot, skillsRoot })).toEqual(['alpha']);
    expect(readFileSync(join(skillsRoot, 'alpha', 'SKILL.md'), 'utf-8')).toContain('SHIPPED V2');
  });

  it('writes nothing on a settled profile', () => {
    writeBundledSkill(bundledRoot, 'alpha');
    ensureBundledSkills({ bundledRoot, skillsRoot });
    const settled = readFileSync(receiptFor(skillsRoot), 'utf-8');

    expect(ensureBundledSkills({ bundledRoot, skillsRoot })).toEqual([]);
    // Byte-identical: a settled profile must not churn the receipt on every
    // startup, which would also churn every watcher looking at the skills root.
    expect(readFileSync(receiptFor(skillsRoot), 'utf-8')).toBe(settled);
  });

  it('keeps the receipt out of the skill inventory', () => {
    writeBundledSkill(bundledRoot, 'alpha');
    ensureBundledSkills({ bundledRoot, skillsRoot });

    expect(existsSync(receiptFor(skillsRoot))).toBe(true);
    // The same loader the native-sources inventory uses sees skills only.
    expect(loadWorkspaceSkills(workspaceRoot).map(skill => skill.slug)).toEqual(['alpha']);
  });

  it('seeds nothing and refreshes nothing while bundled skills are disabled', () => {
    writeBundledSkill(bundledRoot, 'alpha', { body: 'SHIPPED V1' });
    ensureBundledSkills({ bundledRoot, skillsRoot });
    writeBundledSkill(bundledRoot, 'alpha', { body: 'SHIPPED V2' });

    // `settings-reference.md#disablebundledskills` — "Claude Code removes
    // bundled skills and workflows entirely". A refresh is a write, so the off
    // switch has to precede it too.
    const written = ensureBundledSkills({ bundledRoot, skillsRoot, storedConfig: { disableBundledSkills: true } });
    expect(written).toEqual([]);
    expect(readFileSync(join(skillsRoot, 'alpha', 'SKILL.md'), 'utf-8')).toContain('SHIPPED V1');
  });
});

describe('PRE_RECEIPT_SHIPPED_HASHES', () => {
  it('holds well-formed hashes, and only for slugs the bundle actually ships', () => {
    // Deliberately NOT "every current bundle hash is tabled": the table is
    // CLOSED, so a `SKILL.md` edited after P2.281 is covered by the receipt each
    // write leaves behind and must NOT be added here. What can still rot is a
    // slug renamed out of the bundle, or a hand-edited entry.
    const bundledSlugs = new Set(
      readdirSync(packagedBundle, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name),
    );
    for (const [slug, hashes] of Object.entries(PRE_RECEIPT_SHIPPED_HASHES)) {
      expect(bundledSlugs.has(slug), `${slug} is not a bundled slug`).toBe(true);
      expect(hashes.length, `${slug} has no shipped hash`).toBeGreaterThan(0);
      for (const hash of hashes) expect(hash, `${slug}: ${hash}`).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

/**
 * P6.1028 — the EDIT reaches a profile that already holds the previous text.
 *
 * The question the row asks, and it is about a real edit rather than a
 * synthetic one: `cb11c166e` changed the bundled `code-review/SKILL.md`, the
 * bootstrap table is CLOSED BY CONSTRUCTION so no hash was added for it, and it
 * was unsettled whether a profile holding the previous text is re-seeded or now
 * reads as customized and keeps a stale instruction.
 *
 * The answer is that it is re-seeded, and the dates are why no hash is needed:
 * the receipt landed 2026-08-28 (`57ca0ef1b`, P2.281) and EVERY `code-review`
 * revision after `fecfe1d7c` (2026-08-27, the newest entry in the table) shipped
 * after it — so a field profile holds either one of the two tabled pre-receipt
 * revisions or a revision written with a receipt beside it, and both are `ours`.
 * A revision in neither would be one shipped by a build with no receipt code
 * AFTER the table was frozen, and there is no such release.
 *
 * The cases below prove that on the REAL bundle rather than on `alpha`: the
 * mechanism is tested by the P2.281 block above, and what is tested here is
 * that this repository's own shipped content passes through it.
 */
describe('a bundled-skill EDIT reaches a profile holding the previous text (P6.1028)', () => {
  /** The direction sentence `cb11c166e` added — the marker of "the new text". */
  const CODE_REVIEW_DIRECTION = 'Leave the subagent in the BACKGROUND, and do not opt out of it.';

  /**
   * The packaged bundle with `code-review` rolled back to a previous revision.
   *
   * "Previous" is simulated rather than checked out of history, and it is exact
   * enough BECAUSE the policy decides by HASH: it cannot tell one revision from
   * another, only ours from the user's. A rollback that silently changed nothing
   * would make the first `expect` below fail rather than pass vacuously.
   */
  function bundleHoldingThePreviousText(): string {
    const root = join(tempDir, 'previous-bundle');
    cpSync(packagedBundle, root, { recursive: true });
    const skillFile = join(root, 'code-review', 'SKILL.md');
    const current = readFileSync(skillFile, 'utf-8');
    expect(current).toContain(CODE_REVIEW_DIRECTION);
    const previous = current.replace(CODE_REVIEW_DIRECTION, '');
    expect(previous).not.toBe(current);
    writeFileSync(skillFile, previous);
    return root;
  }

  const heldCodeReview = (): string =>
    readFileSync(join(skillsRoot, 'code-review', 'SKILL.md'), 'utf-8');

  it('re-seeds it, on the receipt the previous write left behind', () => {
    // The profile as it left the previous build: seeded from that bundle, with
    // the receipt every write since P2.281 leaves behind.
    expect(ensureBundledSkills({ bundledRoot: bundleHoldingThePreviousText(), skillsRoot }))
      .toContain('code-review');
    const held = hashSkillDir(join(skillsRoot, 'code-review'));
    expect(held).toBeTruthy();
    expect(readBundledSkillSeedReceipt(skillsRoot).skills['code-review']?.hash).toBe(held!);
    expect(heldCodeReview()).not.toContain(CODE_REVIEW_DIRECTION);

    // The build carrying the edit runs its seed.
    expect(ensureBundledSkills({ bundledRoot: packagedBundle, skillsRoot })).toContain('code-review');
    expect(heldCodeReview()).toContain(CODE_REVIEW_DIRECTION);
    const receipt = readBundledSkillSeedReceipt(skillsRoot);
    expect(receipt.skills['code-review']?.reason).toBe('update');
    expect(receipt.customized ?? []).not.toContain('code-review');
    // And the CLOSED table did not have to grow for that to happen, which is
    // the half of the row that would otherwise be settled by adding a hash.
    expect(PRE_RECEIPT_SHIPPED_HASHES['code-review'] ?? []).not.toContain(held!);
  });

  it('keeps the stale text only with the receipt gone, which is the honest direction', () => {
    ensureBundledSkills({ bundledRoot: bundleHoldingThePreviousText(), skillsRoot });
    rmSync(join(skillsRoot, BUNDLED_SKILL_SEED_RECEIPT_FILE), { force: true });

    // The same content, no receipt, and a hash the closed table does not carry
    // (nothing shipped this revision before receipts existed). It reads as the
    // user's own file and is left alone — a loss of the receipt "degrades in
    // the honest direction", and this is what that costs.
    expect(ensureBundledSkills({ bundledRoot: packagedBundle, skillsRoot })).not.toContain('code-review');
    expect(heldCodeReview()).not.toContain(CODE_REVIEW_DIRECTION);
    expect(readBundledSkillSeedReceipt(skillsRoot).customized).toContain('code-review');
    // The control that keeps the case above from passing on a broken run: every
    // OTHER bundled slug is byte-identical here, so it is adopted rather than
    // reported as the user's.
    expect(readBundledSkillSeedReceipt(skillsRoot).customized).toEqual(['code-review']);
  });
});
