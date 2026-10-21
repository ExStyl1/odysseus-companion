/**
 * Applying a rotated Bedrock IAM credential to THIS process's environment
 * (P6.257, denominator C14).
 *
 * The host cannot rewrite a running child's environment — `buildAwsEnv` in
 * `pi-agent.ts` seeds it once at spawn and that block is fixed for the life of
 * the process, which is what the note there used to describe as the end of the
 * story. But the child CAN rewrite its own, and the Pi Bedrock provider reads
 * it per request rather than at construction: in the installed
 * `@earendil-works/pi-ai`, `getConfiguredBedrockCredentials(options.env)` runs
 * inside the streaming call, and `getProviderEnvValue` falls through to
 * `process.env` whenever the scoped `env` carries no such name — ours carries
 * none. So writing these names is what makes a rotation reach a live session;
 * storing the credential in the Pi credential store does not, because the AWS
 * SDK never looks there.
 *
 * Its own module rather than a closure inside the message handler so both
 * halves of the contract below can be asserted without booting the server.
 */

/** The `iam` arm of the protocol credential union, structurally. */
export interface RotatedAwsCredential {
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  sessionToken?: string;
}

/**
 * Replace the AWS credential names in `env` (default: this process's own).
 *
 * `delete` before assigning is the house rule for every env write in this tree:
 * a bare assignment in Bun 1.3.14 can leave the name readable by property and
 * INVISIBLE to `Object.keys`/spread, and every subprocess environment here is
 * built by spreading `process.env` — so a bare assign would reach the AWS SDK
 * in-process and reach nothing we spawn.
 *
 * Two asymmetries are deliberate, and both are the difference between a
 * rotation that works and one that fails in a way nobody can read:
 *
 * - `AWS_SESSION_TOKEN` is cleared even when the new credential has none. A
 *   rotation from temporary to long-lived keys is exactly the case where a
 *   surviving session token would be sent beside a key it does not belong to,
 *   and AWS rejects that pairing — so "absent" has to mean absent.
 * - `AWS_REGION` is left ALONE when the new credential carries none, because
 *   the spawn-time value was resolved from the environment by
 *   `resolveBedrockRegion` (P6.457) and not necessarily from the credential.
 *   Deleting it would silently move the session to the provider's `us-east-1`
 *   default mid-session.
 *
 * `AWS_BEDROCK_FORCE_HTTP1` is absent for the same reason it is absent from the
 * argument: it is a transport default, not a credential, and rotating a
 * credential is no reason to change it.
 */
export function applyRotatedAwsEnv(
  credential: RotatedAwsCredential,
  env: Record<string, string | undefined> = process.env,
): void {
  const replaced: Record<string, string | undefined> = {
    AWS_ACCESS_KEY_ID: credential.accessKeyId,
    AWS_SECRET_ACCESS_KEY: credential.secretAccessKey,
    AWS_SESSION_TOKEN: credential.sessionToken,
    ...(credential.region ? { AWS_REGION: credential.region } : {}),
  };
  for (const [name, value] of Object.entries(replaced)) {
    delete env[name];
    if (value) env[name] = value;
  }
}
