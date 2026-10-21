/** Use the native CLI banner/theme settings so application updates keep working. */
import { readFileSync } from 'node:fs';
export const CLI_APPEARANCE = JSON.parse(
  readFileSync(new URL('../../integrations/cli/settings.json', import.meta.url), 'utf8'),
).ui;
export const cliColorMode = (theme) =>
  ['Nessy Dark', 'Odysseus Dark'].includes(theme)
    ? 'dark'
    : ['Nessy Light', 'Odysseus Light'].includes(theme)
      ? 'light'
      : undefined;
export function applyCliAppearance(cli, prefs, { migrate = false, changeTheme = true } = {}) {
  const ui = cli.ui || {},
    previous = ui.theme;
  cli.ui = {
    ...ui,
    customBannerTitle: CLI_APPEARANCE.customBannerTitle,
    customBannerSubtitle: CLI_APPEARANCE.customBannerSubtitle,
    customAsciiArt: CLI_APPEARANCE.customAsciiArt,
    customThemes: {
      ...ui.customThemes,
      ...structuredClone(CLI_APPEARANCE.customThemes),
    },
  };
  if (changeTheme && (migrate || !previous || ['Nessy Dark', 'Nessy Light'].includes(previous))) {
    const mode =
      prefs.odysseusColorScheme === 'light'
        ? 'light'
        : prefs.odysseusColorScheme === 'dark'
          ? 'dark'
          : cliColorMode(previous) || 'dark';
    cli.ui.theme = mode === 'light' ? 'Odysseus Light' : 'Odysseus Dark';
  }
  return cli.ui.theme !== previous;
}

/** A GUI launcher can inherit Codex/CI's NO_COLOR; interactive Odysseus uses its chosen theme. */
export function cliColorEnvironment(env, isTTY) {
  if (env.ODYSSEUS_NO_COLOR === '1') {
    const plain = { ...env, NO_COLOR: '1' };
    delete plain.FORCE_COLOR;
    return plain;
  }
  if (!isTTY) return { ...env };
  const colored = { ...env };
  delete colored.NO_COLOR;
  // Apple's Terminal reliably supports the 256-color palette used for the bronze theme.
  colored.FORCE_COLOR = env.TERM_PROGRAM === 'Apple_Terminal' ? '2' : '3';
  return colored;
}
