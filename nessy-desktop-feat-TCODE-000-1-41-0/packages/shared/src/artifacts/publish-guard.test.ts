/**
 * UA1.17 — the publish guard. Every secret-shaped value here is FAKE and
 * assembled at runtime; no real credential file is ever read (the two home
 * paths are judged lexically and by symlink, never opened).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SAFE_MODE_CONFIG } from '../agent/mode-types.ts';
import { floorHomeDir } from '../agent/mode-manager-home.ts';
import { TOOL_RESULT_SECRET_RULE_NAMES } from '../agent/tool-result-secret-scan.ts';
import {
  GUARD_READ_CAP_BYTES,
  PUBLISH_GUARD_BLOCKING_RULES,
  PUBLISH_SCAN_SENTENCE,
  findLuhnPans,
  guardArtifactFile,
  scanArtifactText,
  type PublishGuardRefusal,
  type PublishGuardResult,
} from './publish-guard.ts';

let base: string;
let cwd: string;
let sessionDir: string;
let outside: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'ua117-guard-')));
  cwd = join(base, 'project');
  sessionDir = join(base, 'session');
  outside = join(base, 'elsewhere');
  for (const dir of [cwd, sessionDir, outside]) mkdirSync(dir, { recursive: true });
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function guard(filePath: string, extra: Partial<Parameters<typeof guardArtifactFile>[0]> = {}): PublishGuardResult {
  return guardArtifactFile({ filePath, sessionCwd: cwd, sessionDir, ...extra });
}

function refused(result: PublishGuardResult): PublishGuardRefusal {
  if (result.ok) throw new Error('expected a refusal');
  return result;
}

/** Fake values, built so no literal of the shape sits in this file. */
const FAKE = {
  jwt: ['ey', 'J', 'a'.repeat(14), '.', 'b'.repeat(14), '.', 'c'.repeat(14)].join(''),
  ory: ['ory', 'at', 'x'.repeat(24)].join('_'),
  bearer: ['Bear', 'er ', 'Z'.repeat(28)].join(''),
};

/** A Luhn-valid number from a prefix, its check digit computed here. */
function withLuhnDigit(prefix: string): string {
  for (let check = 0; check <= 9; check += 1) {
    const candidate = `${prefix}${check}`;
    let sum = 0;
    let double = false;
    for (let i = candidate.length - 1; i >= 0; i -= 1) {
      let digit = Number(candidate[i]);
      if (double) { digit *= 2; if (digit > 9) digit -= 9; }
      sum += digit;
      double = !double;
    }
    if (sum % 10 === 0) return candidate;
  }
  throw new Error('unreachable');
}

describe('UA1.17 positive arms', () => {
  test('a clean file under the cwd passes and returns THE buffer and its sha256', () => {
    const bytes = '<h1>Report</h1>\n<p>Contact: team@example.com, +7 912 345-67-89</p>\n';
    writeFileSync(join(cwd, 'report.html'), bytes);
    const result = guard('report.html');
    if (!result.ok) throw new Error(result.message);
    expect(result.realPath).toBe(join(cwd, 'report.html'));
    expect(result.contentType).toBe('html');
    expect(result.buffer.equals(readFileSync(join(cwd, 'report.html')))).toBe(true);
    expect(result.text).toBe(bytes);
    expect(result.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(result.byteLength).toBe(Buffer.byteLength(bytes));
    expect(result.counts).toEqual({ emails: 1, phones: 1 });
    expect(result.scanSentence).toBe(PUBLISH_SCAN_SENTENCE);
    expect(PUBLISH_SCAN_SENTENCE).toBe('Automatic check found no known token formats; it does not detect encoded or free-form secrets or client data.');
  });

  test('a non-Luhn 16-digit number passes', () => {
    let number = '4000000000000001';
    if (findLuhnPans(number).length > 0) number = '4000000000000002';
    expect(findLuhnPans(number)).toEqual([]);
    writeFileSync(join(cwd, 'ids.md'), `# Ids\n\norder ${number}\n`);
    expect(guard('ids.md').ok).toBe(true);
  });

  test('a Luhn-valid 13-digit epoch-milliseconds timestamp passes (first digit 1 is not a card range)', () => {
    const timestamp = withLuhnDigit('175900000000');
    expect(timestamp).toHaveLength(13);
    writeFileSync(join(cwd, 'chart.html'), `<script>const t = ${timestamp};</script>`);
    expect(guard('chart.html').ok).toBe(true);
  });

  test('the session folder and an added root are inside the read floor', () => {
    writeFileSync(join(sessionDir, 'page.md'), '# s');
    expect(guard(join(sessionDir, 'page.md')).ok).toBe(true);
    writeFileSync(join(outside, 'page.md'), '# a');
    expect(guard(join(outside, 'page.md'), { addedRoots: [outside] }).ok).toBe(true);
  });
});

describe('UA1.17 the credential floor — derived, before any read', () => {
  test('a cwd symlink to credentials.enc is refused', () => {
    mkdirSync(join(base, 'config'));
    writeFileSync(join(base, 'config', 'credentials.enc'), 'not-really-encrypted');
    symlinkSync(join(base, 'config', 'credentials.enc'), join(cwd, 'page.html'));
    const refusal = refused(guard('page.html'));
    expect(refusal.kind).toBe('denied-path');
    expect(refusal.pattern).toBe('**/credentials.enc');
  });

  test('a cwd symlink to ~/.nessy/dp_auth_creds.json.bak is refused (judged by its target, never opened)', () => {
    symlinkSync(join(floorHomeDir(), '.nessy', 'dp_auth_creds.json.bak'), join(cwd, 'notes.md'));
    const refusal = refused(guard('notes.md'));
    expect(refusal.kind).toBe('denied-path');
    expect(refusal.pattern).toBe('~/.nessy/**');
  });

  test('~/.npmrc, ~/.aws/credentials and a .env in the cwd are refused', () => {
    expect(refused(guard('~/.npmrc')).pattern).toBe('**/.npmrc');
    expect(refused(guard('~/.aws/credentials')).pattern).toBe('~/.aws/**');
    expect(refused(guard(join(floorHomeDir(), '.aws', 'credentials'))).kind).toBe('denied-path');
    writeFileSync(join(cwd, '.env'), 'X=1');
    chmodSync(join(cwd, '.env'), 0o000); // refused BEFORE the open: an unreadable file still answers denied-path
    const env = refused(guard('.env'));
    expect(env.kind).toBe('denied-path');
    expect(env.pattern).toBe('**/.env');
    expect(refused(guard('.env.production.md')).pattern).toBe('**/.env.*');
  });

  test('the floor is DERIVED from SAFE_MODE_CONFIG.deniedPaths: a planted pattern refuses, its removal admits', () => {
    writeFileSync(join(cwd, 'ua117-planted-sentinel.md'), '# clean');
    expect(guard('ua117-planted-sentinel.md').ok).toBe(true);
    const deniedPaths = SAFE_MODE_CONFIG.deniedPaths!;
    deniedPaths.push('**/ua117-planted-sentinel.md');
    try {
      const refusal = refused(guard('ua117-planted-sentinel.md'));
      expect(refusal.kind).toBe('denied-path');
      expect(refusal.pattern).toBe('**/ua117-planted-sentinel.md');
    } finally {
      expect(deniedPaths.pop()).toBe('**/ua117-planted-sentinel.md');
    }
    expect(guard('ua117-planted-sentinel.md').ok).toBe(true);
  });

  test('no deniedPaths entry is hand-listed in the guard\'s source', () => {
    const source = readFileSync(join(import.meta.dir, 'publish-guard.ts'), 'utf-8');
    for (const pattern of SAFE_MODE_CONFIG.deniedPaths!) {
      expect(source.includes(`'${pattern}'`) || source.includes(`"${pattern}"`), pattern).toBe(false);
    }
  });

  test('a path outside the roots is refused BEFORE it is read (an unreadable file answers outside-roots, not an open error)', () => {
    writeFileSync(join(outside, 'page.md'), '# x');
    chmodSync(join(outside, 'page.md'), 0o000);
    const refusal = refused(guard(join(outside, 'page.md')));
    expect(refusal.kind).toBe('outside-roots');
    expect(refusal.message).toContain('working folder');
    // A symlink inside the cwd pointing outside is outside too.
    symlinkSync(join(outside, 'page.md'), join(cwd, 'link.md'));
    expect(refused(guard('link.md')).kind).toBe('outside-roots');
    // And `..` cannot climb out.
    expect(refused(guard('../elsewhere/page.md')).kind).toBe('outside-roots');
  });
});

describe('UA1.17 the scan — shared rules + pan + the key-name scan, the line named, never the value', () => {
  test('guard rules = the shared tool-result rules + pan + sensitive-key, and the three transport rules come from the shared table', () => {
    expect([...PUBLISH_GUARD_BLOCKING_RULES]).toEqual([...TOOL_RESULT_SECRET_RULE_NAMES, 'pan', 'sensitive-key']);
    for (const name of ['jwt', 'ory-token', 'bearer']) expect(TOOL_RESULT_SECRET_RULE_NAMES).toContain(name);
    const source = readFileSync(join(import.meta.dir, 'publish-guard.ts'), 'utf-8');
    expect(source).not.toContain('eyJ[');
    expect(source).not.toContain('ory_(?:');
  });

  const cases: Array<[string, string]> = [
    ['jwt', FAKE.jwt],
    ['ory-token', FAKE.ory],
    ['bearer', FAKE.bearer],
    ['pan', withLuhnDigit('411111111111111')],
    ['pan', withLuhnDigit('220012345678901').replace(/(\d{4})(?=\d)/g, '$1 ')],
  ];
  for (const [rule, value] of cases) {
    test(`a file carrying a ${rule} value is refused, naming the rule and the line, never the value`, () => {
      writeFileSync(join(cwd, 'page.md'), `# Title\n\nsome text\nvalue: ${value}\n`);
      const refusal = refused(guard('page.md'));
      expect(refusal.kind).toBe('secret');
      expect(refusal.rule).toBe(rule);
      expect(refusal.line).toBe(4);
      expect(refusal.message).toContain(`line 4`);
      expect(refusal.message).toContain(rule);
      expect(refusal.message).not.toContain(value);
      expect(JSON.stringify(refusal)).not.toContain(value);
    });
  }

  test('the FIRST finding by position is the one named', () => {
    const scan = scanArtifactText(`line one\n${withLuhnDigit('510510510510510')}\n${FAKE.jwt}\n`);
    expect(scan.blocking).toEqual({ rule: 'pan', line: 2, total: 2 });
  });

  // UA1.17 follow-up: a card number is usually written WITH its expiry or CVV
  // (or after a row number); the old greedy run swallowed those digits, failed
  // Luhn as a whole and never tried the PAN inside it.
  const visa = withLuhnDigit('411111111111111');
  const master = withLuhnDigit('555555555555444');
  const grouped = (pan: string, sep: string) => pan.replace(/(\d{4})(?=\d)/g, `$1${sep}`);
  const glued: Array<[string, string]> = [
    ['an unseparated PAN followed by its expiry', `Test card: ${visa} 12/28`],
    ['a spaced PAN followed by a CVV', `Card ${grouped(visa, ' ')} 123`],
    ['a dashed PAN glued to its expiry by a dash', `${grouped(master, '-')}-05/29`],
    ['a spaced PAN followed by a spaced expiry', `${grouped(master, ' ')} 05 29`],
    ['a PAN after a row number', `Row 3 ${grouped(visa, ' ')}`],
  ];
  for (const [name, line] of glued) {
    test(`${name} is refused as pan on its line`, () => {
      expect(scanArtifactText(`# Cards\n${line}\n`).blocking).toEqual({ rule: 'pan', line: 2, total: 1 });
    });
  }

  test('boundary: digits glued to a PAN with NO separator, a non-Luhn number with an expiry, and an epoch-ms timestamp with a count still pass', () => {
    let nonLuhn = '4000000000000001';
    if (findLuhnPans(nonLuhn).length > 0) nonLuhn = '4000000000000002';
    const text = [
      `id ${visa}12345678`,
      `order ${nonLuhn} 12/28`,
      `t ${withLuhnDigit('175900000000')} 42`,
    ].join('\n');
    expect(findLuhnPans(text)).toEqual([]);
    expect(scanArtifactText(text).blocking).toBeNull();
  });

  // UA1.17 follow-up (attempt 2): a window counts only in a CARD layout, so a
  // separated run of short numbers (chart data) never forms one. Each line was
  // refused by the any-group window of 0ce3adee9.
  test('boundary: separated non-card number sequences (comma-less SVG polyline, a row of figures, a dash-joined SVG path) pass', () => {
    const text = [
      '<polyline points="0 145 40 141 80 76 120 103 160 195 200 147 240 157 280 78 320 108 360 77 400 153 440 188"/>',
      'Выручка по месяцам: 587 227 843 137 869 224 671 171',
      '<path d="M10 80 l-39-24-79-43-12-58-33-27-61-45-28-37-52-19"/>',
    ].join('\n');
    expect(findLuhnPans(text)).toEqual([]);
    expect(scanArtifactText(text).blocking).toBeNull();
  });

  test('an Amex PAN in its 4-6-5 layout followed by a CVV is refused as pan', () => {
    const amex = withLuhnDigit('37828224631000').replace(/^(\d{4})(\d{6})(\d{5})$/, '$1 $2 $3');
    expect(scanArtifactText(`# Cards\nAmex ${amex} 1234\n`).blocking).toEqual({ rule: 'pan', line: 2, total: 1 });
  });
});

describe('UA12.9 — the key-name scan: isSensitiveKeyName at key positions, never over bare prose', () => {
  test('the row\'s control: a page with password-shaped keys is refused naming the line, never quoting the value', () => {
    writeFileSync(join(cwd, 'config.md'), '# Config\n\ndatabase settings\n\npassword: hunter2\nport: 5432\n');
    const refusal = refused(guard('config.md'));
    expect(refusal.kind).toBe('secret');
    expect(refusal.rule).toBe('sensitive-key');
    expect(refusal.line).toBe(5);
    expect(refusal.message).toContain('line 5');
    expect(refusal.message).toContain('sensitive-key');
    expect(refusal.message).not.toContain('hunter2');
    expect(JSON.stringify(refusal)).not.toContain('hunter2');
  });

  test('the row\'s control: the word passwordHint in prose passes (and so do monkey, author, keyboard — no key position)', () => {
    const text = '# Hints\n\nYour passwordHint is the name of your first pet.\nThe author and the monkey typed on a keyboard.\n';
    expect(scanArtifactText(text).blocking).toBeNull();
    writeFileSync(join(cwd, 'hints.md'), text);
    expect(guard('hints.md').ok).toBe(true);
  });

  const shapes: Array<[string, string]> = [
    ['a plain password line', 'password: hunter2'],
    ['an env-style assignment', 'PASSWORD=hunter2'],
    ['a quoted yaml pair', '"password": "hunter2"'],
    ['an ini-style spaced assignment', 'api-key = abcd1234wxyz'],
    ['a markdown/yaml list item', '- password: hunter2'],
    ['an inline json pair', '{"api_key": "abcd1234"}'],
    ['text just inside an html tag', '<td>password: hunter2</td>'],
  ];
  for (const [name, line] of shapes) {
    test(`${name} is refused as sensitive-key on its line`, () => {
      expect(scanArtifactText(`# Page\n${line}\n`).blocking).toEqual({ rule: 'sensitive-key', line: 2, total: 1 });
    });
  }

  const passes: Array<[string, string]> = [
    ['a bare sensitive word (no key position)', 'Your passwordHint is the name of your first pet.'],
    ['a key whose value is a 1–3 character prose word', 'password: it can leak'],
    ['a mid-sentence colon after a sensitive word', 'Never share your password: it can leak.'],
    ['a container value (a json array, not a literal)', '"passwords": [3, 1, 4]'],
    ['a pipe-table row (no key separator)', '| password | hunter2 |'],
    ['an html attribute pair', '<input type="password" value="hunter2">'],
    ['an empty quoted value', 'password: ""'],
  ];
  for (const [name, line] of passes) {
    test(`${name} passes`, () => {
      expect(scanArtifactText(`${line}\n`).blocking).toBeNull();
    });
  }

  test('the first finding by position is named; the total counts every shape', () => {
    const text = ['token: abcd1234', withLuhnDigit('411111111111111'), 'password: hunter2'].join('\n');
    expect(scanArtifactText(text).blocking).toEqual({ rule: 'sensitive-key', line: 1, total: 3 });
  });

  test('a minified snapshot line with a password key is refused, its clean sibling keys not counted', () => {
    expect(scanArtifactText('{"kv":{"password":"hunter2","attempts":2}}').blocking)
      .toEqual({ rule: 'sensitive-key', line: 1, total: 1 });
  });
});

describe('UA12.175 — the key-position rule needs a credential WORD, never a substring of one', () => {
  const ordinary: Array<[string, string]> = [
    ['a document byline', '# Report\nAuthor: Igor Gavrikov'],
    ['a json author field', '{"title":"Q3","author":"Igor"}'],
    ['a json "key" field', '{"rows":[{"key":"q3","value":10}]}'],
    ['a React key in inline js', 'items.map(x => ({ key: x.id, label: x.name }))'],
    ['a chart dataKey', '<script>const c = { dataKey: "revenue" };</script>'],
    ['a keywords line', 'Keywords: planning, roadmap'],
    ['a token count list item', '- Tokens: 12000'],
    ['a dotted i18n key', '{"auth.login": "Sign in"}'],
    ['an authentication list item', '- Authentication: OAuth via SSO'],
    ['a bare Key list item', '- Key: value'],
    ['a max_tokens tool input', '{"model": "coder", "max_tokens": 4096}'],
    ['a tokenizer list item', '- Tokenizer: cl100k_base'],
    ['a credential word that is not the head noun', 'passwordHint: "the name of your first pet"'],
    ['an env reference as the value', 'const config = {\n  apiKey: process.env.API_KEY,\n}'],
    ['a template reference as the value', 'password: ${DB_PASSWORD}'],
    ['a shell variable as the value', 'API_TOKEN=$CI_JOB_TOKEN'],
  ];
  for (const [name, text] of ordinary) {
    test(`${name} passes`, () => {
      expect(scanArtifactText(`${text}\n`).blocking).toBeNull();
    });
  }

  const credentials: Array<[string, string]> = [
    ['an env-style secret', 'DB_PASSWORD=hunter2hunter2'],
    ['a camelCase api key', 'apiKey: "sk-live-abcdef"'],
    ['an access token', '"access_token": "abcd1234"'],
    ['an AWS secret access key', 'AWS_SECRET_ACCESS_KEY=abcd1234wxyz'],
    ['a client secret', 'clientSecret = abcd1234'],
    ['a private key', 'private_key: abcd1234'],
    ['an Authorization header line', 'Authorization: Basic dXNlcjpwYXNz'],
    ['a cookie line', 'Cookie: session=abcd1234'],
    ['a passphrase', 'passphrase: correct horse'],
  ];
  for (const [name, line] of credentials) {
    test(`${name} is still refused as sensitive-key`, () => {
      expect(scanArtifactText(`# Page\n${line}\n`).blocking).toEqual({ rule: 'sensitive-key', line: 2, total: 1 });
    });
  }

  // UA12.175 follow-up: a value that is never a secret — a literal, a type name, a placeholder or a mask — passes.
  const literals: Array<[string, string]> = [
    ['inline page state with a boolean', 'const state = { showPassword: false, email: "" };'],
    ['a json boolean under a token key', '{"hasToken": true, "count": 3}'],
    ['a json null under a token key', '{"token": null}'],
    ['a TS interface with type annotations', 'interface Creds {\n  password: string;\n  token: string;\n}'],
    ['an api-docs bearer placeholder', 'Authorization: Bearer <your-token>'],
    ['an angle-bracket placeholder', 'password: <your password>'],
    ['a YOUR_ placeholder', 'password: YOUR_PASSWORD'],
    ['a mask run', 'password: ********'],
    ['a bearer with an env reference', 'Authorization: Bearer ${API_TOKEN}'],
  ];
  for (const [name, text] of literals) {
    test(`${name} passes`, () => {
      expect(scanArtifactText(`${text}\n`).blocking).toBeNull();
    });
  }

  const notLiterals: Array<[string, string]> = [
    ['a short real value', 'password: hunter2'],
    ['a literal word glued to more characters', 'password: false1234'],
    ['a markup-wrapped value (not a whole placeholder)', 'password: <b>hunter2</b>'],
    ['a basic-scheme credential after the scheme word', 'Authorization: Basic dXNlcjpwYXNz'],
  ];
  for (const [name, line] of notLiterals) {
    test(`boundary: ${name} is still refused as sensitive-key`, () => {
      expect(scanArtifactText(`# Page\n${line}\n`).blocking).toEqual({ rule: 'sensitive-key', line: 2, total: 1 });
    });
  }

  test('{ sensitiveKeys: false } leaves the key-name rule out and keeps every other rule', () => {
    expect(scanArtifactText('password: hunter2\n', { sensitiveKeys: false }).blocking).toBeNull();
    const pan = withLuhnDigit('411111111111111');
    expect(scanArtifactText(`password: hunter2\ncard ${pan}\n`, { sensitiveKeys: false }).blocking)
      .toEqual({ rule: 'pan', line: 2, total: 1 });
  });
});

describe('UA1.17 the single read and its bounds', () => {
  test('.pdf is refused before the read', () => {
    writeFileSync(join(cwd, 'doc.pdf'), '%PDF-1.4');
    expect(refused(guard('doc.pdf')).kind).toBe('unsupported-type');
  });

  test('a missing file, a FIFO, a non-UTF-8 file and an oversized file each answer a sentence', () => {
    expect(refused(guard('missing.md')).kind).toBe('not-found');
    const fifo = join(cwd, 'pipe.md');
    expect(Bun.spawnSync(['mkfifo', fifo]).exitCode).toBe(0);
    expect(refused(guard('pipe.md')).kind).toBe('not-a-file'); // and the test did not hang
    writeFileSync(join(cwd, 'binary.md'), Buffer.from([0xff, 0xfe, 0x00, 0xc3]));
    expect(refused(guard('binary.md')).kind).toBe('not-text');
    writeFileSync(join(cwd, 'huge.md'), '');
    truncateSync(join(cwd, 'huge.md'), GUARD_READ_CAP_BYTES + 1);
    expect(refused(guard('huge.md')).kind).toBe('too-large');
  });
});

describe('UA1.18 — the read floor follows a symlinked session folder (found while composing the publish chain)', () => {
  // The guard compares the FILE's realpath; before this the roots were compared as given, so a session whose working
  // folder is reached through a symlink (macOS `/tmp`, `/var/folders`, a projects folder linked to another disk) could
  // never publish anything — every file read as "outside the session's working folder".
  test('positive: a file inside a cwd reached through a symlink passes', () => {
    const link = join(base, 'linked-project');
    symlinkSync(cwd, link);
    writeFileSync(join(cwd, 'page.html'), '<p>ok</p>');
    const result = guardArtifactFile({ filePath: 'page.html', sessionCwd: link });
    expect(result.ok).toBe(true);
  });

  test('negative: through the same symlinked cwd, a file outside it is still refused before it is read', () => {
    const link = join(base, 'linked-project');
    symlinkSync(cwd, link);
    writeFileSync(join(outside, 'page.html'), '<p>no</p>');
    expect(refused(guardArtifactFile({ filePath: join(outside, 'page.html'), sessionCwd: link })).kind).toBe('outside-roots');
  });
});

describe('UA1.17 follow-up — the email count is linear in a long unbroken run (found by the UA1.18 repair lane)', () => {
  // The unbounded local part (`[…]+@`) retried the whole run from every start position: measured 2026-10-02 on this
  // machine, 64 KiB of letters took 3.4 s and 192 KiB 31 s — a 1 MiB base64url blob (every character inside the
  // class) would hold the host's event loop for minutes before any card. The bound is RFC 5321's 64-octet local part.
  test('a 128 KiB single run of local-part characters scans inside a 3 s budget (unbounded it took 13.9 s)', () => {
    const started = performance.now();
    const scan = scanArtifactText(`<p>${'a'.repeat(128 * 1024)}</p>`);
    const elapsed = performance.now() - started;
    expect(scan.emails).toBe(0);
    expect(elapsed).toBeLessThan(3_000);
  });

  test('control: the count is unchanged — ordinary addresses, two in a line, and an over-long local part each still count', () => {
    expect(scanArtifactText('mail a@b.co').emails).toBe(1);
    expect(scanArtifactText('john.doe+x@mail.example.com, jane@ex.org').emails).toBe(2);
    expect(scanArtifactText(`${'y'.repeat(80)}@host.ru`).emails).toBe(1);
    expect(scanArtifactText('x@y and a@b.c').emails).toBe(0);
  });
});
