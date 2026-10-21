/**
 * D1.118 — an upstream refusal that prescribes ANOTHER product's remedy, and the
 * sentence this product puts beside it.
 *
 * The Nessy Gateway answers a retired model id with
 * `404 Модель <id> больше не поддерживается, выполните /auth и выберете
 * доступную модель /model` (measured 2026-09-11, P6.1080). `/auth` and `/model`
 * are **nessy-cli** commands. Nessy Desktop has neither, so a user who follows
 * the instruction they are given cannot: they type a slash command that does not
 * exist, and the error surface showed the sentence verbatim with nothing beside
 * it.
 *
 * ## What is detected, and why it is the REMEDY rather than the refusal
 *
 * The obvious detector is the refusal's own Russian sentence. It is the wrong
 * one: it pins a body a gateway release can re-word, and it says nothing about
 * the half that actually harms the user. What harms the user is being told to
 * run a command this product does not have — so that is what
 * {@link namesForeignCliRemedies} looks for, and it is language-independent by
 * construction. A refusal re-worded into English still names `/auth` and
 * `/model`; a refusal that stops naming them stops needing our sentence.
 *
 * Both tokens are required. `/model` alone appears in ordinary prose (a URL
 * path, a JSON pointer, a file name), and one token is not an instruction.
 *
 * ## The residue, stated rather than discovered later
 *
 * {@link FOREIGN_CLI_REMEDY_DETAIL} is ENGLISH PROSE, which is what every other
 * host-written sentence at this seam already is (`SessionManager`'s
 * `Request Error: …` and its image-too-large details are the neighbours). The
 * honest bilingual answer is the one D1.150 records for `CONNECTION_IN_USE`: the
 * renderer must key on a CODE and localise, not read a string the host built. So
 * {@link FOREIGN_CLI_REMEDY_ERROR_CODE} goes on the wire TODAY, on the arm that
 * carries no code of its own, and the sentence is the fallback the renderer
 * shows until it does. The renderer line and its two locale values are a
 * hand-off, not a missing piece of this module.
 */

/**
 * The `Message.errorCode` this host sets when an upstream refusal prescribes a
 * command this product does not have.
 *
 * Set ONLY where the producing runtime supplied no code of its own — a typed
 * error's code is the runtime's answer to "what kind of failure is this", and
 * overwriting it would break the auth-retry test that reads it.
 */
export const FOREIGN_CLI_REMEDY_ERROR_CODE = 'foreign_cli_remedy';

/**
 * The sentence placed beside the upstream one. It names both surfaces this
 * product DOES have, because "that command does not exist here" without a
 * replacement leaves the user exactly as stuck.
 */
export const FOREIGN_CLI_REMEDY_DETAIL =
  'The endpoint names `/auth` and `/model`. Those are Nessy CLI commands and this app has neither:'
  + ' sign in from the connection card in Settings, and choose a model in the model picker.';

/**
 * One slash command, matched as a TOKEN.
 *
 * `[^\w/]` before it so `/api/v1/model` and `…/auth` inside a URL path do not
 * match, and a boundary after it so `/models` (the catalogue endpoint this repo
 * names in a dozen comments) is not read as `/model`.
 */
function namesSlashCommand(text: string, command: string): boolean {
  return new RegExp(`(^|[^\\w/])/${command}(?![\\w/-])`).test(text);
}

/**
 * True when `text` tells the reader to run BOTH of nessy-cli's `/auth` and
 * `/model`.
 *
 * Pure and synchronous: it runs on the error path of a turn that has already
 * failed, so it may not read a file, a setting or the environment.
 */
export function namesForeignCliRemedies(text: string | undefined | null): boolean {
  if (typeof text !== 'string' || text.length === 0) return false;
  return namesSlashCommand(text, 'auth') && namesSlashCommand(text, 'model');
}

/**
 * The detail list an error message should carry, with our sentence appended
 * ONCE.
 *
 * Returns the input unchanged when nothing is owed, so a caller can apply it
 * unconditionally and a message that already carries the sentence (a retry, a
 * replayed transcript) does not accumulate copies.
 */
export function withForeignCliRemedyDetail(
  details: readonly string[] | undefined,
  upstreamText: string | undefined | null,
): string[] | undefined {
  if (!namesForeignCliRemedies(upstreamText)) return details as string[] | undefined;
  const existing = details ?? [];
  if (existing.includes(FOREIGN_CLI_REMEDY_DETAIL)) return existing as string[];
  return [...existing, FOREIGN_CLI_REMEDY_DETAIL];
}
