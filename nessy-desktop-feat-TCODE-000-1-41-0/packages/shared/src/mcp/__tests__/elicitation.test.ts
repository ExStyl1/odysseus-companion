import { describe, expect, it } from 'bun:test';
import { handleMcpElicitationWithAskUser } from '../elicitation.ts';
import { validateAskUserQuestions } from '@nessy-agent/core/utils';

describe('handleMcpElicitationWithAskUser', () => {
  it('asks the user for a single enum field and returns accepted MCP content', async () => {
    const seen: unknown[] = [];

    const result = await handleMcpElicitationWithAskUser({
      method: 'elicitation/create',
      params: {
        message: 'Choose repository access',
        requestedSchema: {
          type: 'object',
          properties: {
            access: {
              type: 'string',
              enum: ['read', 'write'],
              enumNames: ['Read only', 'Read and write'],
            },
          },
          required: ['access'],
        },
      },
    } as any, async (request) => {
      seen.push(request);
      return { type: 'option', optionIndex: 1, value: 'Read and write' };
    });

    expect(seen).toEqual([{
      question: 'Choose repository access',
      options: ['Read only', 'Read and write'],
      allowFreeText: false,
    }]);
    expect(result).toEqual({
      action: 'accept',
      content: { access: 'write' },
    });
  });
});

/**
 * URL mode (`mcp.md:1089`). Before R24 every one of these returned
 * `{action:'decline'}` and nothing was ever opened.
 */
describe('URL-mode elicitation', () => {
  const urlRequest = (url: unknown) => ({
    method: 'elicitation/create',
    params: { mode: 'url', message: 'Authorize the app', elicitationId: 'e-1', url },
  }) as any;

  it('opens the URL and accepts once the user confirms the browser flow', async () => {
    const opened: string[] = [];
    const asked: string[][] = [];

    const result = await handleMcpElicitationWithAskUser(
      urlRequest('https://example.test/authorize'),
      async (request) => {
        asked.push(request.options);
        return { type: 'option', optionIndex: 0, value: request.options[0]! };
      },
      { openUrl: async (url) => { opened.push(url); } },
    );

    expect(opened).toEqual(['https://example.test/authorize']);
    expect(asked).toEqual([['Open separately', 'Cancel'], ['I completed it', 'Cancel']]);
    expect(result).toEqual({ action: 'accept' });
  });

  it('declines without opening when the user cancels the first step', async () => {
    const opened: string[] = [];

    const result = await handleMcpElicitationWithAskUser(
      urlRequest('https://example.test/authorize'),
      async (request) => ({ type: 'option', optionIndex: 1, value: request.options[1]! }),
      { openUrl: async (url) => { opened.push(url); } },
    );

    expect(opened).toEqual([]);
    expect(result).toEqual({ action: 'decline' });
  });

  it('declines when the user cancels after the browser step', async () => {
    const opened: string[] = [];
    let round = 0;

    const result = await handleMcpElicitationWithAskUser(
      urlRequest('https://example.test/authorize'),
      async (request) => {
        const index = round++ === 0 ? 0 : 1;
        return { type: 'option', optionIndex: index, value: request.options[index]! };
      },
      { openUrl: async (url) => { opened.push(url); } },
    );

    expect(opened).toEqual(['https://example.test/authorize']);
    expect(result).toEqual({ action: 'decline' });
  });

  // The URL is a server-supplied string on its way to shell.openExternal.
  it.each([
    ['no url at all', undefined],
    ['a javascript: scheme', 'javascript:alert(1)'],
    ['a file: scheme', 'file:///etc/passwd'],
    ['a registered-handler scheme', 'vscode://file/etc/passwd'],
    ['a malformed url', 'not a url'],
  ])('refuses to open %s and declines visibly', async (_label, url) => {
    const opened: string[] = [];
    const asked: string[][] = [];

    const result = await handleMcpElicitationWithAskUser(
      urlRequest(url),
      async (request) => {
        asked.push(request.options);
        return { type: 'option', optionIndex: 0, value: request.options[0]! };
      },
      { openUrl: async (value) => { opened.push(value); } },
    );

    expect(opened).toEqual([]);
    expect(asked).toEqual([['OK']]);
    expect(result).toEqual({ action: 'decline' });
  });

  it('declines visibly when the opener throws', async () => {
    const asked: string[][] = [];

    const result = await handleMcpElicitationWithAskUser(
      urlRequest('https://example.test/authorize'),
      async (request) => {
        asked.push(request.options);
        return { type: 'option', optionIndex: 0, value: request.options[0]! };
      },
      { openUrl: async () => { throw new Error('no browser'); } },
    );

    expect(asked).toEqual([['Open separately', 'Cancel'], ['OK']]);
    expect(result).toEqual({ action: 'decline' });
  });
});

/**
 * hooks.md §Elicitation. Decision 4 of the R24 plan: a hook decision REPLACES
 * the dialog, it never races it — so every case here asserts the dialog count.
 */
describe('the Elicitation hook', () => {
  const formRequest = {
    method: 'elicitation/create',
    params: {
      message: 'Sign in',
      requestedSchema: {
        type: 'object',
        properties: { user: { type: 'string' }, token: { type: 'string' } },
        required: ['user', 'token'],
      },
    },
  } as any;

  it('answers the server directly on accept and never opens the dialog', async () => {
    let dialogs = 0;

    const result = await handleMcpElicitationWithAskUser(
      formRequest,
      async () => { dialogs++; return { type: 'free_text', value: 'x' }; },
      { beforeDialog: async () => ({ action: 'accept', content: { user: 'ada', token: 't0k' } }) },
    );

    expect(dialogs).toBe(0);
    expect(result).toEqual({ action: 'accept', content: { user: 'ada', token: 't0k' } });
  });

  it.each([['decline'], ['cancel']] as const)('passes %s through with no dialog', async (action) => {
    let dialogs = 0;

    const result = await handleMcpElicitationWithAskUser(
      formRequest,
      async () => { dialogs++; return { type: 'free_text', value: 'x' }; },
      { beforeDialog: async () => ({ action }) },
    );

    expect(dialogs).toBe(0);
    expect(result).toEqual({ action });
  });

  // An accept must carry every required field; it cannot fall back to the
  // dialog, because a hook that returned an action already decided there is none.
  it('declines an accept that misses a required field, still without a dialog', async () => {
    let dialogs = 0;

    const result = await handleMcpElicitationWithAskUser(
      formRequest,
      async () => { dialogs++; return { type: 'free_text', value: 'x' }; },
      { beforeDialog: async () => ({ action: 'accept', content: { user: 'ada' } }) },
    );

    expect(dialogs).toBe(0);
    expect(result).toEqual({ action: 'decline' });
  });

  it('falls through to the dialog when no hook decides', async () => {
    let dialogs = 0;

    const result = await handleMcpElicitationWithAskUser(
      {
        method: 'elicitation/create',
        params: {
          message: 'Pick one',
          requestedSchema: {
            type: 'object',
            properties: { pick: { type: 'string', enum: ['a', 'b'] } },
            required: ['pick'],
          },
        },
      } as any,
      async (request) => { dialogs++; return { type: 'option', optionIndex: 0, value: request.options[0]! }; },
      { beforeDialog: async () => undefined },
    );

    expect(dialogs).toBe(1);
    expect(result).toEqual({ action: 'accept', content: { pick: 'a' } });
  });

  it('runs before URL mode too — the browser is never opened', async () => {
    const opened: string[] = [];
    let dialogs = 0;

    const result = await handleMcpElicitationWithAskUser(
      {
        method: 'elicitation/create',
        params: { mode: 'url', message: 'Authorize', elicitationId: 'e-1', url: 'https://example.test/a' },
      } as any,
      async () => { dialogs++; return { type: 'option', optionIndex: 0, value: 'Open separately' }; },
      {
        openUrl: async (url) => { opened.push(url); },
        beforeDialog: async () => ({ action: 'decline' }),
      },
    );

    expect(dialogs).toBe(0);
    expect(opened).toEqual([]);
    expect(result).toEqual({ action: 'decline' });
  });
});

/**
 * hooks.md §ElicitationResult. The override is documented as "The content
 * object overrides the user's response values" — per field, not wholesale.
 */
describe('the ElicitationResult hook', () => {
  const twoFieldRequest = {
    method: 'elicitation/create',
    params: {
      message: 'Pick two',
      requestedSchema: {
        type: 'object',
        properties: { access: { type: 'string', enum: ['read', 'write'] } },
        required: ['access'],
      },
    },
  } as any;

  const answerFirstOption = async (request: { options: string[] }) =>
    ({ type: 'option', optionIndex: 0, value: request.options[0]! }) as const;

  it('overrides ONE field and leaves the others as the user typed them', async () => {
    let seen: unknown;

    const result = await handleMcpElicitationWithAskUser(
      twoFieldRequest,
      answerFirstOption,
      {
        afterAnswer: async (outcome) => {
          seen = outcome;
          // `note` is added, `access` is untouched and must survive.
          return { action: 'accept', content: { note: 'reviewed' } };
        },
      },
    );

    // The documented input carries the user's action alongside their values.
    expect(seen).toEqual({ action: 'accept', content: { access: 'read' } });
    expect(result).toEqual({ action: 'accept', content: { access: 'read', note: 'reviewed' } });
  });

  it('replaces a field the hook does name', async () => {
    const result = await handleMcpElicitationWithAskUser(
      twoFieldRequest,
      answerFirstOption,
      { afterAnswer: async () => ({ action: 'accept', content: { access: 'write' } }) },
    );

    expect(result).toEqual({ action: 'accept', content: { access: 'write' } });
  });

  it('sends the user answer untouched when the hook does not decide', async () => {
    const result = await handleMcpElicitationWithAskUser(
      twoFieldRequest,
      answerFirstOption,
      { afterAnswer: async () => undefined },
    );

    expect(result).toEqual({ action: 'accept', content: { access: 'read' } });
  });

  it.each([['decline'], ['cancel']] as const)('lets the hook turn the answer into %s', async (action) => {
    const result = await handleMcpElicitationWithAskUser(
      twoFieldRequest,
      answerFirstOption,
      { afterAnswer: async () => ({ action }) },
    );

    expect(result).toEqual({ action });
  });

  // `:2799` — the output "Overrides the user's action", and the INPUT carries
  // `action`, so the hook has to see a decline too or that field is a constant.
  it('fires on a user decline and can override it into an accept', async () => {
    const seen: unknown[] = [];

    const result = await handleMcpElicitationWithAskUser(
      twoFieldRequest,
      async () => ({ type: 'free_text', value: '' }),
      {
        afterAnswer: async (outcome) => {
          seen.push(outcome);
          return { action: 'accept', content: { access: 'read' } };
        },
      },
    );

    expect(seen).toEqual([{ action: 'decline', content: {} }]);
    expect(result).toEqual({ action: 'accept', content: { access: 'read' } });
  });

  // The module's `cancel` is the abort/teardown path (askUser threw), not
  // something the user chose, so there is no response for a hook to amend.
  it('does not fire on the abort path', async () => {
    let fired = 0;

    const result = await handleMcpElicitationWithAskUser(
      twoFieldRequest,
      async () => { throw new Error('aborted'); },
      { afterAnswer: async () => { fired++; return { action: 'accept' }; } },
    );

    expect(fired).toBe(0);
    expect(result).toEqual({ action: 'cancel' });
  });

  it('can veto a URL-mode confirm, and keeps a URL accept content-free', async () => {
    const seen: unknown[] = [];
    const urlRequest = {
      method: 'elicitation/create',
      params: { mode: 'url', message: 'Authorize', elicitationId: 'e-1', url: 'https://example.test/a' },
    } as any;

    const accepted = await handleMcpElicitationWithAskUser(
      urlRequest,
      async (request) => ({ type: 'option', optionIndex: 0, value: request.options[0]! }),
      {
        openUrl: async () => {},
        afterAnswer: async (outcome) => { seen.push(outcome); return undefined; },
      },
    );
    expect(seen).toEqual([{ action: 'accept', content: {} }]);
    expect(accepted).toEqual({ action: 'accept' });

    const vetoed = await handleMcpElicitationWithAskUser(
      urlRequest,
      async (request) => ({ type: 'option', optionIndex: 0, value: request.options[0]! }),
      { openUrl: async () => {}, afterAnswer: async () => ({ action: 'decline' }) },
    );
    expect(vetoed).toEqual({ action: 'decline' });
  });

  it('declines rather than sending an unsendable override', async () => {
    const result = await handleMcpElicitationWithAskUser(
      twoFieldRequest,
      answerFirstOption,
      { afterAnswer: async () => ({ action: 'accept', content: { access: { nested: true } } }) },
    );

    expect(result).toEqual({ action: 'decline' });
  });
});

describe('malformed form elicitation', () => {
  it('declines visibly when the server sends no requestedSchema', async () => {
    const asked: string[][] = [];

    const result = await handleMcpElicitationWithAskUser(
      { method: 'elicitation/create', params: { message: 'Fill this in' } } as any,
      async (request) => {
        asked.push(request.options);
        return { type: 'option', optionIndex: 0, value: request.options[0]! };
      },
    );

    expect(asked).toEqual([['OK']]);
    expect(result).toEqual({ action: 'decline' });
  });
});

/**
 * mcp.md:1088 — "Form mode: Claude Code shows a dialog with form fields
 * defined by the server (for example, a username and password prompt)."
 * Everything below used to reach "Reply with a JSON object matching the
 * requested MCP schema", where a typo became a silent decline.
 */
describe('server-defined forms', () => {
  const request = (properties: Record<string, unknown>, required?: string[]) => ({
    method: 'elicitation/create',
    params: {
      message: 'Configure the connection',
      requestedSchema: { type: 'object', properties, ...(required ? { required } : {}) },
    },
  }) as any;

  it('renders an all-choice form as ONE batched question card', async () => {
    const seen: any[] = [];

    const result = await handleMcpElicitationWithAskUser(
      request({
        access: { type: 'string', title: 'Access', enum: ['read', 'write'], enumNames: ['Read', 'Write'] },
        notify: { type: 'boolean', title: 'Notify me' },
      }, ['access', 'notify']),
      async (ask) => {
        seen.push(ask);
        return { type: 'batched', answers: { Access: 'Write', 'Notify me': 'No' } };
      },
    );

    expect(seen).toHaveLength(1);
    expect(seen[0].questions).toEqual([
      { question: 'Access', header: 'access', options: [{ label: 'Read' }, { label: 'Write' }] },
      { question: 'Notify me', header: 'notify', options: [{ label: 'Yes' }, { label: 'No' }] },
    ]);
    // The legacy projection keeps a downgraded consumer rendering something sane.
    expect(seen[0].options).toEqual(['Read', 'Write']);
    expect(result).toEqual({ action: 'accept', content: { access: 'write', notify: false } });
  });

  it('asks a username and password form field by field, not as JSON', async () => {
    const prompts: string[] = [];

    const result = await handleMcpElicitationWithAskUser(
      request({
        username: { type: 'string', title: 'Username' },
        password: { type: 'string', title: 'Password' },
      }, ['username', 'password']),
      async (ask) => {
        prompts.push(ask.question);
        expect(ask.allowFreeText).toBe(true);
        return { type: 'free_text', value: prompts.length === 1 ? 'ada' : 'hunter2' };
      },
    );

    expect(prompts).toEqual([
      'Configure the connection\n\nUsername',
      'Configure the connection\n\nPassword',
    ]);
    expect(result).toEqual({ action: 'accept', content: { username: 'ada', password: 'hunter2' } });
  });

  it('coerces a numeric field and keeps an optional field absent', async () => {
    const result = await handleMcpElicitationWithAskUser(
      request({
        port: { type: 'integer', title: 'Port' },
        label: { type: 'string', title: 'Label' },
      }, ['port']),
      async (ask) => ask.question.endsWith('Port')
        ? { type: 'free_text', value: '8080' }
        : { type: 'option', optionIndex: 1, value: 'Cancel' },
    );

    expect(result).toEqual({ action: 'accept', content: { port: 8080 } });
  });

  // "Required-field validation belongs in the dialog, not in a silent decline."
  it('names the required field it did not get, instead of declining silently', async () => {
    const prompts: string[] = [];

    const result = await handleMcpElicitationWithAskUser(
      request({
        username: { type: 'string', title: 'Username' },
        password: { type: 'string', title: 'Password' },
      }, ['username', 'password']),
      async (ask) => {
        prompts.push(ask.question);
        return prompts.length === 1
          ? { type: 'free_text', value: 'ada' }
          : { type: 'option', optionIndex: 1, value: 'Cancel' };
      },
    );

    expect(prompts[2]).toContain('the server requires password');
    expect(result).toEqual({ action: 'decline' });
  });

  it('reports a missing required choice from the batched card', async () => {
    const prompts: string[] = [];

    const result = await handleMcpElicitationWithAskUser(
      request({
        access: { type: 'string', title: 'Access', enum: ['read', 'write'] },
        notify: { type: 'boolean', title: 'Notify' },
      }, ['access', 'notify']),
      async (ask) => {
        prompts.push(ask.question);
        return { type: 'batched', answers: { Access: 'read' } };
      },
    );

    expect(prompts[1]).toContain('the server requires notify');
    expect(result).toEqual({ action: 'decline' });
  });

  it('declines visibly, naming the field, for a shape it cannot render', async () => {
    const prompts: string[] = [];

    const result = await handleMcpElicitationWithAskUser(
      request({ ok: { type: 'boolean' }, blob: { type: 'object' } }),
      async (ask) => {
        prompts.push(ask.question);
        return { type: 'option', optionIndex: 0, value: 'OK' };
      },
    );

    expect(prompts[0]).toContain('the field "blob" has a shape this dialog cannot render');
    expect(result).toEqual({ action: 'decline' });
  });

  it('falls back to a typed value for an enum too wide for the card', async () => {
    const prompts: string[] = [];

    const result = await handleMcpElicitationWithAskUser(
      request({
        region: { type: 'string', title: 'Region', enum: ['a', 'b', 'c', 'd', 'e'] },
        ok: { type: 'boolean', title: 'Confirm' },
      }, ['region']),
      async (ask) => {
        prompts.push(ask.question);
        return ask.allowFreeText
          ? { type: 'free_text', value: 'd' }
          : { type: 'option', optionIndex: 0, value: 'Yes' };
      },
    );

    expect(prompts[0]).toContain('One of: a, b, c, d, e');
    expect(result).toEqual({ action: 'accept', content: { region: 'd', ok: true } });
  });

  it('rejects a typed value outside a wide enum', async () => {
    const result = await handleMcpElicitationWithAskUser(
      request({
        region: { type: 'string', title: 'Region', enum: ['a', 'b', 'c', 'd', 'e'] },
        ok: { type: 'boolean', title: 'Confirm' },
      }, ['region']),
      async (ask) => ask.allowFreeText
        ? { type: 'free_text', value: 'zzz' }
        : { type: 'option', optionIndex: 0, value: 'Yes' },
    );

    expect(result).toEqual({ action: 'decline' });
  });

  it.each([
    ['enum', { pick: { type: 'string', enum: ['a', 'b'] } }, { pick: 'a' }],
    ['boolean', { pick: { type: 'boolean' } }, { pick: true }],
    ['oneOf', { pick: { oneOf: [{ const: 'a', title: 'A' }, { const: 'b', title: 'B' }] } }, { pick: 'a' }],
  ])('leaves the single-field %s shortcut exactly as it was', async (_kind, properties, expected) => {
    const seen: any[] = [];

    const result = await handleMcpElicitationWithAskUser(
      request(properties as Record<string, unknown>, ['pick']),
      async (ask) => {
        seen.push(ask);
        return { type: 'option', optionIndex: 0, value: ask.options[0]! };
      },
    );

    // One legacy single-question card, no `questions` array.
    expect(seen).toHaveLength(1);
    expect(seen[0].questions).toBeUndefined();
    expect(seen[0].question).toBe('Configure the connection');
    expect(result).toEqual({ action: 'accept', content: expected });
  });
});

/**
 * The batched card is only genuinely reused if what this module builds passes
 * R7's own contract validator — the one `pi-agent.ts:4213` and the durable
 * ask-user reducer both run before the card is ever shown.
 */
describe('batched form questions satisfy the R7 contract', () => {
  it('validates against validateAskUserQuestions', async () => {
    let built: any;

    await handleMcpElicitationWithAskUser(
      {
        method: 'elicitation/create',
        params: {
          message: 'Configure',
          requestedSchema: {
            type: 'object',
            properties: {
              access: { type: 'string', title: 'Access', enum: ['read', 'write'] },
              notify: { type: 'boolean', title: 'Notify' },
              tier: { oneOf: [{ const: 'a', title: 'A' }, { const: 'b', title: 'B' }] },
              aVeryLongPropertyNameOverTwelve: { type: 'boolean', title: 'Long' },
            },
          },
        },
      } as any,
      async (ask) => { built = ask; return { type: 'batched', answers: { Access: 'read' } }; },
    );

    expect(() => validateAskUserQuestions(built.questions)).not.toThrow();
    // A property name longer than the 12-char header cap contributes no header.
    expect(built.questions[3]).toEqual({ question: 'Long', options: [{ label: 'Yes' }, { label: 'No' }] });
  });
});
