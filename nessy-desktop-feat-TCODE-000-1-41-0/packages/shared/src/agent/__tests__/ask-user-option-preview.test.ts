/**
 * P6.471 · `AskUserQuestionOption.preview`, end to end across three runtimes.
 *
 * The row's shape was "produced by Pi and rendered by nobody, and claude's own
 * `previewFormat` is unset". The renderer half landed with W7-n; what this file
 * pins is the two ends that can silently come apart again — the claude opt-in,
 * and the fact that setting it to `'html'` would break the component that draws
 * it — plus the codex `n/a`, machine-checked against the generated contract so
 * it stops being a claim in prose.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';
import type { Options } from '@anthropic-ai/claude-agent-sdk';

const claudeAgentSource = readFileSync(
  fileURLToPath(new URL('../claude-agent.ts', import.meta.url)),
  'utf8',
);

describe('the claude spawn OPTS IN to option previews', () => {
  test('`toolConfig.askUserQuestion.previewFormat` is set, inside the options literal', () => {
    // Not a restatement of a default. `agent-sdk/typescript.md#toolconfig`:
    // "Opts into the `preview` field on AskUserQuestion options and sets its
    // content format. When unset, Claude does not emit previews" — so the
    // absence of this line is the absence of the whole feature, whatever
    // `sdk.d.ts`'s `@default 'markdown'` annotation on the FIELD suggests.
    const option = claudeAgentSource.indexOf(
      "toolConfig: { askUserQuestion: { previewFormat: 'markdown' } }",
    );
    expect(option).toBeGreaterThanOrEqual(0);
    const literal = claudeAgentSource.indexOf('const options: Options = {');
    expect(literal).toBeGreaterThanOrEqual(0);
    expect(option).toBeGreaterThan(literal);
  });

  test('the value the SDK type accepts is the value we send', () => {
    // A type-level control, so a rename or a narrowed union in a lifted SDK
    // fails here rather than at a spawn.
    const config: NonNullable<Options['toolConfig']> = {
      askUserQuestion: { previewFormat: 'markdown' },
    };
    expect(config.askUserQuestion?.previewFormat).toBe('markdown');
  });

  test("`'html'` and the renderer are ONE decision, so the component is pinned beside it", () => {
    // `agent-sdk/user-input.md#option-previews-typescript`: markdown `preview`
    // contains "ASCII art and fenced code blocks", html "A styled `<div>`
    // fragment". `AskUserRequest.tsx` draws the field into a `<pre>`, which
    // would print an HTML fragment as literal markup — so whichever of the two
    // is changed alone, this test is the one that says so.
    expect(claudeAgentSource).not.toContain("previewFormat: 'html'");
    const component = readFileSync(
      fileURLToPath(new URL(
        '../../../../../apps/electron/src/renderer/components/app-shell/input/structured/AskUserRequest.tsx',
        import.meta.url,
      )),
      'utf8',
    );
    expect(component).toContain('{option.preview && (');
    expect(component).toContain('<pre className=');
  });
});

describe('codex is an honest `n/a` on this field, and the reason is not the one the row recorded', () => {
  test('codex HAS a question surface — the "zero AskUserQuestion" clause is refuted at HEAD', () => {
    const codexAgent = readFileSync(
      fileURLToPath(new URL('../codex-agent.ts', import.meta.url)),
      'utf8',
    );
    // `item/tool/requestUserInput` is mapped onto the same card Pi and claude
    // use. A row scoring codex `absent` because it has no question surface at
    // all is scoring a state that no longer exists.
    expect(codexAgent).toContain('handleCodexRequestUserInput');
    expect(codexAgent).toContain('AskUserQuestionItem');
  });

  test('but its OPTION type carries no preview, which is what makes the `n/a` honest', () => {
    // The generated contract, never hand-edited:
    // `ToolRequestUserInputOption = { label: string, description: string }`.
    const generated = readFileSync(
      fileURLToPath(new URL(
        '../../../../codex-protocol/generated/v2/ToolRequestUserInputOption.ts',
        import.meta.url,
      )),
      'utf8',
    );
    expect(generated).toContain('label: string');
    expect(generated).toContain('description: string');
    // The assertion that matters: the day codex's option grows a preview field,
    // this fails and the `n/a` has to be re-decided rather than inherited.
    expect(generated).not.toContain('preview');
  });
});
