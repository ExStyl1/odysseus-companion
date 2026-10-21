/**
 * Centralized branding assets for Nessy Desktop
 * Used by OAuth callback pages
 */

export const NESSY_LOGO = [
  '███    ██ ███████ ███████ ███████ ██    ██',
  '████   ██ ██      ██      ██       ██  ██ ',
  '██ ██  ██ █████   ███████ ███████   ████  ',
  '██  ██ ██ ██           ██      ██    ██   ',
  '██   ████ ███████ ███████ ███████    ██   ',
] as const;

/** Logo as a single string for HTML templates */
export const NESSY_LOGO_HTML = NESSY_LOGO.map((line) => line.trimEnd()).join('\n');
