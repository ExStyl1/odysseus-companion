/** UA1.16 — the normaliser: one wrap, escaped fields, the v1 content policy, the 16 MiB cap. */
import { describe, expect, test } from 'bun:test';
import { ArtifactClientError, MAX_ARTIFACT_CONTENT_BYTES } from './t-artifacts-client.ts';
import {
  DEFAULT_ARTIFACT_EMOJI,
  artifactContentTypeOf,
  isValidArtifactEmoji,
  normalizeArtifact,
} from './normalize.ts';

function refusal(run: () => unknown): ArtifactClientError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ArtifactClientError);
    return error as ArtifactClientError;
  }
  throw new Error('expected a refusal');
}

const FULL_DOCUMENT = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Quarterly &amp; report</title>
  <style>body { color: red; }</style>
  <link rel="stylesheet" href="https://cdn.example.com/a.css">
  <script src="https://cdn.example.com/chart.js"></script>
</head>
<body>
  <h1>Hello</h1>
  <svg><title>an svg title stays</title></svg>
  <script>console.log(1)</script>
</body>
</html>`;

describe('UA1.16 normalise — positive arms', () => {
  test('a full document is normalised ONCE: one body, head assets lifted, no frame tags, no <title>', () => {
    const result = normalizeArtifact({ fileName: 'report.html', text: FULL_DOCUMENT });
    expect(result.contentType).toBe('html');
    expect(result.liftedFromDocument).toBe(true);
    expect(result.content).not.toMatch(/<html|<head|<body|<!doctype|<meta/i);
    expect(result.content).not.toContain('Quarterly');
    expect(result.content).toContain('<style>body { color: red; }</style>');
    expect(result.content).toContain('<link rel="stylesheet" href="https://cdn.example.com/a.css">');
    expect(result.content).toContain('<h1>Hello</h1>');
    expect(result.content).toContain('<svg><title>an svg title stays</title></svg>');
    expect(result.title).toBe('Quarterly &amp; report');
    // Idempotent: normalising the normalised content changes nothing — wrapped once.
    const again = normalizeArtifact({ fileName: 'report.html', text: result.content, title: 'x' });
    expect(again.content).toBe(result.content);
    expect(again.liftedFromDocument).toBe(false);
  });

  test('a title containing </title><script> is stored ESCAPED', () => {
    const result = normalizeArtifact({ fileName: 'p.html', text: '<p>x</p>', title: 'Evil</title><script>alert(1)</script>' });
    expect(result.title).toBe('Evil&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(result.title).not.toContain('<');
  });

  test('a lifted title carrying a raw script is escaped too (boundary)', () => {
    const result = normalizeArtifact({ fileName: 'p.html', text: '<html><head><title>a"b\'c<d</title></head><body>x</body></html>' });
    expect(result.title).toBe('a&quot;b&#39;c&lt;d');
  });

  test('markdown passes through unchanged; its title falls back to the first heading, then the basename', () => {
    const md = '# Weekly notes\n\nSome **text** with <b>html</b>.';
    const result = normalizeArtifact({ fileName: 'notes.MD', text: md });
    expect(result.contentType).toBe('markdown');
    expect(result.content).toBe(md);
    expect(result.title).toBe('Weekly notes');
    expect(normalizeArtifact({ fileName: '/x/plan-v2.md', text: 'no heading' }).title).toBe('plan-v2');
  });

  test('emoji: default when absent; 1–2 emoji code points accepted', () => {
    expect(normalizeArtifact({ fileName: 'a.md', text: 'x' }).emoji).toBe(DEFAULT_ARTIFACT_EMOJI);
    for (const emoji of ['📊', '❤️', '🇷🇺', '👍🏽', '🚀✨']) expect(isValidArtifactEmoji(emoji), emoji).toBe(true);
  });

  test('the card counts: inline scripts, event handlers, external hosts', () => {
    const result = normalizeArtifact({
      fileName: 'p.html',
      text: `<script src="//static.example.org/x.js"></script><script>1</script><img src="https://img.example.net/a.png" onerror="x()" onload='y()'>
<a href="/relative">r</a><a href="data:text/plain,hi">d</a><div style="background:url('https://bg.example.com/i.png')"></div>`,
    });
    expect(result.policy).toEqual({
      inlineScripts: 1,
      eventHandlerAttributes: 2,
      externalHosts: ['bg.example.com', 'img.example.net', 'static.example.org'],
    });
  });

  test('a page of exactly 16 MiB passes (boundary)', () => {
    const result = normalizeArtifact({ fileName: 'big.md', text: 'x'.repeat(MAX_ARTIFACT_CONTENT_BYTES), title: 'big' });
    expect(result.byteLength).toBe(MAX_ARTIFACT_CONTENT_BYTES);
  });
});

describe('UA1.16 normalise — negative arms (all local, no network)', () => {
  test('.pdf (and any other extension) is refused', () => {
    for (const name of ['doc.pdf', 'page.txt', 'image.svg', 'noext']) {
      expect(refusal(() => normalizeArtifact({ fileName: name, text: 'x' })).kind).toBe('invalid');
    }
    expect(artifactContentTypeOf('A.HTM')).toBe('html');
  });

  test('16 MiB + 1 byte is refused (too-large) — counted in UTF-8 bytes, not characters', () => {
    expect(refusal(() => normalizeArtifact({ fileName: 'big.md', text: 'x'.repeat(MAX_ARTIFACT_CONTENT_BYTES + 1), title: 'b' })).kind).toBe('too-large');
    // 'я' is two bytes: half the character count, the same byte count + 2.
    expect(refusal(() => normalizeArtifact({ fileName: 'big.md', text: 'я'.repeat(MAX_ARTIFACT_CONTENT_BYTES / 2 + 1), title: 'b' })).kind).toBe('too-large');
  });

  test('<input type=password> and <form> are refused, in HTML and in Markdown', () => {
    for (const text of ['<input type=password name=p>', '<INPUT name="p" type="password">', "<input type='password'>"]) {
      const error = refusal(() => normalizeArtifact({ fileName: 'p.html', text }));
      expect(error.kind).toBe('invalid');
      expect(error.message).toContain('password');
    }
    expect(refusal(() => normalizeArtifact({ fileName: 'p.md', text: '# x\n<form action="/x"><button>go</button></form>' })).message).toContain('<form>');
    // Control: a text input and the WORD form are fine.
    expect(() => normalizeArtifact({ fileName: 'p.html', text: '<input type="text"><p>the form of the page</p><formula/>' })).not.toThrow();
  });

  test('an emoji that is not 1–2 emoji code points is refused', () => {
    for (const emoji of ['<', '"', "'", 'A', '1', '📊📊📊', '📊<', ':)']) {
      expect(refusal(() => normalizeArtifact({ fileName: 'a.md', text: 'x', emoji })).kind, emoji).toBe('invalid');
    }
  });
});

/**
 * UA12.65 (origin UA-x / UA1.25) — the v1 content policy refused `<form>` and `<input type=password>` ANYWHERE in a
 * Markdown page, fenced code included, so a chat or .md page showing an HTML form EXAMPLE could not be shared or
 * published. A fence renders escaped on the published page (`<pre><code>`), so its form is display text, never the
 * phishing shape — the refusal scan reads Markdown without fenced spans. Controls: a raw `<form>` in prose and an
 * HTML page with a form are still refused; the bytes on the wire are untouched (only the scan exempts the fence).
 */
describe('UA12.65 — a fenced <form> example in Markdown is display text, not a live form', () => {
  const FENCED_EXAMPLE = [
    '# Login form example',
    '',
    '```html',
    '<form action="/login" method="post">',
    '  <input type="password" name="password">',
    '  <button>Sign in</button>',
    '</form>',
    '```',
    '',
    'Paste this into your app.',
  ].join('\n');

  test('a .md page whose only form and password field are inside a ``` fence is normalised, bytes untouched', () => {
    const result = normalizeArtifact({ fileName: 'login.md', text: FENCED_EXAMPLE });
    expect(result.contentType).toBe('markdown');
    expect(result.content).toContain('<form action="/login"');
    expect(result.content).toContain('type="password"');
  });

  test('~~~ fences exempt too, and a fence opened and never closed exempts to the end of the page', () => {
    expect(() => normalizeArtifact({ fileName: 'a.md', text: '~~~\n<form action="/x"></form>\n~~~\ndone' })).not.toThrow();
    expect(() => normalizeArtifact({ fileName: 'a.md', text: 'intro\n\n```html\n<form action="/x"></form>' })).not.toThrow();
  });

  test('control: a raw <form> in prose is still refused beside an exempt fence, and an HTML page with a form is still refused', () => {
    expect(refusal(() => normalizeArtifact({ fileName: 'a.md', text: '```html\n<form action="/x"></form>\n```\n\nand a live one: <form action="/y"></form>' })).message).toContain('<form>');
    expect(refusal(() => normalizeArtifact({ fileName: 'a.html', text: '<form action="/y"></form>' })).message).toContain('<form>');
  });

  test('control: a fence exempts only its interior — a password input in prose is still refused', () => {
    expect(refusal(() => normalizeArtifact({ fileName: 'a.md', text: '```\n<form action="/x"></form>\n```\n<input type="password" name="p">' })).message).toContain('password');
  });
});

/**
 * UA12.176 — UA12.65's line-regex fence tracking failed OPEN: a ``` line inside an HTML block, an info string with a
 * backtick, a fence in a list item, a closer carrying an info string… each hid a LIVE form from the refusal while
 * markdown-it (html), marked and micromark (dangerous html) all render it live (2026-10-08 verification). Only what a
 * CommonMark lexer reports as TOP-LEVEL fenced code is exempted now; everything else is scanned whole.
 */
describe('UA12.176 — only top-level fenced code (per a CommonMark lexer) is exempted', () => {
  const F = '<form action="x"><input type="password" name="p"></form>';
  const live: Array<[string, string]> = [
    ['a ``` line inside an HTML block', `<div>\n\`\`\`\n${F}\n\`\`\`\n</div>\n`],
    ['a ``` opener whose info string has a backtick (not a fence)', `\`\`\`a\`b\n${F}\n`],
    ['a ``` line inside <pre> (an HTML block)', `<pre>\n\`\`\`\n${F}\n</pre>\n`],
    ['a <pre> block with blank lines around the fence', `<pre>\n\n\`\`\`\n${F}\n\`\`\`\n\n</pre>\n`],
    ['a fence inside a list item that a column-0 line ends', `- item\n\n  \`\`\`\n  code\n${F}\n`],
    ['a fence inside an ordered list item', `1. x\n\n   \`\`\`\n${F}\n`],
    ['a would-be closer with an info string flipping the parity', `\`\`\`\n\`\`\` x\n\`\`\`\n${F}\n\`\`\`\n`],
    ['a paragraph line that looks like a fence', `para\n\`\`\` a\`b\n\n${F}\n`],
    ['a fence inside a blockquote', `> \`\`\`\n${F}\n`],
    // UA12.176 follow-up: marked's closer rule takes only SPACES after the fence; CommonMark (markdown-it, micromark)
    // also takes tabs, so these close early there and the form after them renders LIVE.
    ['a ``` closer followed by a tab', `\`\`\`\nx\n\`\`\`\t\n${F}\n\`\`\`\n`],
    ['a ~~~ closer followed by a tab', `~~~\nx\n~~~\t\n${F}\n~~~\n`],
    ['a ``` closer followed by a space and a tab, then an unclosed tail', `\`\`\`\nx\n\`\`\` \t\n\n${F}`],
    // UA12.176 follow-up 3: marked's closer rule (`\1[~`]*`) also ends a fence on a closer trailed by "~" or "`", which
    // CommonMark does not; there the NEXT fence line closes the block and the form after it renders LIVE.
    ['a ``` closer trailed by a ~ (not a CommonMark closer)', `\`\`\`\nx\n\`\`\`~\n\`\`\`\n${F}\n\`\`\`\n`],
    ['a ~~~ closer trailed by a ` (not a CommonMark closer)', `~~~\nx\n~~~\`\n~~~\n${F}\n~~~\n`],
    // UA12.176 follow-up 2: marked misses HTML blocks CommonMark opens — a `</pre>`-type closing tag (marked refuses
    // the type-1 names as type-7 tags) and a `<?` / `<!X` / `<![CDATA[` line interrupting a paragraph — so the
    // "fence" after them is raw HTML in markdown-it and micromark, and the form renders LIVE.
    ['a ``` fence after a </pre> line', `</pre>\n\`\`\`\n${F}\n\`\`\`\n`],
    ['a ~~~ fence after a </textarea> line', `</textarea>\n~~~\n${F}\n~~~\n`],
    ['a ``` fence after a paragraph and a <? line', `Intro\n<?\n\`\`\`\n${F}\n\`\`\`\n`],
    ['a ``` fence after a paragraph and a <!X line', `Intro\n<!X\n\`\`\`\n${F}\n\`\`\`\n`],
    ['a ``` fence after a paragraph and a <![CDATA[ line', `Intro\n<![CDATA[\n\`\`\`\n${F}\n\`\`\`\n`],
    // marked ends the list before a lazy-continuation line CommonMark keeps in the item, so its "top-level" fence is
    // list content there and the HTML after the item renders LIVE.
    ['a fence after a list item continued lazily', `- item\n\tx\n\`\`\`a\`b\n  \`\`\`\n<span>\n${F}\n~~~\n`],
    // …and marked's own `html` tokens can end at a different line: CommonMark ends a <script> block at ANY type-1
    // closer (`</style>` here), so the `</script>` line opens a new HTML block that swallows the fence.
    ['a fence after a <script> block CommonMark ends at </style>', `<script>\n</style>\n</script>\n\`\`\`\n${F}\n\`\`\`\n`],
  ];
  for (const [name, text] of live) {
    test(`${name} is refused (it renders live)`, () => {
      expect(refusal(() => normalizeArtifact({ fileName: 'a.md', text })).message).toMatch(/password|<form>/);
    });
  }

  const shown: Array<[string, string]> = [
    ['a plain top-level ``` fence', `\`\`\`html\n${F}\n\`\`\`\n`],
    ['a ~~~ fence whose info string has a backtick (legal for tildes)', `~~~a\`b\n${F}\n~~~\n`],
    ['a fence written with CRLF line endings', `\`\`\`\r\n${F}\r\n\`\`\`\r\n`],
    ['a fence whose own last line is a closer followed by a tab (nothing after it)', `\`\`\`\n${F}\n\`\`\`\t\n`],
    ['a ``` fence closed by a longer ```` closer', `\`\`\`\n${F}\n\`\`\`\`\n\nafter\n`],
    ['a fence after prose and a blank line (no HTML line before it)', `Intro text.\n\n\`\`\`html\n${F}\n\`\`\`\n`],
    ['the chat transcript shape: a fence after a blank-line-ended list and a collapsed <details> tool block',
      `- Time: 1\n- Tool: Read\n\n<details><summary>Tool result</summary>\n\n\`\`\`\n${F}\n\`\`\`\n\n</details>\n\nHere:\n\n\`\`\`html\n${F}\n\`\`\`\n`],
  ];
  for (const [name, text] of shown) {
    test(`${name} stays exempt (it renders as code)`, () => {
      expect(() => normalizeArtifact({ fileName: 'a.md', text })).not.toThrow();
    });
  }
});
