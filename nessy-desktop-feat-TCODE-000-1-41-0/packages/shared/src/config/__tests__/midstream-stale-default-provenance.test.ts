/**
 * P6.186 — the prerequisite of the no-migration decision, pinned.
 *
 * `defaultMidStreamBehavior` flipped `codex-runtime` and `claude-runtime` from
 * `'queue'` to `'steer'` on 2026-08-17 (`764ee8662`), and the flip reaches NEW
 * connections only: `connection-setup-logic.ts:337` persists the default at
 * creation and `resolveMidStreamBehavior` honours a stored value over it. The
 * blast radius of that is now a number, measured on a real profile upgraded
 * across the flip and recorded beside the decision in `llm-connections.ts` — 5 of
 * 11 stored rows, which is EVERY `claude-runtime` and `codex-runtime` row on that
 * profile.
 *
 * The decision not to migrate rests on ONE fact: the field carries no
 * provenance, so nothing can tell a value the app wrote as its own default from
 * one the user picked in Settings → AI. That fact is a property of the tree, and
 * a property of the tree can stop being true silently — someone adding
 * `midStreamBehaviorSource` for an unrelated reason would quietly make the
 * migration possible while the paragraph still says it is not.
 *
 * So this file pins the ABSENCE, and nothing else: the defaults and the
 * stored-value-wins behaviour are already covered by `midstream-behavior.test.ts`
 * and are deliberately not repeated here.
 */
import { describe, expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));

/** Tracked files under `packages/` and `apps/` naming `needle`. */
const trackedFilesNaming = (needle: string): string[] => {
  const found = Bun.spawnSync(
    ['git', 'grep', '-l', '-a', '-F', '-e', needle, '--', 'packages', 'apps'],
    { cwd: REPO_ROOT },
  );
  return new TextDecoder().decode(found.stdout).split('\n').filter(line => line.length > 0);
};

const isTest = (path: string): boolean => path.includes('__tests__') || path.includes('.test.');

describe('P6.186 · the field that would make a migration possible does not exist', () => {
  it('names midStreamBehaviorSource only where it is described as future work', () => {
    const carriers = trackedFilesNaming('midStreamBehaviorSource').filter(path => !isTest(path));

    // THE PIN. The only production file allowed to name it is the one whose
    // docblock explains why it does not exist. Anything else means the field
    // arrived, the no-migration decision's premise is gone, and the paragraph in
    // `llm-connections.ts` has to be re-taken rather than left standing.
    expect(carriers).toEqual(['packages/shared/src/config/llm-connections.ts']);
  }, 60_000);

  it('the same instrument finds the field that DOES exist, in many places', () => {
    // POSITIVE CONTROL for the assertion above: without it, a `git grep` that had
    // stopped reading the tree would report a clean absence forever.
    const carriers = trackedFilesNaming('midStreamBehavior');
    expect(carriers.length).toBeGreaterThan(5);
    expect(carriers).toContain('packages/shared/src/config/llm-connections.ts');
    expect(carriers).toContain('packages/server-core/src/domain/connection-setup-logic.ts');

    // ZERO CONTROL on the identical instrument — and the needle is ASSEMBLED,
    // not spelled, which is load-bearing (P6.1053). `git grep` reads tracked
    // blobs in their working-tree state, so while this file was still untracked
    // the control was clean and passed; the commit that added it (`c115d3ffe`)
    // made the file its own only hit, and the control has reported a nonsense
    // needle as PRESENT ever since. Split, the string exists nowhere in the tree,
    // which is what a zero control has to be able to say about itself. Same
    // guard, same reason, as the assembled key in `numeric-setting.test.ts`.
    const absentNeedle = `midStreamBehaviorZz${'NotAField'}P6186`;
    expect(trackedFilesNaming(absentNeedle)).toEqual([]);
  }, 60_000);

  it('the persisted field survives an unrelated save, which is why a stale value is durable', () => {
    // `updateLlmConnection`'s merge is an ALLOWLIST by construction and says so:
    // a field absent from it is dropped on the next save of any OTHER field. That
    // is the reason a provenance field is not free — it has to be added there
    // too — and the reason `midStreamBehavior` itself never decays back to the
    // default on its own. Pinned at the source rather than through a config
    // round-trip, because the claim being made is about that merge's shape.
    const storage = Bun.file(`${REPO_ROOT}packages/shared/src/config/storage.ts`);
    return storage.text().then(source => {
      expect(source).toContain('this merge is an ALLOWLIST');
      expect(source).toContain(
        'midStreamBehavior: updates.midStreamBehavior !== undefined ? updates.midStreamBehavior : existing.midStreamBehavior',
      );
      // NEGATIVE: the provenance twin is not in the merge either, so adding the
      // field without touching this list would silently drop it.
      expect(source).not.toContain('midStreamBehaviorSource:');
    });
  });
});
