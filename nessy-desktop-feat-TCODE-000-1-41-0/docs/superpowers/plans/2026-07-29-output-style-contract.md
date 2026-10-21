# S11 — Output styles: the frontmatter, and where a style may come from

From the phase-4 sweep (`2026-07-29-phase4-findings.md`, `output-styles.md` and
`modifying-system-prompts.md`). The last open row from that sweep besides the
sandbox network half.

**We have a real, live output-style concept on Pi** — builtin styles plus
`.nessy-agent/output-styles/*.md`, appended to the system prompt on every turn.
The row is not "build output styles"; it is that ours parses none of the
documented frontmatter and resolves a style from the wrong root.

R29b already closed the fork half of this area (a fork inherits the style, a
named subagent no longer does). **Do not re-open that.**

---

## 0. Method rules

1. **Fetch the pages yourself**: `curl -s https://code.claude.com/docs/en/output-styles.md`
   and `.../agent-sdk/modifying-system-prompts.md`. Never a summarising fetch
   tool — it invented field names twice in this series and both shipped.
2. **The quotation is the identifier, not the line number.** Report where you
   found each, and read the **whole line** — an executor recently reported a
   sentence deleted when it was the second half of the line they quoted as
   replacing it.
3. **Read around each quotation.**
4. **Declared ≠ enforced.** Prove each change on **Pi**, the shipped default.
5. **Two git commands** — pathspec on the `commit`.
6. Expected pre-existing failures:
   `docs/superpowers/specs/2026-07-29-known-failing-tests.md`. It has been short
   three times and wrong once the other way, so reproduce anything you call
   pre-existing, and say if it reproduces in a worktree but passes in the repo.
7. **`rg` silently skips files with a NUL byte; eight of ours have one** —
   tracker method note 11a. Use `grep -a` for absence claims.

---

## 1. The two findings

Verify both before building.

**(a) The frontmatter is discarded.** `stripFrontmatter` in
`packages/shared/src/prompts/output-styles.ts` throws away `name`,
`description` and `keep-coding-instructions`. The last of those is the one that
matters: `keep-coding-instructions: false` must **subtract** the built-in
engineering guidance that `getSafetyAndEngineeringSections` composes
unconditionally (`prompts/system.ts`), and our prompt builder has no seam for
that. Without it the page's core use — being something other than a software
engineer — is unreachable.

**(b) A merely-opened repository can substitute a style.** `outputStyleId` is
stored app-globally (`config/storage.ts`) but resolved by a
**working-directory-first** search (`output-styles.ts`). Proven by execution in
the sweep: open a repository that ships a style with the same id, and its prose
replaces the one the user chose elsewhere — landing in the system prompt, the
highest-trust text in the turn.

---

## 2. Tasks

### Task 1 — read the frontmatter

**Commit:** `feat(prompts): an output style's frontmatter is parsed, not discarded`

Parse the documented fields. Establish the full list from the page rather than
from this plan.

- `name` and `description` are metadata; decide where they surface (the picker
  is the obvious place) and say so.
- **`keep-coding-instructions: false` is the hard one.** It must remove the
  built-in engineering guidance, which today is composed unconditionally. Build
  the seam. Do **not** implement it by string-replacing the composed prompt —
  the composition must know it is optional.
- **Safety text is not coding guidance.** `getSafetyAndEngineeringSections`
  composes both under one name. A style must be able to drop the engineering
  half and must **never** be able to drop the safety half. If those two are
  currently inseparable, separating them is part of this task, and say so.

**Gate:** a style with `keep-coding-instructions: false` produces a system
prompt without the engineering sections **and with** the safety sections. Assert
both halves — asserting only the removal would pass while safety text was
dropped too.

---

### Task 2 — a style comes from a trusted root

**Commit:** `fix(prompts): an opened repository cannot substitute the selected output style`

The app-global selection must not be resolvable from an untrusted
working-directory root.

Establish the documented scope from the page — it names user and project levels
— and decide what "project" means for us given that we already have a
project-trust concept. A project-scoped style is legitimate when the user has
trusted that project; the defect is that *any* opened repository can shadow a
selection made elsewhere.

Whatever rule you pick, the failing case in § 1(b) must stop failing, and a
legitimately trusted project style must still work.

**Gate:** the sweep's own case — same style id in an untrusted opened repo —
resolves to the user's style, not the repo's. Plus the positive: a trusted
project style still applies.

---

### Task 3 — the rest of both pages

**Commit:** `docs(prompts): the output-style rows we do not implement`

Category strings. The sweep counted 14 findings on `output-styles.md` and 14 on
`modifying-system-prompts.md`; verify rather than copy. Our preset/append
composition on the Claude path was found **fully conformant** — confirm that
rather than assuming it.

Note `force-for-plugin` explicitly. It lets a plugin apply its style
automatically, overriding the user's setting — plugin-shipped styles are **not**
in this unit (that is B1's `outputStyles` item), so record what would have to be
true before `force-for-plugin` could be safe here.

**Write the strings unwrapped, unbolded and backtick-terminated**, then confirm:
`python3 scripts/regenerate-deviation-register.py | grep -i style`.

---

## 3. Gate

Focused suites for every changed file, plus the prompts, config and agent
aggregates; `bun run typecheck:all`; `bun run lint`; i18n parity/sorted if you
add strings; `git diff --check`.

This changes **system-prompt composition**, which every turn depends on. Run the
prompt and session aggregates once on the final diff.

**Run every test from the repository ROOT.** A package-directory run bypasses the
config-dir isolation preload and destroys the user's real
`~/.nessy-agent/config.json`.

**Mutation probe:** revert the trusted-root rule and the § 1(b) case must go red.

---

## 4. Constraints

- One commit per task, subjects exactly as given. **No `Co-Authored-By` trailers.**
  If a review finding forces an extra commit, take it and say so.
- No push, MR or tags. No `reset`, `rebase`, `--amend`. Never `git checkout --`
  or `git stash` a file you are editing.
- Pathspec on the commit itself.
- **Two other agents are working concurrently**: one in
  `packages/shared/src/plugins/`, one in the sandbox/isolation code
  (`config/sandbox-settings.ts`, `pi-agent-server` isolation,
  `server-core/src/pi-harness/`). Stay out of both. Your work is in
  `packages/shared/src/prompts/` and the config storage that holds
  `outputStyleId`.
- Do not touch `docs/superpowers/specs/` or `docs/testing/cdp-live-checklist.md`
  (planner-owned), nor `~/.nessy-agent/skills/r17-*` or
  `~/.nessy-agent/mcp/elicit-server.mjs` (CDP fixtures).
- No version bumps, no release notes. Never write to `~/.nessy/dp_auth_creds.json`.
- Code, comments and commits in English.

## 5. Report

Commit shas; the line you found each quotation at; **every correction to this
plan**; whether safety and engineering text were separable and what you did;
the trusted-root rule you chose and why; the category strings with proof they
appear in the register; and the mutation probe.

---

## 6. The rows we do not implement

Verified against the two pages as fetched on 2026-07-29, not copied from the
sweep. The sweep's count of 14 findings per page is right for
`output-styles.md` and wrong for `modifying-system-prompts.md`: that page is
mostly SDK ergonomics we either already match or cannot have, and it yields six
real rows, two of them inapplicable rather than missing.

**Confirmed rather than assumed:** our preset/append composition on the Claude
path is fully conformant. `buildClaudeTurnShapeOptions`
(`agent/claude-agent.ts:268`) emits exactly the documented shape —
`{ type: 'preset', preset: 'claude_code', append, excludeDynamicSections: true }`
with `settingSources: ['user', 'project', 'local']` — which matches
`modifying-system-prompts.md:23` (preset), `:160` (append),
`:217` (`excludeDynamicSections`, and `:220`'s note that it applies only to the
preset object form, which is why the mini agent's plain-string prompt omits it)
and `:54`/`:156` (setting sources, including the `project` source CLAUDE.md
discovery needs).

### `output-styles.md`

- `documented, not implemented — output-styles.md:21 ships a Proactive built-in style that executes immediately, makes reasonable assumptions instead of pausing for routine decisions, and prefers action over planning, without changing the permission mode. Nessy ships four built-ins, Default, Concise, Explanatory and Reviewer, and none of them is an autonomy posture. The nearest thing we have is auto mode, which the same line calls weaker guidance and which is a permission mode rather than a style`
- `documented, not implemented — output-styles.md:25 ships a Learning built-in style that asks the user to contribute small strategic pieces of code and marks the spots in the file with a TODO(human) marker. Nessy has no collaborative style and no marker convention, so the learn-by-doing half of the built-in set has no equivalent`
- `documented, not implemented — output-styles.md:23 makes Explanatory emit educational Insights interleaved with the work, a named and recognisable output convention. Our explanatory built-in asks only for reasoning and tradeoffs in prose, with no Insights marker, so the same style name produces differently shaped answers in the two products`
- `documented, not implemented — output-styles.md:29 saves the selection to a settings file at the local project level, so the style can differ per repository. Nessy stores outputStyleId once, app-globally, in config.json. There is no per-project selection, so a user who wants one voice in one repository and another elsewhere has to change the global setting every time they switch projects`
- `documented, not implemented — output-styles.md:33 makes the selection an ordinary settings key editable directly in any settings file, which puts it under the documented settings precedence with its managed, user, project and local tiers. Ours is a private config.json field written only by one RPC handler, so no administrator and no repository can set or pin it and no precedence applies to it`
- `documented, not implemented — output-styles.md:53 adds a managed policy level, an output-styles directory inside the managed settings directory, so an enterprise deployment can ship a house style. Nessy reads a user directory, a workspace directory and a trusted project directory, and has no managed tier for styles at all`
- `documented, not implemented — output-styles.md:55 loads project styles from every nested directory between the working directory and the repository root, and resolves a same-name collision to the one closest to the working directory. We read exactly one project directory, the working directory's own, so a style defined at the repository root is invisible from any subdirectory`
- `documented, not implemented — output-styles.md:41 reads the output style once at session start and needs a clear or a new session before a change takes effect. Nessy re-reads the app-global selection every turn, so a change lands mid-session and rewrites the cacheable system prefix underneath a running conversation. Ours is the friendlier behaviour and the cache cost is real, and it is a deviation in either direction`
- `documented, not implemented — output-styles.md:101 says all output styles trigger reminders to adhere to the style during the conversation, a second injection point beyond the system prompt. Nessy injects the style block once, in the system prompt, and never restates it, so a long conversation drifts back toward the default voice with nothing to pull it back`
- CLOSED by B1c (`feat(plugins): a plugin's output styles reach the picker`). This row said output-styles.md:83's plugin styles only reached diagnostics. They are an `output-style` capability now: the field and the default directory are scanned through B1a's resolver, the styles reach the picker and the system prompt, and the deferral this row named is gone. Struck rather than reworded so the register stops reporting it.
- `documented, not implemented — output-styles.md:94 defines force-for-plugin, which applies a plugin's style automatically whenever the plugin is enabled and overrides the user's own selection, with the first enabled plugin winning. Three things would have to be true before it could be safe here. Plugin-shipped styles would have to exist at all, which B1c did. A plugin style would have to pass the same trust gate a project style now passes, because a style that overrides the user's selection without being chosen is exactly the substitution this unit just closed, arriving through a different door. And the picker would have to name the plugin that displaced the choice and offer a way back, since an override the user cannot see or undo is indistinguishable from the app ignoring the setting`
- `documented, not implemented — output-styles.md:29 and :79 put the picker behind a /config slash command, so the style can be changed from inside the conversation. Nessy exposes it only on the desktop Settings AI page over an RPC pair. There is no slash command and the headless CLI has no output-style surface, so a scripted or terminal run cannot see or change the active style`
- `documented, not implemented — output-styles.md:102 says a custom output style leaves out the built-in software engineering instructions. On the Pi backend it now does. On the Claude backend our whole prompt is an append to the claude_code preset, and the preset's own coding guidance lives inside the SDK where an append cannot subtract it, so keep-coding-instructions false removes Nessy's engineering sections and leaves Claude Code's in place. Claude is an opt-in provider, off by default at build time, which bounds it rather than fixing it`
- `documented, not implemented — output-styles.md:125 points at a configuration doctor for diagnosing why an output style is not taking effect. Our config doctor says nothing about styles: it cannot report which of the three roots the active id resolved from, nor that a project style was skipped because the project is untrusted, which is now the most likely reason a style a user can see in their repository does not apply`

### `modifying-system-prompts.md`

- `documented, not implemented — modifying-system-prompts.md:148 selects an output style through an outputStyle key inside the inline settings object passed to query, or through a settings file the same option points at. Nessy never passes it: we resolve the style ourselves and fold it into the append text. The consequence is on the other side of the same seam, because we do pass settingSources with project and local, so on the Claude backend an opened repository's own .claude/settings.local.json can still set outputStyle and the SDK will honour it inside the preset. The trust gate this unit added covers our resolver and not the SDK's`
- `documented, not implemented — modifying-system-prompts.md:120 stores styles at a user path and a project path under the .claude namespace. Nessy reads .nessy-agent/output-styles and a user directory under the Nessy configuration root, and reads .claude/output-styles nowhere. A style file authored for Claude Code is therefore invisible here even though our plugin adapters exist precisely to import Claude components, and the file needs to be copied rather than found`
- `documented, not implemented — modifying-system-prompts.md:405 layers a session-specific append on top of a persistent output style, so one session can add focus areas without editing the saved style. Nessy has no append surface of any kind for a user or a caller. The append slot is fully occupied by our own composed prompt, so the two customization methods the page says compose cannot compose here`
- `documented, not implemented — modifying-system-prompts.md:271 names a non-interactive CLI flag for excluding the dynamic system prompt sections. Our headless CLI has no flag for it. The behaviour itself is on unconditionally on the Claude path, which is the safer default for caching and the wrong one for a caller who wants the environment context back in the system prompt, and there is no way to ask`
- `documented, inapplicable — modifying-system-prompts.md:22 describes the minimal default the SDK uses when no system prompt is set, tool calling and nothing else. Nessy is a product with one prompt strategy per backend rather than an SDK surface, so there is no caller who could choose it and nothing that would work if they did`
- `documented, inapplicable — modifying-system-prompts.md:154 and :334 cover the Python SDK, which has no programmatic output-style option and needs a file-typed system prompt to avoid the argument-length limit at process spawn. Nessy has no Python SDK path; the Claude backend spawns the SDK's own native binary and Pi runs in a Bun subprocess`
