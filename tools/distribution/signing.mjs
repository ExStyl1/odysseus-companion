import { execFileSync } from 'node:child_process';

/** Release builds must fail before staging if signing credentials are unavailable. */
export function releaseMode(args, env) {
  if (['--unsigned', '--signed', '--manual-approval'].filter(flag => args.has(flag)).length > 1)
    throw Error('Choose one signing mode, not both');
  if (args.has('--unsigned') || args.has('--manual-approval')) return false;
  if (!env.CSC_NAME || !env.CSC_NAME.startsWith('Developer ID Application:'))
    throw Error('A release requires CSC_NAME="Developer ID Application: …". Use --unsigned only for a local .app; it does not produce a distributable DMG.');
  if (!(env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER) &&
      !(env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID))
    throw Error('Set Apple notarization credentials for a signed release');
  return true;
}

export function verifySignature(app) {
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { stdio: 'pipe' });
}

export function verifyTrustedApplication(app) {
  verifySignature(app);
  execFileSync('/usr/bin/xcrun', ['stapler', 'validate', app], { stdio: 'pipe' });
  execFileSync('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', app], { stdio: 'pipe' });
}
