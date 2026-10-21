/**
 * Centralized branding configuration.
 *
 * Supports multiple brand presets (e.g. "nessy-cli", "openwork").
 * Select at runtime via the CRAFT_BRAND environment variable.
 * Default: "nessy-cli" (backward-compatible).
 */

// ---------------------------------------------------------------------------
// Brand config type
// ---------------------------------------------------------------------------

type GitHubUpdateSource = {
  provider: 'github';
  owner: string;
  repo: string;
  releasePageUrl: string;
};

type GenericUpdateSource = {
  provider: 'generic';
  url: string;
  releasePageUrl: string;
};

type UpdateSource = GitHubUpdateSource | GenericUpdateSource;

export interface BrandConfig {
  /** Internal identifier */
  id: string;
  /** User-visible application name */
  appName: string;
  /** macOS/Windows/Linux bundle identifier */
  appId: string;
  /** electron-builder productName */
  productName: string;
  /** Artifact file-name prefix (no spaces) */
  artifactPrefix: string;
  /** Copyright line */
  copyright: string;
  /** Git co-author line inserted into commits */
  coAuthorLine: string;
  /** Name the assistant uses to refer to itself in prompts */
  selfReferName: string;
  /** Session viewer base URL */
  viewerUrl: string;
  /** Stable desktop auto-update source for packaged app builds. */
  updates?: UpdateSource;
  /** Brand-owned external links shown in the Help menu */
  helpMenuLinks: Array<{ labelKey: string; url: string; icon: string }>;
  /** Brand-specific Electron resource paths, relative to apps/electron/ */
  assets: {
    /** Folder containing app icons and other brand-owned assets */
    resourceDir: string;
    /** Renderer logo/symbol asset */
    rendererSymbol: string;
    /** macOS app and DMG icon */
    macIcon: string;
    /** Windows installer/app icon */
    winIcon: string;
    /** Linux AppImage icon */
    linuxIcon: string;
    /** Optional macOS development Dock icon PNG */
    devDockIcon?: string;
    /** Optional SVG source icon for regeneration workflows */
    iconSvg?: string;
    /** Optional macOS 26+ Liquid Glass compiled icon asset */
    liquidGlassAssetsCar?: string;
  };
  /** Multi-line credits text shown in the About panel */
  credits: string;
  /** One-line credits summary */
  creditsShort: string;
  /** Structured credits for custom About dialog */
  creditsEntries: Array<{ name: string; role: string; url: string }>;
}

// ---------------------------------------------------------------------------
// Brand presets
// ---------------------------------------------------------------------------

const NESSY_CLI_BRAND: BrandConfig = {
  id: 'nessy-cli',
  appName: 'Nessy CLI Desktop',
  appId: 'ru.tfinance.nessy-cli.desktop',
  productName: 'Nessy CLI Desktop',
  artifactPrefix: 'Nessy-CLI-Desktop',
  copyright: 'Copyright © 2026 Nessy CLI Team.',
  coAuthorLine: 'Co-Authored-By: Nessy CLI <agents-noreply@craft.do>',
  selfReferName: 'Nessy CLI',
  viewerUrl: 'https://agents.craft.do',
  updates: {
    provider: 'generic',
    url: 'https://s3-msk.tinkoff.ru/nestor-companion/nessy-cli/desktop/latest',
    releasePageUrl: 'https://gitlab.tcsbank.ru/nestor/nessy-cli/-/releases',
  },
  helpMenuLinks: [
    {
      labelKey: 'menu.homepage',
      url: 'https://nestor.pages.devplatform.tcsbank.ru/assistant/docs/nessy-cli',
      icon: 'House',
    },
  ],
  assets: {
    resourceDir: 'resources/brands/nessy-cli',
    rendererSymbol: 'resources/brands/nessy-cli/icon.svg',
    macIcon: 'resources/brands/nessy-cli/icon.icns',
    winIcon: 'resources/brands/nessy-cli/icon.ico',
    linuxIcon: 'resources/brands/nessy-cli/icon.png',
    devDockIcon: 'resources/brands/nessy-cli/dock.png',
    iconSvg: 'resources/brands/nessy-cli/icon.svg',
    liquidGlassAssetsCar: 'resources/brands/nessy-cli/Assets.car',
  },
  credits: '',
  creditsShort: '',
  creditsEntries: [],
};

const BRANDS: Record<string, BrandConfig> = {
  'nessy-cli': NESSY_CLI_BRAND,
  openwork: {
    id: 'openwork',
    appName: 'OpenWork',
    appId: 'com.alibaba.openwork',
    productName: 'OpenWork',
    artifactPrefix: 'OpenWork',
    copyright: 'Copyright © 2026 Nessy CLI Team.',
    coAuthorLine: 'Co-Authored-By: OpenWork <noreply@alibaba.com>',
    selfReferName: 'OpenWork',
    viewerUrl: 'https://agents.craft.do',
    updates: {
      provider: 'github',
      owner: 'modelstudioai',
      repo: 'openwork',
      releasePageUrl: 'https://github.com/modelstudioai/openwork/releases',
    },
    helpMenuLinks: [
      {
        labelKey: 'menu.homepage',
        url: 'https://github.com/modelstudioai/openwork',
        icon: 'House',
      },
    ],
    assets: {
      resourceDir: 'resources/brands/openwork',
      rendererSymbol: 'resources/brands/openwork/symbol.png',
      macIcon: 'resources/brands/openwork/icon.icns',
      winIcon: 'resources/brands/openwork/icon.png',
      linuxIcon: 'resources/brands/openwork/icon.png',
      devDockIcon: 'resources/brands/openwork/dock.png',
      liquidGlassAssetsCar: 'resources/brands/openwork/Assets.car',
    },
    credits: 'Architecture: craft-agents-oss | Agent: Nessy CLI',
    creditsShort: 'Based on craft-agents-oss & Nessy CLI',
    creditsEntries: [
      {
        name: 'Nessy CLI',
        role: 'AI Agent Engine',
        url: 'https://github.com/NessyLM/nessy-cli',
      },
      {
        name: 'Craft Agents OSS',
        role: 'Desktop Architecture',
        url: 'https://github.com/craft-ai-agents/craft-agents-oss',
      },
    ],
  },
};

/** Active brand, selected by CRAFT_BRAND env var (default: "nessy-cli"). */
export const BRAND: BrandConfig =
  BRANDS[process.env.CRAFT_BRAND || 'nessy-cli'] ?? NESSY_CLI_BRAND;

// ---------------------------------------------------------------------------
// App version (renderer-safe — avoids the version barrel which pulls in Node deps)
// ---------------------------------------------------------------------------

import pkg from '../package.json';

/** Application version from package.json (safe for renderer/browser use). */
export const APP_VERSION: string = pkg.version;

// ---------------------------------------------------------------------------
// Legacy exports (unchanged, still used by OAuth callback pages etc.)
// ---------------------------------------------------------------------------

export const CRAFT_LOGO = [
  '  ████████ █████████    ██████   ██████████ ██████████',
  '██████████ ██████████ ██████████ █████████  ██████████',
  '██████     ██████████ ██████████ ████████   ██████████',
  '██████████ ████████   ██████████ ███████      ██████  ',
  '  ████████ ████  ████ ████  ████ █████        ██████  ',
] as const;

/** Logo as a single string for HTML templates */
export const CRAFT_LOGO_HTML = CRAFT_LOGO.map((line) => line.trimEnd()).join(
  '\n',
);

/** Session viewer base URL */
export const VIEWER_URL = BRAND.viewerUrl;
