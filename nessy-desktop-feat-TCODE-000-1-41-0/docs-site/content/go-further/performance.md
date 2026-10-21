# Performance and Token Optimization

Verbose command output is one of the quickest ways to burn context: a big `git diff`, a recursive listing, or a long test log fills the conversation with text the model still has to read. Nessy Desktop can route Bash output through [RTK](https://github.com/rtk-ai/rtk) — a local CLI that shrinks the noisy output of everyday dev commands before the model ever sees it.

RTK leaves execution speed untouched. What it trims is the token bill: the same result reaches the model in a fraction of the text, freeing context for code and reasoning.

::: tip
The permission prompt always shows the **original** command, and that exact command is what executes. RTK touches nothing but the output routed back to the model.
:::

## What It Helps With

Token optimization pays off most in coding and repository work, where sessions run commands that print a lot of repetitive text:

```bash
git diff
rg "TODO|FIXME" .
bun test
ls -R
```

Leave the feature off and every byte of raw output lands in the conversation verbatim. Turn it on and Nessy Desktop hands eligible Bash commands to RTK, which compacts what comes back before the model reads it. Benefits:

- Lower token usage on common development commands.
- More context left for the actual work.
- Less noise from long diffs, listings, and logs.
- Saved-token statistics visible in Settings.

Commands that already print short, targeted output see little benefit.

## Requirements

- The `rtk` binary installed on your PATH.
- RTK version `0.44.0` or newer. Releases from `0.23.0` to `0.43.x` change the output the agent reads without saying so — a `grep` line containing a colon is cut, input redirected into `wc` is ignored, piped output can crash — so Nessy Desktop never routes commands through them (see [An Outdated RTK](#an-outdated-rtk)). Releases before `0.23.0` have no `rtk rewrite` at all and count as not installed.
- A Pi or Claude Code session. Codex sessions run their commands unchanged: RTK is not wired into the Codex runtime.

Nessy Desktop does **not** bundle RTK. It looks for an `rtk` executable already on your PATH and runs it locally, passing a flag that suppresses RTK's telemetry on every call. There is no `rtk init` step to run — that command wires RTK into other tools' hooks, and Nessy Desktop simply calls `rtk rewrite` on its own.

## Enabling It

1. Install RTK for your platform (Homebrew, the install script, or Cargo — see the RTK project).
2. Under **Settings → AI → Performance**, hit **Re-check**. Changed your PATH recently? Quit and relaunch Nessy Desktop first, otherwise the desktop process keeps the stale environment.
3. Turn on **Token Optimization**.
4. Work through a session that runs plenty of commands.
5. Back in the same **Performance** panel, check the saved-token summary once RTK has chewed through a few of them.

A panel still stuck on **Get RTK** means one of three things: no binary at all, a version older than `0.23.0`, or a binary the desktop app's PATH can't reach. Detection is cached per process, so relaunch the app whenever you install or upgrade RTK.

## An Outdated RTK

When the `rtk` on your PATH is between `0.23.0` and `0.43.x`, the **Performance** panel says **rtk *version* is outdated** — "Paused: versions before 0.44.0 corrupt some command output" — and Token Optimization stays paused: commands run unchanged until a safe version is found. The **Update…** button opens a dialog that names the minimum version and where the outdated copy is installed. While Token Optimization is on, the same dialog opens by itself once for each outdated version; **Later** dismisses it for that version.

Nessy Desktop does not suggest an installer command. Update RTK the way you installed it (Homebrew, the install script or Cargo), then press **Re-check** in the dialog. If it still finds the old version, another copy is earlier on your PATH, or the terminal that launched the app still has the old PATH — restart it.

## How Rewriting Works

For each Bash command, Nessy Desktop asks `rtk rewrite` whether there is a compressed equivalent:

- If RTK returns a rewrite, the SDK runs the compressed form and the model sees the compact output.
- If there is no equivalent, the command runs unchanged.
- On any error — timeout, spawn failure, or identical output — Nessy Desktop falls through to the original command.

The model's conversation history still shows the command you actually ran (`git status`), not the rewritten form.

While RTK is active, the agent's instructions say that the output of common commands is compacted and how to get the exact output when it needs it.

### Commands RTK leaves alone

Some commands are never handed to RTK:

- A command that starts with `command` or `builtin` — the usual way to ask for the real program, and the escape the agent is told to use for exact output.
- A program named by its path (`/usr/bin/grep`) or with a leading backslash (`\grep`): RTK itself leaves those alone.
- Any base command you list in `rtkExcludeCommands` in [`config.json`](../reference/config/config-file). Use it for a tool whose output you always want verbatim:

```json
{
  "rtkEnabled": true,
  "rtkExcludeCommands": ["grep", "jq"]
}
```

The list is matched against the first word of the command and is read on every call, so an edit applies to the next command without a relaunch.

## Troubleshooting

- **Panel insists RTK is missing.** Press **Re-check** first. Still no luck? Run `rtk` from the same OS shell the app inherits (`which rtk && rtk --version` on macOS/Linux, `Get-Command rtk; rtk --version` on Windows). Windows users especially: the binary has to live on the Windows PATH itself, not merely on a Git Bash/MSYS PATH.
- **`rtk --version` works but the toggle won't enable.** Check the version — `0.44.0` or newer is required; an older one shows as outdated (see [An Outdated RTK](#an-outdated-rtk)).
- **Output looks wrong for one tool.** Add its command name to `rtkExcludeCommands`, or ask the agent to prefix the command with `command`.
- **`rtk gain` looks wrong.** Make sure you installed `rtk-ai/rtk`, not an unrelated tool that shares the binary name.

## Other Latency Factors

RTK addresses token cost, not wall-clock speed. Most perceived latency comes from model response time, source calls, and document conversion. A few habits keep sessions responsive:

- Keep prompts focused and enable only the sources a session needs.
- Summarise or start fresh before a long implementation phase rather than dragging a huge history along.
- Prefer a narrow [local folder](../sources/local-filesystems) source over pointing the agent at a broad directory tree.
- Pick the model that fits the task — see [model choice below](#model-choice).

## Model Choice

The built-in [Nessy Gateway](../getting-started/introduction) offers a default coder model and a faster, lighter model. Use the fast model when latency matters more than maximum reasoning depth, and the coder model for deep implementation work.
