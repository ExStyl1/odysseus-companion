const fs = require("node:fs/promises")
const path = require("node:path")

// apps/electron/scripts -> repository root.
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..")
const SDK_CORE = "@anthropic-ai/claude-agent-sdk"
const SDK_ALIAS = "@anthropic-ai/claude-agent-sdk-binary"

function isTruthy(value) {
  return /^(1|true|yes|on)$/i.test(value ?? "")
}

function isFalsy(value) {
  return /^(0|false|no|off)$/i.test(value ?? "")
}

// The native binary ships by default: NESSY_FEATURE_CLAUDE_RUNTIME defaults ON
// (owner decision 2026-08-06; only subscription cards stay flag-gated), and an
// explicit NESSY_FEATURE_PROVIDER_CLAUDE=1 re-enables it even when the runtime
// flag is off. Mirrors isAnthropicBackendEnabled() in
// packages/shared/src/feature-flags.ts.
function claudeStackEnabled() {
  return (
    isTruthy(process.env.NESSY_FEATURE_PROVIDER_CLAUDE) ||
    !isFalsy(process.env.NESSY_FEATURE_CLAUDE_RUNTIME)
  )
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"))
  } catch {
    return null
  }
}

/**
 * P3.313 (2026-09-03) — assert on the ARTEFACT, not on the dev tree.
 *
 * `apps/electron/node_modules/@anthropic-ai/` is created by build-dmg.sh /
 * build-linux.sh / build-win.ps1 and is declared in no package.json, so
 * `bun install` never refreshes it. Measured on this tree: it held 0.3.223
 * (claudeCodeVersion 2.1.223) three days after the lockfile moved to 0.3.233 —
 * so the tool surface and settings schema the model gets in the packaged app
 * differed from every measurement taken in the dev tree, silently. The core
 * now copies from the repository root (electron-builder.yml), and this hook
 * proves the shipped bytes: electron-builder only WARNS when a `from` path is
 * missing, so a copy that did not happen is otherwise invisible.
 *
 * Runs in `afterPack`, i.e. after extraResources are copied and before signing,
 * on every packaging path — the three build scripts and the `electron:dist*`
 * scripts alike.
 */
async function assertShippedSdkMatchesPin(shippedScopeDir, claudeEnabled) {
  const pinned = await readJson(
    path.join(REPO_ROOT, "node_modules", SDK_CORE, "package.json"),
  )
  if (!pinned) {
    throw new Error(
      `[claude-sdk] ${SDK_CORE} is not installed at the repository root ` +
        `(${REPO_ROOT}/node_modules). Run \`bun install --frozen-lockfile\` from the root.`,
    )
  }

  // The root manifest carries an exact version (no range), so a drift between
  // the manifest and what is installed is worth naming here too.
  const rootManifest = await readJson(path.join(REPO_ROOT, "package.json"))
  const declared = rootManifest?.dependencies?.[SDK_CORE]
  if (/^\d+\.\d+\.\d+$/.test(declared ?? "") && declared !== pinned.version) {
    throw new Error(
      `[claude-sdk] the root package.json pins ${SDK_CORE}@${declared} but ` +
        `node_modules holds ${pinned.version}. Run \`bun install --frozen-lockfile\`.`,
    )
  }

  const shippedCore = await readJson(
    path.join(shippedScopeDir, "claude-agent-sdk", "package.json"),
  )
  if (!shippedCore) {
    throw new Error(
      `[claude-sdk] the packaged app carries no ${SDK_CORE}. electron-builder only ` +
        `warns ("file source doesn't exist") when an extraResources \`from\` path is ` +
        `missing, so check that entry in electron-builder.yml.`,
    )
  }
  if (
    shippedCore.version !== pinned.version ||
    shippedCore.claudeCodeVersion !== pinned.claudeCodeVersion
  ) {
    throw new Error(
      `[claude-sdk] the packaged app would ship ${SDK_CORE}@${shippedCore.version} ` +
        `(claudeCodeVersion ${shippedCore.claudeCodeVersion}) while the lockfile pins ` +
        `${pinned.version} (claudeCodeVersion ${pinned.claudeCodeVersion}). ` +
        `The stale copy is almost certainly apps/electron/node_modules/@anthropic-ai — ` +
        `no manifest governs it, so \`bun install\` cannot refresh it. Remove it and ` +
        `rebuild: \`rm -rf apps/electron/node_modules/@anthropic-ai\`.`,
    )
  }

  if (claudeEnabled) {
    const shippedAlias = await readJson(
      path.join(shippedScopeDir, "claude-agent-sdk-binary", "package.json"),
    )
    if (!shippedAlias) {
      throw new Error(
        `[claude-sdk] the Claude stack is enabled but the packaged app carries no ` +
          `${SDK_ALIAS}. It is staged per target arch by build-dmg.sh / build-linux.sh / ` +
          `build-win.ps1 — the \`electron:dist*\` scripts do not stage it.`,
      )
    }
    if (shippedAlias.version !== pinned.version) {
      throw new Error(
        `[claude-sdk] the packaged app would ship the native binary from ` +
          `${shippedAlias.name}@${shippedAlias.version} while the lockfile pins ` +
          `${pinned.version}. Re-stage it: \`rm -rf apps/electron/node_modules/@anthropic-ai\` ` +
          `then run the platform build script.`,
      )
    }
    console.log(
      `  claude-agent-sdk ${shippedCore.version} (claudeCodeVersion ` +
        `${shippedCore.claudeCodeVersion}), native binary ${shippedAlias.name}@` +
        `${shippedAlias.version} — matches the lockfile pin.`,
    )
    return
  }

  console.log(
    `  claude-agent-sdk ${shippedCore.version} (claudeCodeVersion ` +
      `${shippedCore.claudeCodeVersion}) — matches the lockfile pin; native binary ` +
      `not bundled (Claude stack disabled).`,
  )
}

module.exports = async function ensureClaudeSdkBinaryDir(context) {
  const resourcesDir =
    context.electronPlatformName === "darwin"
      ? path.join(
          context.appOutDir,
          `${context.packager.appInfo.productFilename}.app`,
          "Contents",
          "Resources",
        )
      : path.join(context.appOutDir, "resources")

  const shippedScopeDir = path.join(
    resourcesDir,
    "app",
    "node_modules",
    "@anthropic-ai",
  )

  const claudeEnabled = claudeStackEnabled()

  // The runtime resolver expects the alias directory to exist even when the
  // native binary is not bundled.
  if (!claudeEnabled) {
    await fs.mkdir(path.join(shippedScopeDir, "claude-agent-sdk-binary"), {
      recursive: true,
    })
  }

  await assertShippedSdkMatchesPin(shippedScopeDir, claudeEnabled)
}
