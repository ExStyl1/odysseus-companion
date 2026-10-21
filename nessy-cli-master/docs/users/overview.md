# Nessy CLI overview

[![@nestor/nessy-cli downloads](https://img.shields.io/npm/dw/@nestor/nessy-cli.svg)](https://artifactory.tcsbank.ru/artifactory/api/npm/npm-all/@nestor/nessy-cli/latest)

> Learn about Nessy CLI, Nessy's agentic coding tool that lives in your terminal and helps you turn ideas into code faster than ever before.

## Get started in 30 seconds

### Install Nessy CLI:

The recommended installer uses a standalone archive when one is available for
your platform. If it falls back to npm, Node.js 22 or later with npm must be
available on PATH.

**macOS**

```bash
    /usr/bin/curl -fsSL https://s3-msk.tinkoff.ru/nestor-companion/installation/install-nessy.sh | bash
```

**Linux**

```bash
    CURL=/usr/bin/curl
    [ -x "$CURL" ] || CURL=/bin/curl
    "$CURL" -fsSL https://s3-msk.tinkoff.ru/nestor-companion/installation/install-nessy.sh | bash
```

The absolute paths use the system certificate store instead of a `curl`
provided by Anaconda or another environment on `PATH`.

**Windows**

```cmd
    "%SystemRoot%\System32\curl.exe" -fsSL -o "%TEMP%\install-nessy.bat" https://s3-msk.tinkoff.ru/nestor-companion/installation/install-nessy.bat && "%TEMP%\install-nessy.bat"
```

The absolute path bypasses `curl.exe` provided by Anaconda or another
environment on `PATH`.

```cmd
powershell -Command "Invoke-WebRequest 'https://nessy-cli-assets.oss-cn-hangzhou.aliyuncs.com/installation/install -nessy.bat' -OutFile (Join-Path $env:TEMP 'install -nessy.bat'); & (Join-Path $env:TEMP 'install -nessy.bat')"
```

> [!note]
>
> It's recommended to restart your terminal after installation if `nessy` is not
> immediately available on PATH. If the installation fails, please refer to
> [Manual Installation](./quickstart#manual-installation) in the Quickstart
> guide. For offline installation, download a release archive and run the
> installer with `--archive PATH`; keep `SHA256SUMS` next to the archive.

### Start using Nessy CLI:

```bash
cd your-project
nessy
```

Select **Nessy OAuth (Free)** authentication and follow the prompts to log in. Then let's start with understanding your codebase. Try one of these commands:

```
what does this project do?
```

![](https://cloud.video.taobao.com/vod/j7-QtQScn8UEAaEdiv619fSkk5p-t17orpDbSqKVL5A.mp4)

You'll be prompted to log in on first use. That's it! [Continue with Quickstart (5 mins) →](./quickstart)

> [!tip]
>
> See [troubleshooting](./support/troubleshooting) if you hit issues.

> [!note]
>
> **New VS Code Extension (Beta)**: Prefer a graphical interface? Our new **VS Code extension** provides an easy-to-use native IDE experience without requiring terminal familiarity. Simply install from the marketplace and start coding with Nessy CLI directly in your sidebar. Download and install the [Nessy CLI Companion](https://marketplace.visualstudio.com/items?itemName=nessy-cli-vscode-ide-companion) now.

## What Nessy CLI does for you

- **Build features from descriptions**: Tell Nessy CLI what you want to build in plain language. It will make a plan, write the code, and ensure it works.
- **Debug and fix issues**: Describe a bug or paste an error message. Nessy CLI will analyze your codebase, identify the problem, and implement a fix.
- **Navigate any codebase**: Ask anything about your team's codebase, and get a thoughtful answer back. Nessy CLI maintains awareness of your entire project structure, can find up-to-date information from the web, and with [MCP](./features/mcp) can pull from external datasources like Google Drive, Figma, and Slack.
- **Automate tedious tasks**: Fix fiddly lint issues, resolve merge conflicts, and write release notes. Do all this in a single command from your developer machines, or automatically in CI.
- **[Followup suggestions](./features/followup-suggestions)**: Nessy CLI predicts what you want to type next and shows it as ghost text. Press Tab to accept, or just keep typing to dismiss.

## Why developers love Nessy CLI

- **Works in your terminal**: Not another chat window. Not another IDE. Nessy CLI meets you where you already work, with the tools you already love.
- **Takes action**: Nessy CLI can directly edit files, run commands, and create commits. Need more? [MCP](./features/mcp) lets Nessy CLI read your design docs in Google Drive, update your tickets in Jira, or use _your_ custom developer tooling.
- **Unix philosophy**: Nessy CLI is composable and scriptable. `tail -f app.log | nessy -p "Slack me if you see any anomalies appear in this log stream"` _works_. Your CI can run `nessy -p "If there are new text strings, translate them into French and raise a MR for @lang-fr-team to review"`.
