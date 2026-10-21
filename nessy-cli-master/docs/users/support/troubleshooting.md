# Troubleshooting

This guide provides solutions to common issues and debugging tips, including topics on:

- Authentication or login errors
- Frequently asked questions (FAQs)
- Debugging tips
- Existing GitHub Issues similar to yours or creating new Issues

## Authentication or login errors

- **Error: `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, or `unable to get local issuer certificate`**
  - **Cause:** You may be on a corporate network with a firewall that intercepts and inspects SSL/TLS traffic.
  - **Solution:** Nessy CLI automatically uses the bundled corporate CA certificate. If you still see this error, contact your network administrator or reach out to the Nessy CLI team for assistance.

- **Error: `Device authorization flow failed: fetch failed`**
  - **Cause:** Node.js could not reach DP Auth endpoints (often a proxy or SSL/TLS trust issue). When available, Nessy CLI will also print the underlying error cause (for example: `UNABLE_TO_VERIFY_LEAF_SIGNATURE`). Note: this error is specific to the legacy DP Auth flow.
  - **Solution:**
    - If you are still using DP Auth, switch to API Key or Coding Plan via `/auth`.
    - If you are behind a proxy, set it via `nessy --proxy <url>` (or the `proxy` setting in `settings.json`).
    - If the error persists, contact your network administrator or the Nessy CLI team for assistance.

- **Issue: Unable to display UI after authentication failure**
  - **Cause:** If authentication fails after selecting an authentication type, the `security.auth.selectedType` setting may be persisted in `settings.json`. On restart, the CLI may get stuck trying to authenticate with the failed auth type and fail to display the UI.
  - **Solution:** Clear the `security.auth.selectedType` configuration item in your `settings.json` file:
    - Open `~/.nessy/settings.json` (or `./.nessy/settings.json` for project-specific settings)
    - Remove the `security.auth.selectedType` field
    - Restart the CLI to allow it to prompt for authentication again

## Frequently asked questions (FAQs)

- **Q: How do I update Nessy CLI to the latest version?**
  - A: If you installed Nessy CLI with the standalone installer, rerun the standalone install command. If you installed it globally via `npm`, update it using the command `npm install -g @nestor/nessy-cli@latest`. If you compiled it from source, pull the latest changes from the repository, and then rebuild using the command `npm run build`.

- **Q: Where are the Nessy CLI configuration or settings files stored?**
  - A: The Nessy CLI configuration is stored in two `settings.json` files:
    1. In your home directory: `~/.nessy/settings.json`.
    2. In your project's root directory: `./.nessy/settings.json`.

    Refer to [Nessy CLI Configuration](../configuration/settings) for more details.

- **Q: Why don't I see cached token counts in my stats output?**
  - A: Cached token information is only displayed when cached tokens are being used. This feature is available for API key users (Nessy API key or Google Cloud Vertex AI) but not for OAuth users (such as Google Personal/Enterprise accounts like Google Gmail or Google Workspace, respectively). This is because the Nessy CLI Assist API does not support cached content creation. You can still view your total token usage using the `/stats` command.

## Common error messages and solutions

- **Error: `EADDRINUSE` (Address already in use) when starting an MCP server.**
  - **Cause:** Another process is already using the port that the MCP server is trying to bind to.
  - **Solution:**
    Either stop the other process that is using the port or configure the MCP server to use a different port.

- **Error: Command not found (when attempting to run Nessy CLI with `nessy`).**
  - **Cause:** The CLI is not correctly installed or it is not in your system's `PATH`.
  - **Solution:**
    The update depends on how you installed Nessy CLI:
    - If you installed `nessy` with the standalone installer, rerun the standalone install command and then open a new terminal.
    - If you installed `nessy` globally, check that your `npm` global binary directory is in your `PATH`. You can update using the command `npm install -g @nestor/nessy-cli@latest`.
    - If you are running `nessy` from source, ensure you are using the correct command to invoke it (e.g. `node packages/cli/dist/index.js ...`). To update, pull the latest changes from the repository, and then rebuild using the command `npm run build`.

- **Error: `MODULE_NOT_FOUND` or import errors.**
  - **Cause:** Dependencies are not installed correctly, or the project hasn't been built.
  - **Solution:**
    1.  Run `npm install` to ensure all dependencies are present.
    2.  Run `npm run build` to compile the project.
    3.  Verify that the build completed successfully with `npm run start`.

- **Error: "Operation not permitted", "Permission denied", or similar.**
  - **Cause:** When sandboxing is enabled, Nessy CLI may attempt operations that are restricted by your sandbox configuration, such as writing outside the project directory or system temp directory.
  - **Solution:** Refer to the [Configuration: Sandboxing](../features/sandbox) documentation for more information, including how to customize your sandbox configuration.

- **Nessy CLI is not running in interactive mode in "CI" environments**
  - **Issue:** Nessy CLI does not enter interactive mode (no prompt appears) if an environment variable starting with `CI_` (e.g. `CI_TOKEN`) is set. This is because the `is-in-ci` package, used by the underlying UI framework, detects these variables and assumes a non-interactive CI environment.
  - **Cause:** The `is-in-ci` package checks for the presence of `CI`, `CONTINUOUS_INTEGRATION`, or any environment variable with a `CI_` prefix. When any of these are found, it signals that the environment is non-interactive, which prevents the CLI from starting in its interactive mode.
  - **Solution:** If the `CI_` prefixed variable is not needed for the CLI to function, you can temporarily unset it for the command. e.g. `env -u CI_TOKEN nessy`

- **DEBUG mode not working from project .env file**
  - **Issue:** Setting `DEBUG=true` in a project's `.env` file doesn't enable debug mode for the CLI.
  - **Cause:** The `DEBUG` and `DEBUG_MODE` variables are automatically excluded from project `.env` files to prevent interference with the CLI behavior.
  - **Solution:** Use a `.nessy/.env` file instead, or configure the `advanced.excludedEnvVars` setting in your `settings.json` to exclude fewer variables.

- **Trackpad scrolling in tmux changes prompt history instead of scrolling the conversation**
  - **Issue:** In a tmux session, trackpad or wheel scrolling may cycle through previous prompts, similar to pressing `Up Arrow` or `Down Arrow`.
  - **Cause:** tmux can translate wheel gestures into plain arrow-key sequences. Those sequences are indistinguishable from real arrow-key presses by the time nessy-cli receives them.
  - **Solution:** Enable `ui.useTerminalBuffer`; then use `Shift+Up` / `Shift+Down`, or the mouse wheel when tmux forwards wheel events to the app. If you prefer host scrollback, adjust your tmux mouse bindings for wheel events.

## IDE Companion not connecting

- Ensure VS Code has a single workspace folder open.
- Restart the integrated terminal after installing the extension so it inherits:
  - `NESSY_CLI_IDE_WORKSPACE_PATH`
  - `NESSY_CLI_IDE_SERVER_PORT`
- If running in a container, verify `host.docker.internal` resolves. Otherwise, map the host appropriately.
- Reinstall the companion with `/ide install` and use “Nessy CLI: Run” in the Command Palette to verify it launches.

## Exit Codes

The Nessy CLI uses specific exit codes to indicate the reason for termination. This is especially useful for scripting and automation.

| Exit Code | Error Type                 | Description                                                                                         |
| --------- | -------------------------- | --------------------------------------------------------------------------------------------------- |
| 41        | `FatalAuthenticationError` | An error occurred during the authentication process.                                                |
| 42        | `FatalInputError`          | Invalid or missing input was provided to the CLI. (non-interactive mode only)                       |
| 44        | `FatalSandboxError`        | An error occurred with the sandboxing environment (e.g. Docker, Podman, or Seatbelt).               |
| 52        | `FatalConfigError`         | A configuration file (`settings.json`) is invalid or contains errors.                               |
| 53        | `FatalTurnLimitedError`    | The maximum number of conversational turns for the session was reached. (non-interactive mode only) |

## Debugging Tips

- **CLI debugging:**
  - Use the `--verbose` flag (if available) with CLI commands for more detailed output.
  - Check the CLI logs, often found in a user-specific configuration or cache directory.

- **Core debugging:**
  - Check the server console output for error messages or stack traces.
  - Increase log verbosity if configurable.
  - Use Node.js debugging tools (e.g. `node --inspect`) if you need to step through server-side code.

- **Tool issues:**
  - If a specific tool is failing, try to isolate the issue by running the simplest possible version of the command or operation the tool performs.
  - For `run_shell_command`, check that the command works directly in your shell first.
  - For _file system tools_, verify that paths are correct and check the permissions.

- **Pre-flight checks:**
  - Always run `npm run preflight` before committing code. This can catch many common issues related to formatting, linting, and type errors.

## Collecting diagnostics

When reporting a Nessy CLI Desktop problem, include a diagnostics report generated on the affected machine. Run the appropriate command below and attach the produced `nessy-*-diagnostics-<timestamp>.txt` file.

**macOS** (downloads and runs the collector directly from S3, no installation needed):

```bash
curl -fsSL https://s3-msk.tinkoff.ru/nestor-companion/diagnostic/collect-macos-diagnostics.sh | bash
# to save the report to a specific path:
curl -fsSL https://s3-msk.tinkoff.ru/nestor-companion/diagnostic/collect-macos-diagnostics.sh | bash -s -- --output /tmp/nessy-diagnostics.txt
```

**Windows** (PowerShell):

```powershell
$f="$env:TEMP\nessy-diagnostics.ps1"; irm "https://s3-msk.tinkoff.ru/nestor-companion/diagnostic/collect-windows-diagnostics.ps1" -OutFile $f; powershell.exe -NoProfile -ExecutionPolicy Bypass -File $f
```

> **Warning:** The report may contain tokens, passwords, private URLs, environment values, user paths, and other secrets. Share it only with trusted Nessy CLI support personnel.

## Updating the default extension without a standalone Nessy CLI

If you run Nessy CLI Desktop but do not have a standalone `nessy` CLI installed in your `PATH`, you can still update the bundled `nessy-default-extension` by running the update through the Bun runtime and `cli.js` that ship inside the Desktop app. The helper script below finds the installation, locates the bundled Bun and CLI, and runs `extensions update nessy-default-extension` synchronously so the final result is shown.

**macOS** (downloads and runs directly from S3, no installation needed):

```bash
curl -fsSL https://s3-msk.tinkoff.ru/nestor-companion/diagnostic/update-default-extension.sh | bash
```

**Windows** (PowerShell):

```powershell
$f="$env:TEMP\update-default-extension.ps1"; irm "https://s3-msk.tinkoff.ru/nestor-companion/diagnostic/update-default-extension.ps1" -OutFile $f; powershell.exe -NoProfile -ExecutionPolicy Bypass -File $f
```

> **Note:** The first run may print a `bufferutil [1/1]` progress line while the extension's dependencies are prepared. This is normal — wait for the script to finish. A final message `Extension "nessy-default-extension" is already up to date.` means the extension is already at the latest version; `... successfully updated: X → Y` means an update was applied.

## Existing GitHub Issues similar to yours or creating new Issues

If you encounter an issue that was not covered here in this _Troubleshooting guide_, consider searching the Nessy CLI [Issue tracker on GitHub](https://github.com/NessyLM/nessy/issues). If you can't find an issue similar to yours, consider creating a new GitHub Issue with a detailed description. Pull requests are also welcome!
