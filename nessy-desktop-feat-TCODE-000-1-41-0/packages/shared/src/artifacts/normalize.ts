/**
 * UA1.16 — the normaliser: one file's text → exactly the bytes and fields the
 * t-artifacts client sends, plus the counts the host card shows.
 *
 * Why the host does this rather than the service (research 2026-09-23, service
 * source at `14e402e`):
 *
 * - the service WRAPS HTML at write time (`internal/htmlwrap/htmlwrap.go:48-81`),
 *   so a full document arrives nested inside a second `<html>`; we send the body
 *   plus the head's `<style>`/`<link>`/`<script>` instead, so the stored page is
 *   wrapped exactly once;
 * - it writes `title` and `emoji` RAW into `<title>` and the favicon SVG, so the
 *   host escapes the title and restricts the emoji to 1–2 emoji code points;
 * - `ExtractTitle` lifts the first bare `<title>` anywhere in the content
 *   (`:23-37`), so the lifted `<title>` is REMOVED from what we send and the
 *   host-escaped field is the one the service writes;
 * - one page is capped at 16 MiB (`artifact.go:38`), checked here on the
 *   normalised UTF-8 bytes so the refusal is local and named.
 *
 * v1 content policy (plan UA1.16): `<form>` and `<input type=password>` are
 * refused — a page on the company network that asks for a password is the
 * phishing shape (UA12.65: a MARKDOWN page's fenced code examples exempt — a
 * fence renders escaped on the published page, so its form is display text);
 * inline scripts and event-handler attributes are COUNTED and
 * every external `src`/`href`/`url()` host COLLECTED, for the card (UA1.18). The
 * scan is regex-based, not a parser: a construct split across a comment or a
 * script string can be miscounted — the counts inform the card, they are not a
 * sanitiser, and the card shows the bytes themselves.
 *
 * Description: the service's handling of `description` was not read (UNVERIFIED);
 * it is escaped like the title, so the worst case is a visible `&amp;`, never an
 * injection.
 */
import { extname, basename } from 'node:path';
import { Lexer } from 'marked';
import {
  ArtifactClientError,
  MAX_ARTIFACT_CONTENT_BYTES,
  type ArtifactContentType,
} from './t-artifacts-client.ts';

/** The emoji used when the caller names none — the service CLI's own list fallback (U+1F4C4). */
export const DEFAULT_ARTIFACT_EMOJI = '\u{1F4C4}';

export interface NormalizeArtifactInput {
  /** The file's name or path — only its extension and basename are read. */
  fileName: string;
  /** The file's text, decoded once by the guard (`publish-guard.ts`). */
  text: string;
  title?: string;
  emoji?: string;
  description?: string;
}

export interface ArtifactContentPolicyReport {
  /** `<script>` elements without `src`. */
  inlineScripts: number;
  /** `on…=` attributes inside tags. */
  eventHandlerAttributes: number;
  /** Hostnames of every absolute or protocol-relative `src`/`href`/`url()`, sorted and unique. */
  externalHosts: string[];
}

export interface NormalizedArtifact {
  contentType: ArtifactContentType;
  content: string;
  /** HTML-escaped, ready for the wire. */
  title: string;
  emoji: string;
  /** HTML-escaped, when given. */
  description?: string;
  /** UTF-8 bytes of `content`. */
  byteLength: number;
  /** True when a full HTML document was reduced to its body (+ head assets). */
  liftedFromDocument: boolean;
  policy: ArtifactContentPolicyReport;
}

/** `.html`/`.htm` → html, `.md` → markdown, anything else `null`. Case-insensitive. */
export function artifactContentTypeOf(fileName: string): ArtifactContentType | null {
  const extension = extname(fileName).toLowerCase();
  if (extension === '.html' || extension === '.htm') return 'html';
  if (extension === '.md') return 'markdown';
  return null;
}

/** The five characters that matter in text and attribute context. */
export function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** The handful of entities a lifted `<title>` commonly carries, decoded so the escape above is not doubled. */
function decodeBasicEntities(value: string): string {
  return value
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&');
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * 1–2 code points, each an emoji: an Extended_Pictographic or Regional_Indicator
 * code point, or a VS16 / skin-tone modifier riding on one (so `❤️` and a flag
 * pass); at least one must be pictographic or a regional indicator. `<`, quotes
 * and every ASCII character fail by construction.
 */
export function isValidArtifactEmoji(value: string): boolean {
  const codePoints = [...value];
  if (codePoints.length < 1 || codePoints.length > 2) return false;
  let sawEmoji = false;
  for (const codePoint of codePoints) {
    if (/^[\p{Extended_Pictographic}\p{Regional_Indicator}]$/u.test(codePoint)) {
      if (codePoint.codePointAt(0)! < 0x80) return false;
      sawEmoji = true;
    } else if (!/^[\u{FE0F}\p{Emoji_Modifier}]$/u.test(codePoint)) {
      return false;
    }
  }
  return sawEmoji;
}

const FULL_DOCUMENT = /<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>]/i;
const HEAD_BLOCK = /<head\b[^>]*>([\s\S]*?)<\/head\s*>/i;
const BODY_BLOCK = /<body\b[^>]*>([\s\S]*?)(?:<\/body\s*>|$)/i;
const TITLE_ELEMENT = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i;
/** Head assets lifted in document order: `<style>…</style>`, `<script …>…</script>`, `<link …>`. */
const HEAD_ASSET = /<style\b[^>]*>[\s\S]*?<\/style\s*>|<script\b[^>]*>[\s\S]*?<\/script\s*>|<link\b[^>]*>/gi;

/**
 * A full document → its body content, preceded by the head's style, script and
 * link elements; the first `<title>` is lifted out and returned separately.
 * Doctype, `<html>`, `<head>` and `<body>` themselves never reach the wire.
 */
function liftDocument(text: string): { content: string; liftedTitle?: string } {
  const head = HEAD_BLOCK.exec(text);
  const headInner = head?.[1] ?? '';
  const bodyMatch = BODY_BLOCK.exec(text);
  const headTitle = TITLE_ELEMENT.exec(headInner);
  // Outside a <head>, the title counts only BEFORE the body (an SVG <title> in
  // the body is content); with no <body> at all, the first one anywhere.
  const titleMatch = headTitle ?? TITLE_ELEMENT.exec(bodyMatch ? text.slice(0, bodyMatch.index) : text);
  // With a <body>, every style/script/link before it is lifted (inside <head> or
  // not); without one, the head's — the rest of the text becomes the body.
  const assets = (bodyMatch ? text.slice(0, bodyMatch.index) : headInner).match(HEAD_ASSET) ?? [];
  let body: string;
  if (bodyMatch) {
    body = bodyMatch[1] ?? '';
  } else {
    // No <body>: everything after the head (or the whole text), minus the frame tags.
    body = head ? text.slice(head.index + head[0].length) : text;
    body = body.replace(/<!doctype[^>]*>/gi, '').replace(/<\/?html\b[^>]*>/gi, '').replace(/<\/?head\b[^>]*>/gi, '');
    if (!headTitle && titleMatch) body = body.replace(titleMatch[0], '');
  }
  const content = [...assets, body.trim()].filter(part => part.length > 0).join('\n');
  return { content, ...(titleMatch ? { liftedTitle: titleMatch[1] } : {}) };
}

const PASSWORD_INPUT = /<input\b[^>]*\btype\s*=\s*["']?password\b/i;
const FORM_ELEMENT = /<form[\s>/]/i;
const SCRIPT_OPEN = /<script\b([^>]*)>/gi;
const TAG = /<[A-Za-z][^>]*>/g;
const EVENT_HANDLER = /\son[a-z]+\s*=/gi;
const URL_ATTRIBUTE = /\s(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi;

function hostOf(reference: string): string | null {
  const trimmed = reference.trim();
  if (!/^(?:https?:)?\/\//i.test(trimmed)) return null;
  try {
    return new URL(trimmed.startsWith('//') ? `https:${trimmed}` : trimmed).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * UA12.65 (origin UA-x / UA1.25), made fail-closed by UA12.176 — a MARKDOWN page's top-level fenced code blocks (```
 * or ~~~ fences) render ESCAPED on the published page (`<pre><code>`), so a `<form>` or a password-input EXAMPLE shown
 * there is display text, never the phishing shape the v1 policy refuses. The refusal scan reads the markdown with
 * those spans removed; an HTML page has no fences and is scanned whole. WHICH spans are fenced code is decided by a
 * CommonMark lexer (`marked`'s, a root dependency), never by a line regex: UA12.65's regex took any ``` line as a
 * fence edge, so a fence line inside an HTML block (`<div>`, `<pre>`), an opener whose info string holds a backtick
 * (not a fence at all), a fence inside a list item or blockquote, or a would-be closer carrying an info string hid a
 * form that every renderer emits LIVE. Only a TOP-LEVEL `code` token whose raw text opens with a fence is exempted;
 * every other token (paragraphs, HTML blocks, lists, blockquotes, indented code) is scanned whole, so a fence inside a
 * container is never exempted (stated residue: such an example is refused). A fence opened and never closed is code
 * to the end of the page in CommonMark, and is exempted as such. Line endings are read as `\n` (CRLF/CR folded) for the lexer; if
 * the tokens' raw text does not rebuild the page exactly, or the lexer throws, nothing is exempted (fail closed).
 * Measured lexer disagreement (UA12.176 follow-up, 2026-10-08): marked closes a fence only on a closer followed by
 * SPACES, while CommonMark (markdown-it, micromark) also allows tabs, so a "```\t" line ends the block there and what
 * follows renders live while marked keeps it inside the code token. {@link fenceClosesEarly} re-checks every line of
 * an exempted token after its opener against the CommonMark closer rule (same char, at least as long, then only spaces
 * or tabs); a match before the token's last line exempts nothing (fail closed). Conversely marked's closer also takes
 * trailing fence characters ("```~", "~~~`"), which CommonMark does not, so a fence-like last line that is not a
 * CommonMark closer exempts nothing either (UA12.176 follow-up 3; stated residue: an unclosed fence whose final line
 * at the end of the page is such a line is refused if it holds a form example).
 * Further measured disagreements (UA12.176 follow-up 2, 2026-10-08): marked does NOT agree with markdown-it on where a
 * fence begins. It misses HTML blocks that CommonMark opens — a `</pre>`/`</script>`/`</style>`/`</textarea>` line
 * (marked refuses those names as type-7 tags) and a `<?`, `<!X` or `<![CDATA[` line interrupting a paragraph — and it
 * ends a list item where CommonMark keeps it open by lazy continuation, so a "fence" after such lines is raw HTML or
 * list content in markdown-it and micromark (the form renders live) yet a top-level `code` token in marked. Rather than
 * enumerate the lexers' differences, {@link fenceContextUnsure} exempts nothing (fail closed) when, before the last
 * fenced token, a line that could start an HTML block sits anywhere but in a blank-line-ended `<details>`/`<summary>`
 * block, or a list or quote ends with no blank line after it. Stated residue: a fenced form example after any other
 * HTML-looking line, or after a lazily ended list or quote, is refused; a fence after a blank-line-separated list or a
 * `<details>` block (the chat transcript's `- Time:` lines and collapsed tool blocks) stays exempt. Checked 2026-10-08
 * by a random-line fuzz of ≥100k pages against markdown-it 14.2.0 (`html: true`) and micromark 4.0.2
 * (`allowDangerousHtml`): no accepted page renders a live form in either.
 * Inline code spans are NOT exempted; the card's counts still read the fenced examples (they inform the person, they
 * refuse nothing).
 */
function withoutFencedCode(content: string): string {
  const source = content.replace(/\r\n?/g, '\n');
  let tokens: Array<{ type: string; raw: string }>;
  try {
    tokens = new Lexer().lex(source) as Array<{ type: string; raw: string }>;
  } catch {
    return source;
  }
  if (tokens.map(token => token.raw).join('') !== source) return source;
  const fenced = tokens.filter(token => token.type === 'code' && /^ {0,3}(?:`{3,}|~{3,})/.test(token.raw));
  if (fenced.some(fenceClosesEarly) || fenceContextUnsure(source, tokens, fenced)) return source;
  return tokens
    .filter(token => !fenced.includes(token))
    .map(token => token.raw)
    .join('');
}

/** A line that could open a CommonMark HTML block: past indentation and container markers, `<` then `?`, `!`, `/`, a letter. */
export const HTML_BLOCK_START_CANDIDATE = /^[ \t>*+\-\d.)]*<[?!/A-Za-z]/m;

/**
 * An `html` token both lexers read alike: a type-6 `<details>`/`<summary>` block (the chat transcript's collapsed tool
 * blocks) with no blank line inside, ending at a blank line — CommonMark and marked both end that block there.
 */
const AGREED_HTML_BLOCK = /^ {0,3}<\/?(?:details|summary)(?=[ \t/>]|$)[^\n]*(?:\n[ \t]*\S[^\n]*)*\n[ \t]*\n[ \t\n]*$/i;

/**
 * True when marked's reading of what precedes the last fenced token may differ from CommonMark's (UA12.176 follow-up
 * 2): a fenced token that does not start a line; an HTML-block-start candidate line anywhere outside an
 * {@link AGREED_HTML_BLOCK} (marked misses some HTML blocks CommonMark opens, and ends others at a different line); or a
 * `list`/`blockquote` token not followed by a blank line (CommonMark may continue it lazily past where marked ended it).
 * Deliberately wider than either lexer's rule — it marks where they may disagree, not what is HTML. Exported with
 * {@link fenceClosesEarly} and {@link HTML_BLOCK_START_CANDIDATE}; share-snapshot.ts no longer uses them (UA12.30
 * DECIDED 2026-10-09: its thinking body escapes details tags everywhere, code included), so this file is their user.
 */
export function fenceContextUnsure<T extends { type: string; raw: string }>(source: string, tokens: T[], fenced: T[]): boolean {
  const isFenced = new Set(fenced);
  const last = fenced.length === 0 ? -1 : tokens.lastIndexOf(fenced[fenced.length - 1]!);
  const blankLine = /[ \t]*(?:\n|$)/y;
  let offset = 0;
  for (const [index, token] of tokens.entries()) {
    if (index > last) break;
    const start = offset;
    offset += token.raw.length;
    if (isFenced.has(token)) {
      if (start > 0 && source[start - 1] !== '\n') return true;
      continue;
    }
    if (token.type === 'space' || (token.type === 'html' && AGREED_HTML_BLOCK.test(token.raw))) continue;
    if (HTML_BLOCK_START_CANDIDATE.test(token.raw)) return true;
    if (token.type !== 'list' && token.type !== 'blockquote') continue;
    if (/\n[ \t]*\n$/.test(token.raw)) continue;
    // The line after the container (past the rest of its own last line when its raw text stops before the newline).
    const lineEnd = token.raw.endsWith('\n') ? offset - 1 : source.indexOf('\n', offset);
    blankLine.lastIndex = lineEnd === -1 ? source.length : lineEnd + 1;
    if (!blankLine.test(source)) return true;
  }
  return false;
}

/**
 * True when marked's fenced `code` token may end elsewhere than CommonMark's block: a line after its opener and before
 * its own last line is a CommonMark closer (marked missed it), or its last line starts with a fence run of the opener's
 * character yet is not a CommonMark closer (marked's `\1[~`]*` closer also takes "```~" or "~~~`", which CommonMark
 * keeps inside the block — UA12.176 follow-up 3). A last line that is not fence-like is a fence left open to the end.
 */
export function fenceClosesEarly(token: { raw: string }): boolean {
  const fence = /^ {0,3}(`{3,}|~{3,})/.exec(token.raw)?.[1];
  if (!fence) return true;
  const char = fence[0] === '`' ? '`' : '~';
  const closer = new RegExp(`^ {0,3}${char}{${fence.length},}[ \\t]*$`);
  const lines = token.raw.replace(/(?:\n[ \t]*)+$/, '').split('\n');
  const last = lines.length > 1 ? lines[lines.length - 1]! : '';
  if (new RegExp(`^ {0,3}${char}{3,}`).test(last) && !closer.test(last)) return true;
  return lines.slice(1, -1).some(line => closer.test(line));
}

/**
 * The v1 content policy over the normalised content: refusals first, then the card's counts. `contentType` is the
 * normalised page's — for markdown the refusals read the page without its fenced code ({@link withoutFencedCode},
 * UA12.65); absent or `html`, the whole content is scanned as before.
 */
export function scanArtifactContentPolicy(content: string, contentType?: ArtifactContentType): ArtifactContentPolicyReport {
  const refusalSource = contentType === 'markdown' ? withoutFencedCode(content) : content;
  if (PASSWORD_INPUT.test(refusalSource)) {
    throw new ArtifactClientError('invalid', 'The page contains a password field (<input type=password>), which is not published. Remove it and publish again.');
  }
  if (FORM_ELEMENT.test(refusalSource)) {
    throw new ArtifactClientError('invalid', 'The page contains a <form>, which is not published. Remove the form and publish again.');
  }
  let inlineScripts = 0;
  for (const match of content.matchAll(SCRIPT_OPEN)) {
    if (!/\bsrc\s*=/i.test(match[1] ?? '')) inlineScripts += 1;
  }
  let eventHandlerAttributes = 0;
  const hosts = new Set<string>();
  for (const tag of content.match(TAG) ?? []) {
    eventHandlerAttributes += (tag.match(EVENT_HANDLER) ?? []).length;
    for (const attribute of tag.matchAll(URL_ATTRIBUTE)) {
      const host = hostOf(attribute[1] ?? attribute[2] ?? attribute[3] ?? '');
      if (host) hosts.add(host);
    }
  }
  for (const reference of content.matchAll(CSS_URL)) {
    const host = hostOf(reference[1] ?? reference[2] ?? reference[3] ?? '');
    if (host) hosts.add(host);
  }
  return { inlineScripts, eventHandlerAttributes, externalHosts: [...hosts].sort() };
}

function fallbackTitle(fileName: string, contentType: ArtifactContentType, text: string): string {
  if (contentType === 'markdown') {
    const heading = /^#\s+(.+)$/m.exec(text);
    if (heading?.[1]) return heading[1];
  }
  return basename(fileName, extname(fileName));
}

/**
 * Normalise once. Throws {@link ArtifactClientError} `invalid` (type, emoji,
 * content policy) or `too-large` — every refusal a sentence the model can act on.
 */
export function normalizeArtifact(input: NormalizeArtifactInput): NormalizedArtifact {
  const contentType = artifactContentTypeOf(input.fileName);
  if (!contentType) {
    throw new ArtifactClientError('invalid', `Only .html, .htm and .md files can be published; ${basename(input.fileName)} is not one. Write the page as HTML or Markdown and publish that file.`);
  }
  let content = input.text;
  let liftedTitle: string | undefined;
  let liftedFromDocument = false;
  if (contentType === 'html' && FULL_DOCUMENT.test(content)) {
    const lifted = liftDocument(content);
    content = lifted.content;
    liftedTitle = lifted.liftedTitle;
    liftedFromDocument = true;
  }
  const byteLength = Buffer.byteLength(content, 'utf8');
  if (byteLength > MAX_ARTIFACT_CONTENT_BYTES) {
    throw new ArtifactClientError('too-large', `The page is ${byteLength} bytes after normalisation; the service accepts at most 16 MiB (${MAX_ARTIFACT_CONTENT_BYTES} bytes). Make it smaller and publish again.`);
  }
  const policy = scanArtifactContentPolicy(content, contentType);

  const rawTitle = input.title?.trim()
    ? input.title
    : liftedTitle !== undefined && collapseWhitespace(decodeBasicEntities(liftedTitle)) !== ''
      ? decodeBasicEntities(liftedTitle)
      : fallbackTitle(input.fileName, contentType, input.text);
  const title = escapeHtmlText(collapseWhitespace(rawTitle));
  if (title === '') {
    throw new ArtifactClientError('invalid', 'The page needs a title. Pass a title and publish again.');
  }

  const emoji = input.emoji === undefined || input.emoji === '' ? DEFAULT_ARTIFACT_EMOJI : input.emoji;
  if (!isValidArtifactEmoji(emoji)) {
    throw new ArtifactClientError('invalid', 'The emoji must be one or two emoji characters (for example 📊). Pass a different emoji, or none.');
  }

  const description = input.description !== undefined && collapseWhitespace(input.description) !== ''
    ? escapeHtmlText(collapseWhitespace(input.description))
    : undefined;

  return {
    contentType,
    content,
    title,
    emoji,
    ...(description !== undefined ? { description } : {}),
    byteLength,
    liftedFromDocument,
    policy,
  };
}
