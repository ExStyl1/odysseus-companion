import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCliAppearance, CLI_APPEARANCE, cliColorMode } from '../../tools/cli/appearance.mjs';
test('native settings carry the Odysseus title, block wordmark and bronze semantic palette', () => {
  assert.equal(CLI_APPEARANCE.customBannerTitle, 'ODYSSEUS CLI');
  assert.equal(CLI_APPEARANCE.customAsciiArt.small.split('\n').length, 6);
  assert.ok(CLI_APPEARANCE.customAsciiArt.large.includes('██████'));
  assert.ok(!JSON.stringify(CLI_APPEARANCE.customAsciiArt).includes('||||'));
  assert.ok(
    Math.max(...CLI_APPEARANCE.customAsciiArt.small.split('\n').map((line) => [...line].length)) <=
      47,
  );
  for (const name of ['Odysseus Dark', 'Odysseus Light']) {
    const theme = CLI_APPEARANCE.customThemes[name];
    assert.equal(theme.type, 'custom');
    assert.ok(theme.border.focused);
    assert.match(theme.text.accent, /^#[0-9A-Fa-f]{6}$/);
    assert.equal(theme.ui.gradient.length, 3);
  }
  assert.equal(CLI_APPEARANCE.customThemes['Odysseus Dark'].text.accent, '#D9B779');
});
test('migration installs native UI settings while preserving unrelated model and auth configuration', () => {
  const cli = {
    security: { auth: { selectedType: 'openai' } },
    model: { name: 'real-model-id' },
    ui: { theme: 'Default', customThemes: { Personal: { name: 'Personal' } } },
  };
  applyCliAppearance(cli, { odysseusColorScheme: 'dark' }, { migrate: true });
  assert.equal(cli.ui.theme, 'Odysseus Dark');
  assert.equal(cli.model.name, 'real-model-id');
  assert.equal(cli.security.auth.selectedType, 'openai');
  assert.ok(cli.ui.customThemes.Personal);
  cli.ui.theme = 'Personal';
  applyCliAppearance(cli, {});
  assert.equal(cli.ui.theme, 'Personal');
});
test('legacy colors and light preference migrate to matching Odysseus themes', () => {
  assert.equal(cliColorMode('Nessy Light'), 'light');
  assert.equal(cliColorMode('Odysseus Dark'), 'dark');
  const cli = { ui: { theme: 'Nessy Light' } };
  applyCliAppearance(cli, {});
  assert.equal(cli.ui.theme, 'Odysseus Light');
  applyCliAppearance(cli, { odysseusColorScheme: 'dark' }, { migrate: true });
  assert.equal(cli.ui.theme, 'Odysseus Dark');
});
