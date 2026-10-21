/**
 * Bundled built-in skill seeding (C1).
 *
 * Nessy Desktop ships built-in skills inside the packaged app under
 * `resources/skills/<slug>/SKILL.md`. On first run we copy each bundled skill
 * into the global managed skills root (`~/.nessy-agent/skills/`) so it surfaces
 * through the SAME native-sources inventory as any user skill (managed tier).
 *
 * ## Policy: refresh while pristine, never over an edit (P2.281)
 *
 * The original policy was seed-once BY SLUG-EXISTENCE with no re-seed at all,
 * and it silently capped the reach of every correction this fork ships: once a
 * profile held `<slug>/`, a fixed `SKILL.md` reached NEW profiles only.
 * Measured on the real artefacts — a profile seeded from the `688a4c37a` bundle
 * kept the 5712-byte `code-review` that still instructs the model to "Run the
 * `review` tool" (the defect P2.212 fixed) after a re-seed from the corrected
 * 7983-byte bundle, while a fresh profile in the SAME run received the
 * correction.
 *
 * Claude's documentation is the contract for the MODEL here, and it is explicit
 * that a bundled skill is not a file the user owns:
 *
 * - `skills.md#bundled-skills`, whole sentence: "Bundled skills are available
 *   in every session." They ship inside Claude Code rather than as a copy in
 *   the user's directories, so no user copy can go stale.
 * - `skills.md#where-skills-live`, whole bullet: "A skill at any of these
 *   levels also overrides a bundled skill with the same name, but not the
 *   bundled skill's aliases", with the worked example "For example, a
 *   `code-review` skill in your project's `.claude/skills/` replaces the
 *   bundled `/code-review`, and typing the bundled alias `/review` never runs
 *   your skill." Customization is an OVERRIDE at another level, never an edit
 *   of the shipped text.
 *
 * This fork copies the bundle into the user's own personal root, so those two
 * roles land on ONE file: an untouched copy is our shipped artefact, an edited
 * copy is the user's override. The pages say what each deserves — the first
 * must track the bundle, the second must survive — and are silent only on how
 * to tell them apart, because upstream never has to. That last step is decided
 * here, in the transparent and simple form: by CONTENT.
 *
 * Per bundled slug, on every run:
 * - absent            → copy it in (unchanged behaviour).
 * - identical         → nothing to write.
 * - a hash we shipped → the copy is ours and unmodified, so replace it with the
 *                       current bundle. THIS is the case the old policy lost.
 * - anything else     → the user edited it. Leave it completely untouched and
 *                       record it as `customized` in the receipt.
 *
 * ## The receipt, and why there is also a closed bootstrap table
 *
 * "A hash we shipped" needs a record of what we wrote.
 * `.bundled-skill-seed.json` at the skills root is that record, written
 * whenever we place content, and it is deliberately a plain readable file:
 * whoever meets a profile — an operator asking which artefact a live run is
 * measuring, most of all — can read off which slugs carry the shipped text and
 * which carry an edit. Every reader of the skills root ignores it
 * (`skillRecords`, `loadSkillsFromDir`, `listSkillSlugs`, `exportSkills` and
 * `validateAllSkills` all require a DIRECTORY, and the first also requires a
 * `SKILL.md` inside it).
 *
 * A receipt cannot describe a profile seeded before receipts existed, which is
 * every profile in the field today — the exact population this fix is for. So
 * `PRE_RECEIPT_SHIPPED_HASHES` carries the hash of every bundled-skill revision
 * this repository has ever shipped. It is CLOSED BY CONSTRUCTION and must never
 * grow: no new receipt-less copy can be created once this ships, because every
 * write from here on leaves a receipt. Losing the receipt file is safe and
 * degrades in the honest direction — a post-bootstrap copy then reads as
 * customized and is left alone rather than overwritten.
 *
 * Unchanged from the original policy: idempotent; contained under CONFIG_DIR by
 * construction (the target is always derived from CONFIG_DIR, never renderer
 * supplied); additive and offline, no network.
 */

import { createHash } from 'crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { CONFIG_DIR } from '../config/paths.ts';
import { bundledSkillsDisabled } from '../config/bundled-skills-settings.ts';
import { getBundledAssetsDir } from '../utils/paths.ts';

/** Global managed skills root, derived from CONFIG_DIR (never renderer-supplied). */
export function getManagedSkillsRoot(): string {
  return join(CONFIG_DIR, 'skills');
}

/**
 * Every slug the packaged bundle ships, whether or not it has been seeded yet.
 *
 * `settings-reference.md#disablebundledskills` — "Claude Code removes bundled
 * skills and workflows entirely". "Entirely" has to include the copies a
 * previous run already placed in the managed skills root — a switch
 * that only worked on a fresh profile would be worthless to the administrator
 * turning it on. A seeded copy is an ordinary directory carrying no marker of
 * its own, so the bundle itself is the only authority on which slugs are
 * bundled, and this is how a reader asks it.
 *
 * The receipt below is NOT a second answer to this question and must not be read
 * as one: it records what THIS PROFILE holds and who wrote it, while this
 * function answers what the CURRENT BUNDLE ships. A slug an older bundle seeded
 * and this one dropped is in the receipt and not in this list, by design.
 */
export function bundledSkillSlugs(options: EnsureBundledSkillsOptions = {}): string[] {
  const bundledRoot = options.bundledRoot ?? getBundledAssetsDir('skills');
  if (!bundledRoot || !existsSync(bundledRoot)) return [];
  try {
    return readdirSync(bundledRoot).filter(slug => isBundledSkillDir(bundledRoot, slug));
  } catch {
    return [];
  }
}

/**
 * True when a directory entry is a valid bundled skill: a directory that
 * contains a `SKILL.md` (the same on-disk shape `loadSkillFromDir` reads).
 */
function isBundledSkillDir(bundledRoot: string, slug: string): boolean {
  const skillDir = join(bundledRoot, slug);
  try {
    if (!statSync(skillDir).isDirectory()) return false;
  } catch {
    return false;
  }
  return existsSync(join(skillDir, 'SKILL.md'));
}

/** File name of the seed receipt, at the root of the managed skills dir. */
export const BUNDLED_SKILL_SEED_RECEIPT_FILE = '.bundled-skill-seed.json';

/** Why a slug's recorded hash is in the receipt. */
export type BundledSkillSeedReason =
  /** Copied in because the slug was absent. */
  | 'seed'
  /** Replaced a pristine copy of an older bundle. */
  | 'update'
  /** Found already byte-identical to the bundle; recorded, nothing written. */
  | 'adopted';

export interface BundledSkillSeedEntry {
  /** `hashSkillDir` of the content this profile holds for the slug. */
  hash: string;
  /** ISO timestamp of the run that recorded this entry. */
  recordedAt: string;
  reason: BundledSkillSeedReason;
}

export interface BundledSkillSeedReceipt {
  version: 1;
  /** Slugs whose on-disk content is known to be ours, by hash. */
  skills: Record<string, BundledSkillSeedEntry>;
  /**
   * Slugs left untouched because their content is neither the current bundle
   * nor anything we recorded shipping — i.e. a user edit. Informational only:
   * it is never read back into the update decision, so a user cannot get their
   * edit overwritten by editing this list, and we cannot mistake content we
   * merely OBSERVED for content we WROTE.
   */
  customized?: string[];
}

/**
 * Stable hash of a skill directory's whole content: every file, keyed by its
 * POSIX-relative path, sorted, with an explicit length so no concatenation of
 * two files can collide with another pair.
 *
 * Returns `undefined` for anything that is not a plain directory tree of plain
 * files — a symlink, a socket, an unreadable entry. That is the SAFE direction:
 * an unhashable directory can never match a shipped hash, so it is treated as a
 * user edit and left alone.
 */
export function hashSkillDir(dir: string): string | undefined {
  try {
    if (!statSync(dir).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  const files: string[] = [];
  const walk = (relative: string): boolean => {
    let entries: import('fs').Dirent[];
    try {
      entries = readdirSync(join(dir, relative), { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!walk(child)) return false;
        continue;
      }
      if (!entry.isFile()) return false;
      files.push(child);
    }
    return true;
  };
  if (!walk('')) return undefined;
  files.sort();
  const hash = createHash('sha256');
  for (const relative of files) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(dir, relative));
    } catch {
      return undefined;
    }
    hash.update(relative);
    hash.update('\0');
    hash.update(String(bytes.length));
    hash.update('\0');
    hash.update(bytes);
  }
  return hash.digest('hex');
}

/**
 * `hashSkillDir` of every bundled-skill revision this repository has shipped
 * BEFORE the receipt existed — the one-time bootstrap that lets an already
 * seeded profile be recognised as pristine.
 *
 * CLOSED BY CONSTRUCTION. Do not add to it. Every write from here on leaves a
 * receipt entry, so no new receipt-less copy can be created; a slug missing
 * from a receipt is either pre-P2.281 content (covered below) or a user's own
 * file (which must never be overwritten). Regenerate/verify with
 * `bun scripts/check-bundled-skill-seed-history.ts`, which walks this
 * repository's history for `apps/electron/resources/skills/` and recomputes the
 * same hashes. (The name here said `check-bundled-skill-history.ts` until
 * P6.1028 and no such file has ever existed — a citation nothing could resolve,
 * on the one instruction that keeps this table honest.)
 */
export const PRE_RECEIPT_SHIPPED_HASHES: Readonly<Record<string, readonly string[]>> = {
  'code-review': [
    // a69afa9cc (R71, unchanged through 688a4c37a) — the released text that
    // still tells the model to "Run the `review` tool", which exists only on Pi.
    '2b794269fac3bca7070ee4227cb0d81a40c08cf444aadae4d8c988aa4fb86c11',
    // fecfe1d7c (P2.212) — the correction, shipped before receipts existed.
    'e76467ef03b31a65395f89bad11794f649eeb890b45f5ea7166d1226647300f3',
  ],
  loop: [
    // 60ad5a35b (R39, unchanged through 688a4c37a).
    'b576b936ab9810d784f7dbb8b370fb81bfd3ec45ce73f08135e3f93faf826d89',
    // fecfe1d7c (P2.212).
    '6505a955e4abaac66e193107b32f858ff8979e7b0674633c79e026af5690426f',
  ],
  'plugin-creator': [
    // fb3cc59e4 — the only revision ever shipped.
    '284af012120fbfbb4a927c0b90af0ffa20cfeb46c6de1cf29a6c0e68d97710c7',
  ],
  'skill-creator': [
    // fb3cc59e4 — the only revision ever shipped.
    '772c6aaf728c916f6601880e8c3b6153edd2a48575cafd3a8cdef96ae5182fed',
  ],
};

/** Absolute path of a skills root's seed receipt. */
function receiptPath(skillsRoot: string): string {
  return join(skillsRoot, BUNDLED_SKILL_SEED_RECEIPT_FILE);
}

/**
 * Read a skills root's seed receipt, or an empty one when it is absent,
 * unreadable or malformed. Exported so a diagnostic — or the operator of a live
 * verification run asking which artefact a profile holds — can read it without
 * re-deriving the shape.
 */
export function readBundledSkillSeedReceipt(skillsRoot?: string): BundledSkillSeedReceipt {
  const empty: BundledSkillSeedReceipt = { version: 1, skills: {} };
  const path = receiptPath(skillsRoot ?? getManagedSkillsRoot());
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== 'object') return empty;
  const record = parsed as Record<string, unknown>;
  const skills: Record<string, BundledSkillSeedEntry> = {};
  const rawSkills = record.skills;
  if (rawSkills && typeof rawSkills === 'object') {
    for (const [slug, value] of Object.entries(rawSkills as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const entry = value as Record<string, unknown>;
      if (typeof entry.hash !== 'string' || !entry.hash) continue;
      skills[slug] = {
        hash: entry.hash,
        recordedAt: typeof entry.recordedAt === 'string' ? entry.recordedAt : '',
        reason: entry.reason === 'seed' || entry.reason === 'update' || entry.reason === 'adopted'
          ? entry.reason
          : 'adopted',
      };
    }
  }
  const customized = Array.isArray(record.customized)
    ? record.customized.filter((slug): slug is string => typeof slug === 'string')
    : undefined;
  return { version: 1, skills, ...(customized && customized.length > 0 ? { customized } : {}) };
}

/**
 * Write the receipt only when its content actually changed, so a settled
 * profile pays no write on every startup. Staged through a sibling temp file so
 * an interrupted run can never leave a truncated receipt (which would read as
 * "no receipt" and downgrade every slug to customized).
 */
function writeBundledSkillSeedReceipt(skillsRoot: string, receipt: BundledSkillSeedReceipt): void {
  const path = receiptPath(skillsRoot);
  const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
  try {
    if (readFileSync(path, 'utf-8') === serialized) return;
  } catch {
    // Absent or unreadable → write it.
  }
  const staging = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    if (!existsSync(skillsRoot)) mkdirSync(skillsRoot, { recursive: true });
    writeFileSync(staging, serialized, { mode: 0o600 });
    renameSync(staging, path);
  } catch {
    // A receipt we cannot write degrades to the old seed-once behaviour for
    // this profile, which is exactly the safe direction — never a lost edit.
    try {
      rmSync(staging, { force: true });
    } catch {
      // Nothing further to do.
    }
  }
}

/**
 * Replace `destDir` with a copy of `sourceDir`, staged through a temp sibling
 * so the destination is never left half-written. Only ever called for a
 * directory whose content hash matched something we shipped, so nothing the
 * user authored can be removed here.
 *
 * The staging name matches `resource-bundle.ts`'s existing `.tmp-<slug>-<id>`
 * convention for the same skills root.
 */
function replaceSkillDir(sourceDir: string, destDir: string, skillsRoot: string, slug: string): boolean {
  const staging = join(skillsRoot, `.tmp-${slug}-${process.pid}-${Date.now()}`);
  try {
    cpSync(sourceDir, staging, { recursive: true });
    rmSync(destDir, { recursive: true, force: true });
    renameSync(staging, destDir);
    return true;
  } catch {
    try {
      rmSync(staging, { recursive: true, force: true });
    } catch {
      // Nothing further to do.
    }
    return false;
  }
}

export interface EnsureBundledSkillsOptions {
  /**
   * Absolute target skills root. Defaults to `~/.nessy-agent/skills`
   * (CONFIG_DIR-derived). Test seam only — production never passes this.
   */
  skillsRoot?: string;
  /**
   * Absolute bundled-skill source dir. Defaults to the packaged
   * `resources/skills/` resolved via `getBundledAssetsDir('skills')`. Test seam
   * only — production never passes this.
   */
  bundledRoot?: string;
  /** Already-loaded `config.json` for the `disableBundledSkills` setting. */
  storedConfig?: unknown;
  /** Injectable environment for the off switch; production reads `process.env`. */
  env?: Record<string, string | undefined>;
  /**
   * Override for `PRE_RECEIPT_SHIPPED_HASHES`. Test seam only — production
   * never passes this, and it exists so the receipt-less bootstrap arm can be
   * exercised on synthetic content instead of being pinned to the bytes of a
   * real bundled skill (which would make every future edit of a `SKILL.md`
   * fail a test that is not about it).
   */
  preReceiptShippedHashes?: Readonly<Record<string, readonly string[]>>;
}

/**
 * Seed bundled built-in skills into the global managed skills root, and refresh
 * the copies that are still exactly as we shipped them.
 *
 * See the module header for the policy and its documentary basis. A
 * missing/empty bundle dir is a no-op, and the off switch short-circuits before
 * anything is read or written.
 *
 * @returns the slugs whose on-disk content this call WROTE — a fresh seed or a
 * refresh of a pristine copy. A slug already identical to the bundle, and a
 * slug the user has edited, are both absent from it.
 */
export function ensureBundledSkills(options: EnsureBundledSkillsOptions = {}): string[] {
  // `settings-reference.md#disablebundledskills` / `env-vars.md:225` — "Claude
  // Code removes bundled skills and workflows entirely, while built-in commands
  // such as `/init` stay typable but are hidden from the model." Seeding is
  // checked here rather than at the caller so every
  // entry point is covered, including the already-seeded profile the inventory
  // filter handles separately.
  if (bundledSkillsDisabled(options.storedConfig, options.env)) return [];
  const bundledRoot = options.bundledRoot ?? getBundledAssetsDir('skills');
  // No bundled seed source packaged/resolvable → nothing to seed.
  if (!bundledRoot || !existsSync(bundledRoot)) {
    return [];
  }

  const skillsRoot = options.skillsRoot ?? getManagedSkillsRoot();

  const written: string[] = [];
  try {
    const entries = readdirSync(bundledRoot);
    const receipt = readBundledSkillSeedReceipt(skillsRoot);
    const nextSkills: Record<string, BundledSkillSeedEntry> = { ...receipt.skills };
    const customized: string[] = [];
    let receiptChanged = false;
    // Create the target root lazily only when there is at least one skill to write.
    let rootEnsured = false;
    const ensureRoot = (): void => {
      if (rootEnsured) return;
      if (!existsSync(skillsRoot)) mkdirSync(skillsRoot, { recursive: true });
      rootEnsured = true;
    };
    const record = (slug: string, hash: string, reason: BundledSkillSeedReason): void => {
      nextSkills[slug] = { hash, recordedAt: new Date().toISOString(), reason };
      receiptChanged = true;
    };

    for (const slug of entries) {
      if (!isBundledSkillDir(bundledRoot, slug)) continue;

      const sourceDir = join(bundledRoot, slug);
      const destDir = join(skillsRoot, slug);
      const bundleHash = hashSkillDir(sourceDir);

      if (!existsSync(destDir)) {
        ensureRoot();
        try {
          cpSync(sourceDir, destDir, { recursive: true });
          written.push(slug);
          if (bundleHash) record(slug, bundleHash, 'seed');
        } catch {
          // One skill failing to copy must not block the others; skip it.
        }
        continue;
      }

      // The slug is already on disk. Decide by CONTENT whether it is still
      // ours (refresh it) or the user's (leave it, and say so in the receipt).
      // An unhashable BUNDLE says nothing about the profile, so it falls back
      // to the original leave-it-alone behaviour silently rather than
      // mislabelling the user's copy.
      if (!bundleHash) continue;
      const currentHash = hashSkillDir(destDir);
      if (!currentHash) {
        // Unhashable on disk (a symlink, an unreadable file): not something we
        // wrote, so it is left alone and reported like any other divergence.
        customized.push(slug);
        continue;
      }
      if (currentHash === bundleHash) {
        // Up to date. Record it so a LATER bundle can refresh it even on a
        // profile that predates the receipt.
        if (nextSkills[slug]?.hash !== currentHash) record(slug, currentHash, 'adopted');
        continue;
      }
      const shippedHashes = options.preReceiptShippedHashes ?? PRE_RECEIPT_SHIPPED_HASHES;
      const ours = nextSkills[slug]?.hash === currentHash
        || (shippedHashes[slug]?.includes(currentHash) ?? false);
      if (!ours) {
        customized.push(slug);
        continue;
      }
      ensureRoot();
      if (replaceSkillDir(sourceDir, destDir, skillsRoot, slug)) {
        written.push(slug);
        record(slug, bundleHash, 'update');
      }
    }

    customized.sort();
    const previousCustomized = receipt.customized ?? [];
    if (
      receiptChanged
      || customized.length !== previousCustomized.length
      || customized.some((slug, index) => slug !== previousCustomized[index])
    ) {
      writeBundledSkillSeedReceipt(skillsRoot, {
        version: 1,
        skills: nextSkills,
        ...(customized.length > 0 ? { customized } : {}),
      });
    }
  } catch {
    // Bundle dir unreadable → treat as a no-op (bundled skills are optional).
  }

  return written;
}
