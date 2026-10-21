/**
 * P3.364, Pi half — a PDF's bytes reach the model only on claude, and until now
 * only CODEX said so.
 *
 * ## What is pinned, and why it is pinned against SOURCE
 *
 * The codex half is a pure function (`buildCodexAttachmentInput`) and has its own
 * driven test. The Pi half is a branch inside `PiAgent.chat`'s async generator,
 * which cannot be reached without a live subprocess — so this follows the shape
 * `packaged-env-spelling.test.ts` and `shell-env-home.test.ts` already use for
 * exactly this situation: assert against the module's own source, and say what
 * that can and cannot prove.
 *
 * What it CAN prove: the branch exists, it is keyed on the taxonomy rather than
 * on a mime sniff, a markdown twin exempts a file, and the user-facing sentence
 * is the CODEX one — which is the whole point of the row, since one user meeting
 * two different sentences for the same fact on two runtimes is the divergence
 * being closed.
 *
 * What it CANNOT prove: that the yield reaches a transcript. That is a live
 * claim and belongs to a CDP case, not here.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PI = readFileSync(join(import.meta.dir, '..', 'pi-agent.ts'), 'utf8');
const CODEX = readFileSync(join(import.meta.dir, '..', 'codex-agent.ts'), 'utf8');

describe('the Pi attachment loop says when it drops a document', () => {
  it('collects uncarried names at all — the positive control', () => {
    // Without this, every assertion below could pass on a file where the
    // collector was deleted and the warning left unreachable.
    expect(PI).toContain('const uncarriedDocumentNames: string[] = []');
    expect(PI.match(/uncarriedDocumentNames\.push\(att\.name\)/g) ?? []).toHaveLength(2);
  });

  it('marks a PDF as unreadable rather than only naming its path', () => {
    expect(PI).toContain('[Contents NOT available: this runtime carries the path only,');
  });

  it('keys the file branch on the attachment TAXONOMY, not on a mime sniff', () => {
    // `FileAttachmentKind` is the predicate the codex half uses too, so the two
    // runtimes cannot disagree about which files are lost. `unknown` is
    // deliberately excluded — we do not know that it was dropped.
    expect(PI).toContain("att.type === 'office' || att.type === 'audio'");
    expect(PI).not.toContain("att.type === 'unknown'");
  });

  it('exempts a file that HAS a markdown twin — the negative control', () => {
    // A markdown version IS the contents, so warning about it would be a false
    // loss report. The `else if` ordering is what makes that true.
    const branch = PI.slice(PI.indexOf('if (att.markdownPath) {'));
    expect(branch.slice(0, 400)).toContain('Markdown version');
    expect(branch.slice(0, 400).indexOf('Markdown version'))
      .toBeLessThan(branch.slice(0, 400).indexOf('Contents NOT available'));
  });

  it('uses the SAME sentence as codex, which is the divergence being closed', () => {
    const sentence = 'sent as a file path only — ';
    expect(PI).toContain(sentence);
    expect(CODEX).toContain(sentence);
    // Both name the runtime that DOES carry the bytes, because that is the
    // action available to the user.
    expect(PI).toContain("The Claude runtime carries a PDF's bytes to the model");
    expect(CODEX).toContain("The Claude runtime carries a PDF's bytes to the model");
  });
});
