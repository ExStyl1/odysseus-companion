# Nessy CLI

![Nessy](packages/desktop/apps/electron/resources/brands/nessy-cli/icon.svg)

A terminal coding assistant with interactive chat, tools, MCP, ACP and local
session export. This build is based on version 0.19.1 and applies the Nessy
branding profile. Corporate DP integrations are not included.

## Install

Use Node.js 22 or newer. Download the npm archive from the rebrand pipeline:

```sh
npm install --global ./nestor-nessy-cli-0.19.1.tgz
nessy --help
nessy
```

Choose a supported model provider and configure your own credentials. Provider
model IDs and authentication contracts keep their original names.

Online installers, automatic updates, automatic marketplace installation,
GitHub Action setup and Zed downloads are unavailable until a distribution
channel for this build is configured. The pipeline does not publish releases.

## Development

```sh
npm ci
npm run typecheck
```

The install lifecycle builds the CLI, shared web UI and IDE companion, then
creates the CLI bundle. Desktop packaging and signing are separate steps.

[Documentation](https://nestor.pages.devplatform.tcsbank.ru/assistant/docs/nessy-cli/)
· [Repository](https://gitlab.tcsbank.ru/nestor/nessy-cli)
· [Issues](https://gitlab.tcsbank.ru/nestor/nessy-cli/-/issues)

Original source attribution is retained in the source files. See [LICENSE](LICENSE).
