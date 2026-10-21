/**
 * Where a Bedrock connection's AWS region actually comes from (P6.457,
 * denominator M26), and how a rotated IAM credential is recognised (P6.257,
 * denominator C14).
 *
 * The setup UI promises *"Uses your existing AWS credential chain"*, and until
 * this module the only writer was the connection's own stored credential: an
 * empty region field left `AWS_REGION` unset in the subprocess while
 * `deriveBedrockRegionPrefix` had already defaulted the model-id prefix to `us`.
 * The documented order was neither implemented nor contradicted — just unowned,
 * and no surface reported the answer.
 *
 * Its own module rather than a private method so the answer has ONE spelling for
 * every reader: the Pi subprocess env, the model-id prefix, and any surface that
 * wants to show it.
 */

/** Which step of the chain answered. `undefined` means no step this process can see did. */
export type BedrockRegionSource = 'connection' | 'AWS_REGION' | 'AWS_DEFAULT_REGION';

export interface ResolvedBedrockRegion {
  region: string;
  source: BedrockRegionSource;
}

/**
 * Resolve the region from AWS's own documented order, restricted to the steps
 * this process can see without side effects.
 *
 * `AWS_DEFAULT_REGION` scored ZERO files repo-wide before this row: the AWS SDK
 * honours it and we did not, so a shell that set only that name looked to us
 * like no region at all.
 *
 * **The two steps below are deliberately absent**, and their absence is the
 * answer rather than a silent gap: the active profile's `~/.aws/config` needs a
 * profile parse, and the EC2/ECS metadata service needs a network call. The
 * row's own done_means says to report the region and its source first and treat
 * implementing the full four-step order as optional. When one of those two is
 * the real answer this returns `undefined` — the caller must say the region is
 * resolved ELSEWHERE, never that it is unset.
 */
export function resolveBedrockRegion(
  credentialRegion: string | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ResolvedBedrockRegion | undefined {
  const fromConnection = credentialRegion?.trim();
  if (fromConnection) return { region: fromConnection, source: 'connection' };
  const fromRegion = env.AWS_REGION?.trim();
  if (fromRegion) return { region: fromRegion, source: 'AWS_REGION' };
  const fromDefault = env.AWS_DEFAULT_REGION?.trim();
  if (fromDefault) return { region: fromDefault, source: 'AWS_DEFAULT_REGION' };
  return undefined;
}

/** One line naming the region and its source, or naming that neither is knowable here. */
export function describeBedrockRegion(resolved: ResolvedBedrockRegion | undefined): string {
  return resolved
    ? `Bedrock region ${resolved.region} (source: ${resolved.source})`
    : 'Bedrock region UNRESOLVED here — the AWS SDK\'s own remaining steps decide it '
      + '(the active profile\'s config, then instance metadata), and the model-id prefix '
      + 'has already been derived without it.';
}

/**
 * F1.979 — the region codex's OWN Bedrock provider will pick for the codex
 * Bedrock card, as the card shows it.
 *
 * OWNER DECISION 2026-09-26: keep the vendor's region selection and SHOW it. Our
 * config writer declares `model_provider = "amazon-bedrock"` and writes no
 * `[model_providers.amazon-bedrock]` table, so codex has no `aws.region` and
 * picks the region itself; the region names the endpoint host
 * (`bedrock-mantle.{region}.api.aws`). Measured with an identical config:
 * `AWS_REGION=eu-west-1` went to eu-west-1 and `us-west-2` to us-west-2.
 *
 * The order is codex's, read at rust-v0.156.1:
 * - `AWS_BEARER_TOKEN_BEDROCK` set (a Bedrock API key): `bearer_token_region` in
 *   `codex-rs/model-provider/src/amazon_bedrock/auth.rs` — `AWS_REGION`, then
 *   `AWS_DEFAULT_REGION`, else codex fails the turn. The profile is NOT read.
 * - any other credential: the AWS SDK's default region chain — `AWS_REGION`,
 *   `AWS_DEFAULT_REGION`, then the active profile (`AWS_PROFILE`, else
 *   `default`) in `AWS_CONFIG_FILE`, else `~/.aws/config`.
 *
 * The env steps reuse {@link resolveBedrockRegion}, so Pi and codex spell them
 * once. The codex child inherits the host's `process.env` as it is at spawn, so
 * the caller passes that. Residue, stated rather than guessed: the credentials
 * file, `sso-session` sections and instance metadata are not read, and a
 * session already running keeps the region it started with. When none of the
 * steps read here answers, the reading is `unresolved`, never a default region.
 *
 * `undefined` for every card that is not the codex Bedrock card. The caller
 * passes `resolveCodexModelProvider(connection)`, so the operator's
 * `NESSY_CODEX_BEDROCK_CARD=0` switch removes the reading too.
 */
export type CodexBedrockRegionReading =
  | { region: string; source: 'AWS_REGION' | 'AWS_DEFAULT_REGION' }
  | { region: string; source: 'aws-profile'; profile: string }
  | { source: 'bearer-token-needs-env' }
  | { source: 'unresolved' };

export function resolveCodexBedrockCardRegion(
  declaredCodexModelProvider: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
  readTextFile: (path: string) => string | undefined,
): CodexBedrockRegionReading | undefined {
  if (declaredCodexModelProvider !== 'amazon-bedrock') return undefined;
  const fromEnv = resolveBedrockRegion(undefined, env);
  if (fromEnv && fromEnv.source !== 'connection') return { region: fromEnv.region, source: fromEnv.source };
  if (env.AWS_BEARER_TOKEN_BEDROCK?.trim()) return { source: 'bearer-token-needs-env' };
  const profile = env.AWS_PROFILE?.trim() || 'default';
  const home = env.HOME?.trim() || env.USERPROFILE?.trim();
  const configFile = env.AWS_CONFIG_FILE?.trim() || (home ? `${home}/.aws/config` : undefined);
  const text = configFile ? readTextFile(configFile) : undefined;
  const region = text === undefined ? undefined : awsConfigProfileRegion(text, profile);
  return region ? { region, source: 'aws-profile', profile } : { source: 'unresolved' };
}

/**
 * The `region` of one profile in an AWS config file: `[default]` (or
 * `[profile default]`) for the default profile, `[profile NAME]` for any other,
 * which is how the config file names them. `#` and `;` start a comment line.
 */
function awsConfigProfileRegion(text: string, profile: string): string | undefined {
  let inProfile = false;
  let region: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[(.*)\]$/.exec(line);
    if (header) {
      const label = header[1]!.trim();
      const named = /^profile\s+(.+)$/.exec(label)?.[1]?.trim();
      inProfile = (named ?? (label === 'default' ? 'default' : undefined)) === profile;
      continue;
    }
    if (!inProfile) continue;
    const pair = /^([^=]+)=(.*)$/.exec(line);
    if (pair && pair[1]!.trim() === 'region' && pair[2]!.trim()) region = pair[2]!.trim();
  }
  return region;
}

/**
 * The locale key and values a surface renders for a {@link CodexBedrockRegionReading}.
 * The sentences live in the locale files; the env names stay untranslated.
 */
export function codexBedrockRegionMessage(
  reading: CodexBedrockRegionReading,
): { key: string; params?: Record<string, string> } {
  switch (reading.source) {
    case 'AWS_REGION':
    case 'AWS_DEFAULT_REGION':
      return { key: 'settings.ai.codexBedrockRegion.env', params: { region: reading.region, source: reading.source } };
    case 'aws-profile':
      return { key: 'settings.ai.codexBedrockRegion.profile', params: { region: reading.region, profile: reading.profile } };
    case 'bearer-token-needs-env':
      return { key: 'settings.ai.codexBedrockRegion.bearerTokenNeedsEnv' };
    case 'unresolved':
      return { key: 'settings.ai.codexBedrockRegion.unresolved' };
  }
}

/**
 * A Bedrock IAM credential as the host holds it, before it becomes subprocess env.
 * Structurally the `iam` arm of `PiAgent.getPiAuth`'s credential union.
 */
export interface BedrockIamCredential {
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  sessionToken?: string;
}

/**
 * A stable, non-secret-revealing marker for "is this the SAME credential we
 * already pushed?" (P6.257).
 *
 * An STS session token expires and nothing in our store records WHEN — there is
 * no `expiresAt` on an IAM credential (`CredentialManager.getLlmIamCredentials`
 * returns four fields and none is a time), so "nearing expiry" is not knowable
 * here. That null is the row's honest residue: instead of inventing a TTL, the
 * host reacts to the subprocess's own auth error and re-reads the store — and
 * this fingerprint is how it distinguishes *"the store has a fresher
 * credential"* from *"the store still holds the one that just failed"*, which
 * need different answers (push, versus tell the user to sign in again).
 *
 * The secret access key is deliberately NOT part of it: the access key id and
 * the session token both change on every STS rotation, so they identify a
 * rotation without the fingerprint carrying the secret anywhere a log might.
 */
export function bedrockIamCredentialFingerprint(credential: BedrockIamCredential): string {
  return `${credential.accessKeyId}\u0000${credential.sessionToken ?? ''}`;
}
