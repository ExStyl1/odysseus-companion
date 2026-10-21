import type { AskUserAnswer, AskUserPermissionRequest, AskUserQuestionItem } from '@nessy-agent/core/types';
import { ASK_USER_MAX_HEADER_CHARS } from '@nessy-agent/core/utils';
import type { ElicitRequest, ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpElicitationAction } from '../automations/types.ts';
import { classifyExternalUrl } from '../utils/url-safety.ts';
import { openUrl } from '../utils/open-url.ts';
import { analyzeConsentUrl } from './url-consent.ts';

type AskUserFn = (request: AskUserPermissionRequest) => Promise<AskUserAnswer>;

/** A hook's answer to an elicitation (hooks.md §Elicitation `hookSpecificOutput`). */
export interface McpElicitationHookDecision {
  action: McpElicitationAction;
  content?: Record<string, unknown>;
}

export interface McpElicitationOptions {
  /**
   * Browser opener for URL-mode elicitation. Defaults to the repo's single
   * `openUrl` seam (`utils/open-url.ts` → Electron `shell.openExternal`, with
   * the `open` package as the non-Electron fallback); injectable so tests never
   * launch a real browser.
   */
  openUrl?: (url: string) => Promise<void>;
  /**
   * The `Elicitation` hook (hooks.md §Elicitation), consulted BEFORE any
   * dialog. Returning an action answers the MCP server directly — the dialog
   * is then never opened, for any action, including an `accept` whose content
   * turns out not to satisfy the schema.
   */
  beforeDialog?: (request: ElicitRequest) => Promise<McpElicitationHookDecision | undefined>;
  /**
   * The `ElicitationResult` hook (`hooks.md:2760`), consulted AFTER the user
   * answers and BEFORE the response reaches the server.
   *
   * Receives the user's `action` as well as their values, because the
   * documented input carries `action` and the documented output "Overrides the
   * user's action" (`:2799`) — so it must see a decline too, not only an
   * accept, or the field would be a constant.
   */
  afterAnswer?: (
    outcome: { action: McpElicitationAction; content: ElicitContent },
  ) => Promise<McpElicitationHookDecision | undefined>;
}

/** Required property names of a form request's schema; `[]` for URL mode. */
function requiredFields(params: ElicitRequest['params']): string[] {
  if (!('requestedSchema' in params)) return [];
  const required = (params.requestedSchema as { required?: unknown }).required;
  return Array.isArray(required) ? required.filter((name): name is string => typeof name === 'string') : [];
}

/**
 * Turn a hook decision into the MCP response.
 *
 * A non-accept passes straight through. An `accept` must carry every required
 * field of the schema — the hook is answering in the user's place, and a
 * partial accept would be an invalid response to the server. When it does not,
 * the answer degrades to `decline`: re-opening the dialog is not available
 * here, because a hook that returned an action has already decided that no
 * dialog is shown.
 */
function hookDecisionToResult(
  decision: McpElicitationHookDecision,
  params: ElicitRequest['params'],
): ElicitResult {
  if (decision.action !== 'accept') return { action: decision.action };
  const content = decision.content;
  if (!isElicitContent(content)) return { action: 'decline' };
  const missing = requiredFields(params).filter(name => content[name] === undefined);
  if (missing.length > 0) return { action: 'decline' };
  return { action: 'accept', content };
}

type ElicitationField = {
  type?: string;
  title?: string;
  enum?: unknown[];
  enumNames?: unknown[];
  oneOf?: Array<{ const?: unknown; title?: unknown }>;
};

type ElicitContentValue = string | number | boolean | string[];
/** The values an MCP elicitation may carry back; also the `user_response` shape. */
export type ElicitContent = Record<string, ElicitContentValue>;
type AnswerMapper = (answer: AskUserAnswer) => ElicitContent | null;

interface AskUserPlan {
  request: AskUserPermissionRequest;
  mapAnswer: AnswerMapper;
  /** Returns a user-facing reason when the mapped content is not sendable. */
  validate?: (content: ElicitContent) => string | null;
}

/**
 * One `requestedSchema` property, reduced to how it can be asked.
 *
 * `choice` is a 2-4 way pick (enum, `oneOf`, boolean) — the shape R7's batched
 * question card is built for. `text` is anything the user has to type.
 */
type FieldPlan =
  | { kind: 'choice'; name: string; label: string; options: string[]; values: ElicitContentValue[] }
  | { kind: 'text'; name: string; label: string; numeric: boolean; allowed?: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValues(values: unknown[] | undefined): string[] {
  return (values ?? []).filter((value): value is string => typeof value === 'string');
}

function isElicitContent(value: unknown): value is ElicitContent {
  if (!isRecord(value)) return false;
  return Object.values(value).every(item => {
    return typeof item === 'string'
      || typeof item === 'number'
      || typeof item === 'boolean'
      || (Array.isArray(item) && item.every(entry => typeof entry === 'string'));
  });
}

function optionAnswerIndex(answer: AskUserAnswer, options: string[]): number | null {
  if (answer.type !== 'option') return null;
  const expected = options[answer.optionIndex];
  return expected !== undefined && answer.value === expected ? answer.optionIndex : null;
}

function planSingleField(message: string, fieldName: string, field: ElicitationField): AskUserPlan | null {
  const enumValues = stringValues(field.enum);
  if (enumValues.length >= 2 && enumValues.length <= 4) {
    const enumNames = stringValues(field.enumNames);
    const options = enumNames.length === enumValues.length ? enumNames : enumValues;
    return {
      request: { question: message, options, allowFreeText: false },
      mapAnswer(answer) {
        const index = optionAnswerIndex(answer, options);
        const value = index === null ? undefined : enumValues[index];
        return value === undefined ? null : { [fieldName]: value };
      },
    };
  }

  const oneOfValues = (field.oneOf ?? [])
    .map(item => ({
      value: typeof item.const === 'string' ? item.const : null,
      label: typeof item.title === 'string' ? item.title : typeof item.const === 'string' ? item.const : null,
    }))
    .filter((item): item is { value: string; label: string } => item.value !== null && item.label !== null);
  if (oneOfValues.length >= 2 && oneOfValues.length <= 4) {
    const options = oneOfValues.map(item => item.label);
    return {
      request: { question: message, options, allowFreeText: false },
      mapAnswer(answer) {
        const index = optionAnswerIndex(answer, options);
        return index === null ? null : { [fieldName]: oneOfValues[index]!.value };
      },
    };
  }

  if (field.type === 'boolean') {
    const options = ['Yes', 'No'];
    return {
      request: { question: message, options, allowFreeText: false },
      mapAnswer(answer) {
        const index = optionAnswerIndex(answer, options);
        return index === null ? null : { [fieldName]: index === 0 };
      },
    };
  }

  if (field.type === 'string') {
    const options = ['Submit value', 'Cancel'];
    return {
      request: { question: message, options, allowFreeText: true },
      mapAnswer(answer) {
        if (answer.type === 'free_text' && answer.value.trim()) {
          return { [fieldName]: answer.value };
        }
        return null;
      },
    };
  }

  return null;
}

function elicitationMessage(params: ElicitRequest['params']): string {
  return String(params.message || 'MCP server requests input.');
}

/**
 * URL-mode elicitation carries a server-supplied string on its way to
 * `shell.openExternal`, so it is untrusted input reaching an OS protocol
 * dispatcher. Two gates, both required:
 *
 * 1. `classifyExternalUrl` — the repo's existing blocklist (`javascript:`,
 *    `data:`, `file:`, …), so this path inherits any scheme blocked there.
 * 2. An http(s) allowlist on top of it. The blocklist is calibrated for
 *    user-authored links, where passing `obsidian://`/`vscode://` through is
 *    the point; for a string an MCP server chose it is far too permissive, and
 *    `mcp.md:1089` only ever describes "a browser URL".
 *
 * Returns the normalised href, or `null` when the URL must not be opened.
 */
export function safeHttpUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  if (classifyExternalUrl(raw).kind !== 'safe-external') return null;
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return parsed.href;
}

const OPEN_OPTION = 'Open separately';
const CONFIRM_OPTION = 'I completed it';
const CANCEL_OPTION = 'Cancel';

/** Tell the user why a request was refused, then decline it — never silently. */
async function declineVisibly(
  askUser: AskUserFn,
  message: string,
  reason: string,
): Promise<ElicitResult> {
  await askUser({
    question: `${message}\n\n${reason}`,
    options: ['OK'],
    allowFreeText: false,
  });
  return { action: 'decline' };
}

/**
 * URL mode (`mcp.md:1089`): "Claude Code opens a browser URL for authentication
 * or approval. Complete the flow in the browser, then confirm in the CLI."
 *
 * Two dialogs, because the confirm step is what tells the server the browser
 * flow finished: the first offers to open, the second confirms afterwards.
 * Only an explicit cancel (or a refused URL) declines.
 */
async function handleUrlElicitation(
  params: ElicitRequest['params'],
  askUser: AskUserFn,
  open: (url: string) => Promise<void>,
): Promise<ElicitResult> {
  const message = elicitationMessage(params);
  const url = safeHttpUrl((params as { url?: unknown }).url);
  if (!url) {
    return declineVisibly(
      askUser,
      message,
      'Refused: this server did not supply an http(s) URL to open.',
    );
  }

  // The consent panel rides the SAME request as the open/cancel choice, which is
  // what `elicitation.md:729`-`:730` require of it: the domain highlight and the
  // suspicious-URI warning are inputs to this decision, so they cannot arrive on
  // a later dialog or below the buttons. `question` keeps the full URL in text,
  // so a client that ignores `urlConsent` still satisfies the `:726` MUST.
  const urlConsent = analyzeConsentUrl(url);
  const openAnswer = await askUser({
    question: `${message}\n\n${url}`,
    options: [OPEN_OPTION, CANCEL_OPTION],
    allowFreeText: false,
    ...(urlConsent ? { urlConsent } : {}),
  });
  if (optionAnswerIndex(openAnswer, [OPEN_OPTION, CANCEL_OPTION]) !== 0) {
    return { action: 'decline' };
  }

  try {
    await open(url);
  } catch {
    return declineVisibly(askUser, message, 'Refused: the URL could not be opened.');
  }

  const confirmAnswer = await askUser({
    question: `${message}\n\nComplete the flow in your browser, then confirm here.`,
    options: [CONFIRM_OPTION, CANCEL_OPTION],
    allowFreeText: false,
  });
  return optionAnswerIndex(confirmAnswer, [CONFIRM_OPTION, CANCEL_OPTION]) === 0
    ? { action: 'accept' }
    : { action: 'decline' };
}

const MAX_BATCHED_QUESTIONS = 4;
const SUBMIT_OPTION = 'Submit value';

/** Reduce one schema property to a `FieldPlan`, or `null` when it cannot be asked. */
function planField(name: string, field: ElicitationField): FieldPlan | null {
  const label = typeof field.title === 'string' && field.title.trim() ? field.title : name;

  const enumValues = stringValues(field.enum);
  if (enumValues.length >= 2) {
    const enumNames = stringValues(field.enumNames);
    const options = enumNames.length === enumValues.length ? enumNames : enumValues;
    // Past four choices the card has no room; the value is typed instead and
    // checked against the same allowed set.
    return enumValues.length <= 4
      ? { kind: 'choice', name, label, options, values: enumValues }
      : { kind: 'text', name, label, numeric: false, allowed: enumValues };
  }

  const oneOf = (field.oneOf ?? [])
    .map(item => ({
      value: typeof item.const === 'string' ? item.const : null,
      title: typeof item.title === 'string' ? item.title : typeof item.const === 'string' ? item.const : null,
    }))
    .filter((item): item is { value: string; title: string } => item.value !== null && item.title !== null);
  if (oneOf.length >= 2 && oneOf.length <= 4) {
    return { kind: 'choice', name, label, options: oneOf.map(item => item.title), values: oneOf.map(item => item.value) };
  }

  if (field.type === 'boolean') {
    return { kind: 'choice', name, label, options: ['Yes', 'No'], values: [true, false] };
  }
  if (field.type === 'string') return { kind: 'text', name, label, numeric: false };
  if (field.type === 'number' || field.type === 'integer') {
    return { kind: 'text', name, label, numeric: true };
  }
  return null;
}

/** Coerce one typed answer onto its field, or `undefined` when it does not fit. */
function textFieldValue(plan: Extract<FieldPlan, { kind: 'text' }>, raw: string): ElicitContentValue | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  if (plan.allowed) return plan.allowed.includes(value) ? value : undefined;
  if (!plan.numeric) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Name the required fields the user left unanswered, for a visible decline. */
function missingRequired(content: ElicitContent, required: string[]): string | null {
  const missing = required.filter(name => content[name] === undefined);
  return missing.length > 0
    ? `Not sent: the server requires ${missing.join(', ')}, which ${missing.length === 1 ? 'was' : 'were'} left unanswered.`
    : null;
}

/**
 * Render an all-choice schema through R7's batched question card — the surface
 * that already ships (`AskUserPermissionRequest.questions`, rendered by
 * `AskUserRequest.tsx`), rather than a second dialog system.
 *
 * Question TEXT is the answer key in the documented envelope, so it doubles as
 * the field label and is disambiguated with the property name when two fields
 * share a title.
 */
function buildBatchedFormPlan(message: string, plans: FieldPlan[], required: string[]): AskUserPlan {
  const texts = new Set<string>();
  const keyed = plans.map(plan => {
    const text = texts.has(plan.label) ? `${plan.label} (${plan.name})` : plan.label;
    texts.add(text);
    return { plan, text };
  });

  const questions: AskUserQuestionItem[] = keyed.map(({ plan, text }) => ({
    question: text,
    ...(plan.name.length <= ASK_USER_MAX_HEADER_CHARS ? { header: plan.name } : {}),
    options: (plan as Extract<FieldPlan, { kind: 'choice' }>).options.map(label => ({ label })),
  }));

  return {
    request: {
      question: message,
      // Legacy projection for downgraded consumers: the first question's options.
      options: questions[0]!.options.map(option => option.label),
      allowFreeText: false,
      questions,
    },
    mapAnswer(answer) {
      if (answer.type !== 'batched') return null;
      const content: ElicitContent = {};
      for (const { plan, text } of keyed) {
        if (plan.kind !== 'choice') continue;
        const raw = answer.answers[text];
        const picked = Array.isArray(raw) ? raw[0] : raw;
        if (typeof picked !== 'string') continue;
        // Only a real option counts. Free text typed into a choice field is not
        // a schema value, so it is dropped and the required check reports it.
        const index = plan.options.indexOf(picked);
        if (index >= 0) content[plan.name] = plan.values[index]!;
      }
      return content;
    },
    validate: content => missingRequired(content, required),
  };
}

/**
 * Ask a form one field at a time, through the single-question surface this
 * module already uses for a lone `string` field.
 *
 * This is the path for any schema with a field the user must TYPE. R7's batched
 * card cannot carry one: its answers ARE option labels, and
 * `validateAskUserQuestions` requires 2-4 options on every question, so a
 * free-text field has no legal representation there. See the report for detail.
 */
async function handleSequentialForm(
  message: string,
  plans: FieldPlan[],
  required: string[],
  askUser: AskUserFn,
): Promise<ElicitResult> {
  const content: ElicitContent = {};

  for (const plan of plans) {
    const prompt = `${message}\n\n${plan.label}`;
    if (plan.kind === 'choice') {
      const answer = await askUser({
        question: prompt,
        options: [...plan.options, CANCEL_OPTION].slice(0, 4),
        allowFreeText: false,
      });
      const index = answer.type === 'option' ? plan.options.indexOf(answer.value) : -1;
      if (index >= 0) content[plan.name] = plan.values[index]!;
      continue;
    }

    const answer = await askUser({
      question: plan.allowed ? `${prompt}\n\nOne of: ${plan.allowed.join(', ')}` : prompt,
      options: [SUBMIT_OPTION, CANCEL_OPTION],
      allowFreeText: true,
    });
    if (answer.type !== 'free_text') continue;
    const value = textFieldValue(plan, answer.value);
    if (value !== undefined) content[plan.name] = value;
  }

  const problem = missingRequired(content, required);
  if (problem) return declineVisibly(askUser, message, problem);
  return { action: 'accept', content };
}

/** How a form request will be asked. */
type FormRoute =
  | { kind: 'plan'; plan: AskUserPlan }
  | { kind: 'sequential'; plans: FieldPlan[]; required: string[] }
  | { kind: 'unrenderable'; reason: string };

/**
 * Choose the surface for a form request.
 *
 * The single-field shortcuts come first and are untouched — they are good UX
 * and there are tests on them. Everything else used to fall through to "reply
 * with a JSON object", where a typo silently became a decline.
 */
function routeFormElicitation(params: ElicitRequest['params']): FormRoute {
  const message = elicitationMessage(params);
  if (!('requestedSchema' in params)) {
    return { kind: 'unrenderable', reason: 'Refused: this server sent no form schema to fill in.' };
  }

  const schema = params.requestedSchema;
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const entries = Object.entries(properties);
  const required = requiredFields(params);

  if (entries.length === 1) {
    const [fieldName, rawField] = entries[0]!;
    if (isRecord(rawField)) {
      const plan = planSingleField(message, fieldName, rawField as ElicitationField);
      if (plan) return { kind: 'plan', plan };
    }
  }

  if (entries.length === 0) {
    return { kind: 'unrenderable', reason: 'Refused: this server asked for a form with no fields.' };
  }

  const plans: FieldPlan[] = [];
  for (const [name, rawField] of entries) {
    const plan = isRecord(rawField) ? planField(name, rawField as ElicitationField) : null;
    if (!plan) {
      return {
        kind: 'unrenderable',
        reason: `Refused: the field "${name}" has a shape this dialog cannot render.`,
      };
    }
    plans.push(plan);
  }

  // R7's batched card carries a whole all-choice form in one surface. A field
  // the user must TYPE has no legal representation there (its answers are
  // option labels, and every question needs 2-4 options), so those forms are
  // asked field by field through the single-question surface instead.
  return plans.length <= MAX_BATCHED_QUESTIONS && plans.every(plan => plan.kind === 'choice')
    ? { kind: 'plan', plan: buildBatchedFormPlan(message, plans, required) }
    : { kind: 'sequential', plans, required };
}

/**
 * `ElicitationResult` (`hooks.md:2758`): "Runs after a user responds to an MCP
 * elicitation. Hooks can observe, modify, or block the response before it is
 * sent back to the MCP server."
 *
 * Fires for a real user answer — accept or decline. It deliberately does NOT
 * fire for the `cancel` this module returns, which is the abort/teardown path
 * (`askUser` threw) rather than something the user chose; nor for the refusals
 * we generate INSTEAD of a usable answer (unrenderable schema, missing required
 * field), where letting a hook accept would send values the user never gave for
 * a form we could not even render.
 *
 * OVERRIDE SEMANTICS — `content` is a PER-FIELD override, not a replacement.
 * `:2800` says only "Overrides form field values", which does not settle it, so
 * this is a decision on record:
 *
 * - The wording differs between the two events on purpose. `Elicitation`'s
 *   `content` is "Form field values to submit" (`:2754`) — the whole form,
 *   because nothing exists yet. `ElicitationResult`'s is "Overrides form field
 *   values" — something already exists and is being overridden, per field.
 * - The doc's own `ElicitationResult` example passes `content: {}` as inert
 *   filler alongside a decline. That is only harmless under a per-field
 *   reading; under replacement it would mean "submit an empty form".
 * - It is the safer reading if a hook author guesses wrong. Under per-field, an
 *   author who assumed replacement and lists every field still gets exactly
 *   what they intended. Under replacement, an author who assumed per-field and
 *   names one field silently drops everything the user typed.
 *
 * The residual risk is the mirror case: a hook that wants to REMOVE a field
 * cannot, because omission means "keep". That case has a documented answer of
 * its own — `action: "decline"`.
 */
async function applyResultHook(
  result: ElicitResult,
  options: McpElicitationOptions | undefined,
): Promise<ElicitResult> {
  const afterAnswer = options?.afterAnswer;
  if (!afterAnswer || (result.action !== 'accept' && result.action !== 'decline')) return result;

  const userContent = isElicitContent(result.content) ? result.content : {};
  const decision = await afterAnswer({ action: result.action, content: userContent });
  if (!decision) return result;
  if (decision.action !== 'accept') return { action: decision.action };

  const merged = { ...userContent, ...(decision.content ?? {}) };
  // A hook that supplies an unsendable value refuses the answer visibly rather
  // than putting a malformed accept on the wire.
  if (!isElicitContent(merged)) return { action: 'decline' };
  // URL mode accepts with no content at all; keep it that way.
  return Object.keys(merged).length === 0 ? { action: 'accept' } : { action: 'accept', content: merged };
}

export async function handleMcpElicitationWithAskUser(
  request: ElicitRequest,
  askUser: AskUserFn,
  options?: McpElicitationOptions,
): Promise<ElicitResult> {
  try {
    // hooks.md §Elicitation: the hook runs before anything is shown, and its
    // action replaces the dialog rather than racing it.
    const hookDecision = await options?.beforeDialog?.(request);
    if (hookDecision) return hookDecisionToResult(hookDecision, request.params);

    if (request.params.mode === 'url') {
      const urlResult = await handleUrlElicitation(request.params, askUser, options?.openUrl ?? openUrl);
      return await applyResultHook(urlResult, options);
    }

    const message = elicitationMessage(request.params);
    const route = routeFormElicitation(request.params);
    if (route.kind === 'unrenderable') {
      return await declineVisibly(askUser, message, route.reason);
    }
    if (route.kind === 'sequential') {
      return await applyResultHook(
        await handleSequentialForm(message, route.plans, route.required, askUser),
        options,
      );
    }

    const answer = await askUser(route.plan.request);
    const content = route.plan.mapAnswer(answer);
    // A user decline IS a response, and `ElicitationResult` is documented to
    // receive the user's `action` and to be able to override it — so it goes
    // through the hook rather than returning early.
    if (!content) return await applyResultHook({ action: 'decline' }, options);
    const problem = route.plan.validate?.(content);
    if (problem) return await declineVisibly(askUser, message, problem);
    return await applyResultHook({ action: 'accept', content }, options);
  } catch {
    // An askUser rejection is the abort/teardown path, not a user decision.
    return { action: 'cancel' };
  }
}
