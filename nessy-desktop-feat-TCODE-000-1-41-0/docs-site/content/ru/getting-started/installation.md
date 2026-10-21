# Установка

Nessy Desktop — native Electron app. Builds публикуются во внутренний S3 dev feed, и тот же feed обслуживает auto-updates, поэтому после первой установки приложение остаётся актуальным.

## Поддерживаемые платформы

| Платформа | Архитектуры | Доставка |
| --------- | ----------- | -------- |
| **macOS** | Apple Silicon (arm64) и Intel (x64) | Signed DMG в dev feed |
| **Windows** | только x64 | Installer `.exe` в dev feed |
| **Linux** | — | Packaging script есть в repo; published feed в v1 нет |

## macOS

### One-line install

Installer script находит newest build из update feed, скачивает DMG под ваш CPU и заменяет то, что находится в `/Applications`:

```bash
curl -fsSL https://nessy-desktop-releases-dev.s3-msk.tinkoff.ru/dev/mac/install-app.sh | bash
```

Если script ещё не опубликован в feed, запустите копию из repository checkout:

```bash
bash scripts/install-app.sh
```

Должен быть доступен либо `curl`, либо `wget`; всё остальное — stock macOS tooling.

### Что делает script

1. Определяет CPU и выбирает artifact architecture (`arm64` или `x64`).
2. Определяет версию: `NESSY_DESKTOP_INSTALL_VERSION`, если задана, иначе поле `version:` из первого update manifest, который удаётся получить — `dev-mac.yml`, затем `dev-<arch>-mac.yml`, `latest-<arch>-mac.yml` и `latest-mac.yml`.
3. Скачивает `NessyDesktop-<version>-mac-<arch>.dmg` в cache directory (`~/.nessy-agent/downloads` по умолчанию).
4. Монтирует image, просит запущенный Nessy Desktop завершиться, удаляет прежний `/Applications/Nessy Desktop.app` и копирует новый bundle.

::: info
Старый bundle намеренно удаляется, а не перезаписывается. Копирование поверх существующего `.app` сливает два directory tree, оставляет stale files внутри bundle и ломает code-signature seal.
:::

### Options

| Flag / variable | Эффект |
| --------------- | ------ |
| `--print-url` | Напечатать DMG URL, который был бы установлен, и выйти (alias: `--dry-run`) |
| `NESSY_DESKTOP_INSTALL_VERSION` | Закрепить точную версию вместо latest из feed |
| `NESSY_DESKTOP_INSTALL_BASE` | Альтернативный feed base (default `https://nessy-desktop-releases-dev.s3-msk.tinkoff.ru/dev/mac`) |
| `NESSY_DESKTOP_DOWNLOAD_DIR` | Где кешируется DMG (default `~/.nessy-agent/downloads`) |

```bash
# Show the artifact URL without installing
bash scripts/install-app.sh --print-url

# Pin a specific version
NESSY_DESKTOP_INSTALL_VERSION=1.0.1 bash scripts/install-app.sh
```

## Windows

PowerShell installer следует той же схеме для feed `dev/win`:

```powershell
irm https://nessy-desktop-releases-dev.s3-msk.tinkoff.ru/dev/win/install-app.ps1 | iex
```

Он определяет версию из `dev.yml` (fallback на `latest.yml`, затем `latest-x64-win.yml`), скачивает `NessyDesktop-<version>-win-x64.exe` в `%TEMP%\nessy-desktop-install`, останавливает запущенный процесс Nessy Desktop и выполняет installer до конца. Поддерживается только 64-bit Windows.

`NESSY_DESKTOP_INSTALL_VERSION`, `NESSY_DESKTOP_INSTALL_BASE` и `NESSY_DESKTOP_DOWNLOAD_DIR` работают так же, как на macOS. При запуске script из checkout (а не через pipe) `-PrintUrl` печатает installer URL без скачивания.

## Release Feed

| Item | Значение |
| ---- | -------- |
| macOS feed base | `https://nessy-desktop-releases-dev.s3-msk.tinkoff.ru/dev/mac` |
| Windows feed base | `https://nessy-desktop-releases-dev.s3-msk.tinkoff.ru/dev/win` |
| macOS artifact | `NessyDesktop-<version>-mac-<arch>.dmg` |
| Windows artifact | `NessyDesktop-<version>-win-x64.exe` |
| Update metadata | electron-updater manifests (`dev-mac.yml`, `dev.yml`, and `latest*` fallbacks) |

## Auto-Updates

Приложение проверяет тот же S3 feed через electron-updater на channel `dev`. Script installs и in-app updates поэтому следят за одним release stream — ничего дополнительно настраивать не нужно.

## Build From Source

### Prerequisites

- macOS (desktop development and packaging are macOS-first)
- [Bun](https://bun.sh) 1.3.x
- Git access к internal repository

### Develop and build

```bash
bun install

# Run in development with live reload
bun run electron:dev

# Create a production build
bun run electron:build
```

### Package a DMG

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false bash apps/electron/scripts/build-dmg.sh arm64
```

Для local packaging нужны update-feed placeholders, потому что electron-builder их валидирует:

```bash
export NESSY_DESKTOP_UPDATE_URL=https://updates.invalid/dev
export NESSY_DESKTOP_UPDATE_CHANNEL=dev
bun run electron:dist:dev:mac
```

::: warning
Signing и notarization выполняются только в protected release CI. Local builds unsigned, если вы не передадите свои signing identities.
:::

Windows and Linux packaging scripts находятся в `apps/electron/scripts/build-win.ps1` и `apps/electron/scripts/build-linux.sh`; в v1 в dev feed публикуются только macOS и Windows artifacts.

## Runtime Requirements

Всё, что приложению нужно в runtime, поставляется внутри bundle. Исключение одно: первый document-conversion request может скачать Python wheels через bundled `uv`, поэтому направьте его на approved package index, если public package hosts заблокированы в вашей сети.

## First Launch

Откройте приложение из `/Applications` или Spotlight на macOS, либо из Start menu на Windows. Setup wizard в default build предлагает два способа подключить model:

1. **Nessy Gateway** (recommended) — one-click корпоративный sign-in.
   Приложение проходит корпоративный `dp` auth flow, обменивает ваш token на
   gateway JWT и создаёт connection с уже настроенными endpoint и models.
   Заполнять форму не нужно. Если на macOS вкладка браузера не открылась, шаг
   входа показывает кнопку **«Скопировать ссылку для входа»**; откройте ссылку в
   браузере на этом же компьютере.
2. **Custom runtime endpoint** — свой ключ. С 1.26.0 это единственный вход для
   персонального ключа (отдельная карточка «API key» слита в неё): выберите
   runtime — **Pi agent**, **Claude Code** или **Codex** — вставьте ключ и
   получите список моделей с эндпоинта. Адрес подставляется сам.

Default build также несёт две coding-runtime карточки: **Nessy · Codex agent**
(bundled `codex-app-server` harness на моделях gateway; см.
[Codex (Nessy Gateway)](../reference/config/llm-connections#codex-nessy-gateway))
и **Nessy · Claude Code agent** (харнесс Claude Agent SDK, тот же вход в один
клик; см.
[Claude Code (Nessy Gateway)](../reference/config/llm-connections#claude-code-nessy-gateway)).
Карточка **Custom runtime endpoint** описана в
[Custom runtime endpoints](../reference/config/llm-connections#custom-runtime-endpoints).
Сборка может исключить runtime флагом `NESSY_FEATURE_CODEX_RUNTIME=0` /
`NESSY_FEATURE_CLAUDE_RUNTIME=0`.

Subscription-карточки — Claude Pro/Max, ChatGPT Plus (Pi) и ChatGPT (Codex) — и локальные модели
(Ollama) остаются за build-time provider flags и в default build выключены. Они
появляются только в сборках с включённым соответствующим флагом
`NESSY_FEATURE_PROVIDER_*`.

Выбор **Set up later** пропускает model configuration; закончить можно в любое время из Settings. На Windows wizard сначала проверяет, доступен ли Git Bash, и помогает найти его, если он отсутствует.

App data — workspaces, sessions и configuration — живёт под `~/.nessy-agent`. См. [Config File](../reference/config/config-file) для layout.

## Headless Server

`scripts/install-server.sh` намеренно dormant в v1: он отказывается запускаться, пока `NESSY_SERVER_DIST_URL` не указывает на server distribution, а такая сборка пока не публикуется. Чтобы использовать [headless server](../server/headless) сегодня, запускайте его из repository checkout.

## Дальше

- [Введение](introduction) — что такое приложение и как связаны его части.
- [Добавьте источники](../sources/overview) — подключите MCP servers, APIs и локальные папки.
- [LLM connections](../reference/config/llm-connections) — gateway settings и alternative providers.
