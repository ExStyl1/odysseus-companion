/**
 * P6.505 — watching a merge request's pipeline, and the two things this
 * product will not do with what it sees.
 *
 * ## The decision this module encodes
 *
 * Q-den 27 = **option A: status and notification ONLY.** The two options it
 * refused are refused here structurally rather than merely unimplemented:
 *
 * - **Auto-fix** (iterate on a red pipeline and push) — refused because
 *   unattended pushes are a side effect no permission prompt sees, and the
 *   ledger has no receipt shape for them.
 * - **Auto-merge on green** — refused outright: an agent that merges is a
 *   product posture, not a feature.
 *
 * So every request this module can describe is a **GET**. Not by convention —
 * {@link MergeRequestReadRequest} has no other `method` to hold, so a writing
 * call site cannot be typed at all. The row's *"no forge write of any kind is
 * issued"* becomes a property of the type instead of a promise in prose, which
 * is the difference between a rule and a habit.
 *
 * ## Native mechanism — measured, and there is none
 *
 * Confirmed at HEAD, and the row's own re-measurement reproduces: over
 * `packages/` + `apps/`, `autofix` → 0, `autoMerge|auto-merge` → 0,
 * `pipelineStatus|checkRun|ciStatus` → 0. No runtime publishes a forge status
 * channel; upstream drives this with the `gh` CLI from the host, and our
 * contour is GitLab. `dpGitlab` exists in the developer harness and in **zero**
 * product files — and it is not the answer here anyway, because an MCP tool is
 * called by the MODEL, and the whole point of option A is that the agent never
 * acts on what it sees. A host poller reading a merge request the user already
 * has access to is the only shape that keeps that promise.
 *
 * ## What this module is, and what it is NOT
 *
 * It is the half that can be decided without a network: what to read, how often
 * to read it, when a notification is owed, when the session may auto-archive,
 * and what the surface must say about the refusals. It is pure, so all of that
 * is testable with no credential and no forge.
 *
 * It is **not** the transport. Binding a session to a merge request, holding a
 * token, and running the timer belong to the separate forge/git-UI plan DR-2
 * routed them to (`plan :1145`), and the row carries that scope note. This
 * module is the interface that plan consumes; the reason it is written now is
 * that the DECISIONS above are the part that must not be re-derived by whoever
 * builds the transport.
 */

/** A merge request, identified the way GitLab identifies one. */
export interface MergeRequestRef {
  /** Instance origin, e.g. `https://gitlab.example.com`. No trailing slash. */
  origin: string;
  /** Full project path, e.g. `group/subgroup/project`. */
  projectPath: string;
  /** The project-scoped iid, which is what a `!123` reference means. */
  iid: number;
}

/**
 * A read this module is allowed to describe.
 *
 * `method` is the literal `'GET'` and nothing else — see the header. The type
 * is the refusal.
 */
export interface MergeRequestReadRequest {
  readonly method: 'GET';
  readonly url: string;
}

/** What a poll observed. Every field is optional: a poll can fail. */
export interface MergeRequestObservation {
  /** GitLab's `merge_requests.state`. */
  state?: 'opened' | 'merged' | 'closed' | 'locked';
  /** GitLab's `pipeline.status` for the MR's head. */
  pipeline?: 'created' | 'pending' | 'running' | 'success' | 'failed' | 'canceled' | 'skipped' | 'manual';
}

/**
 * The disclosure the row's title is half about — *"the status surface says
 * nothing about what it will not do"*.
 *
 * A refusal nobody can see is indistinguishable from a defect, and worse here
 * than elsewhere: a user who believes the agent is fixing the build will not
 * look at it. So the sentence is a constant, it names both refusals, and a test
 * asserts it names both — a future edit cannot quietly drop one.
 */
export const MERGE_REQUEST_WATCH_REFUSAL_LINE =
  'This session only watches the pipeline. It will not push a fix and it will not merge — a red build is yours to act on.';

/** Terminal merge-request states: nothing after these is worth polling for. */
const TERMINAL_STATES: ReadonlySet<string> = new Set(['merged', 'closed']);

/** Pipeline states that have settled. `manual` has not — it awaits a person. */
const SETTLED_PIPELINES: ReadonlySet<string> = new Set(['success', 'failed', 'canceled', 'skipped']);

/**
 * Parse `https://<host>/<project path>/-/merge_requests/<iid>` or
 * `<project path>!<iid>` (with an explicit origin for the second form).
 *
 * Returns `null` rather than throwing, and rejects rather than guesses: an
 * unparseable reference must not become a poll against an invented URL. The
 * `/-/` separator is GitLab's own and is what distinguishes a project path
 * containing the word `merge_requests` from the route.
 */
export function parseMergeRequestRef(input: string, defaultOrigin?: string): MergeRequestRef | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const urlMatch = /^(https?:\/\/[^/]+)\/(.+?)\/-\/merge_requests\/(\d+)(?:[/?#].*)?$/.exec(trimmed);
  if (urlMatch) {
    const [, origin, projectPath, iid] = urlMatch as unknown as [string, string, string, string];
    return { origin: origin.replace(/\/+$/, ''), projectPath, iid: Number(iid) };
  }

  const shortMatch = /^([A-Za-z0-9._~\-/]+)!(\d+)$/.exec(trimmed);
  if (shortMatch && defaultOrigin) {
    const [, projectPath, iid] = shortMatch as unknown as [string, string, string];
    // A path segment of `.` or `..` would climb out of the API route.
    if (projectPath.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) return null;
    return { origin: defaultOrigin.replace(/\/+$/, ''), projectPath, iid: Number(iid) };
  }

  return null;
}

/**
 * The two reads one poll performs, and the only two this module can express.
 *
 * `projectPath` is URL-encoded whole, including its slashes, because that is
 * how GitLab's v4 API takes a namespaced project id.
 */
export function mergeRequestPollRequests(ref: MergeRequestRef): readonly MergeRequestReadRequest[] {
  const project = encodeURIComponent(ref.projectPath);
  const base = `${ref.origin}/api/v4/projects/${project}/merge_requests/${ref.iid}`;
  return Object.freeze([
    Object.freeze({ method: 'GET' as const, url: base }),
    Object.freeze({ method: 'GET' as const, url: `${base}/pipelines` }),
  ]);
}

/** What one observed transition asks the host to do. */
export interface MergeRequestWatchAction {
  /** A user-facing line, or `null` when nothing changed worth saying. */
  notify: string | null;
  /** Whether the session may be archived — merged or closed only. */
  archiveSession: boolean;
  /** Whether to stop polling. Terminal states are terminal. */
  stopWatching: boolean;
}

/**
 * Decide what a new observation means, given the previous one.
 *
 * EDGE-TRIGGERED, and that is the whole design. A poller that notified on
 * "pipeline is failed" would say it again every interval for as long as the
 * build stayed red, which is how a notification channel gets muted — and a
 * muted channel is worse than none, because the user now believes they are
 * being watched over. So a line is produced only where the observation DIFFERS
 * from the one before it.
 *
 * The first observation (`previous` undefined) is deliberately quiet for a
 * running pipeline and loud for a settled one: binding a session to an MR whose
 * build already failed should say so immediately, but announcing "pipeline is
 * running" the moment you bind is noise.
 */
export function mergeRequestWatchTransition(
  previous: MergeRequestObservation | undefined,
  next: MergeRequestObservation,
): MergeRequestWatchAction {
  const terminal = next.state !== undefined && TERMINAL_STATES.has(next.state);
  const stateChanged = previous?.state !== next.state;
  const pipelineChanged = previous?.pipeline !== next.pipeline;

  if (terminal && stateChanged) {
    return {
      notify: next.state === 'merged'
        ? 'The merge request was merged.'
        : 'The merge request was closed.',
      // Auto-archive on merge OR close, which is the row's own `done_means`:
      // both mean the work this session was doing is over. It archives the
      // session; it does not touch the forge.
      archiveSession: true,
      stopWatching: true,
    };
  }

  if (pipelineChanged && next.pipeline !== undefined && SETTLED_PIPELINES.has(next.pipeline)) {
    const notify = next.pipeline === 'success'
      ? 'The pipeline passed.'
      : next.pipeline === 'failed'
        ? `The pipeline failed. ${MERGE_REQUEST_WATCH_REFUSAL_LINE}`
        : `The pipeline was ${next.pipeline}.`;
    return { notify, archiveSession: false, stopWatching: false };
  }

  return { notify: null, archiveSession: false, stopWatching: terminal };
}

/** The floor and the ceiling of the poll cadence. */
export const MERGE_REQUEST_POLL_MIN_MS = 15_000;
export const MERGE_REQUEST_POLL_MAX_MS = 5 * 60_000;

/**
 * How long to wait before the next poll.
 *
 * Fast while something is moving, slow once it is not. `null` means stop.
 *
 * The backoff is on UNCHANGED polls rather than on elapsed time, because the
 * thing being economised is other people's CI server: a merge request nobody is
 * touching should cost one request every five minutes, and one that just went
 * green should be re-read promptly. Doubling from the floor reaches the ceiling
 * in five unchanged polls, so a stalled watch is cheap within about two
 * minutes.
 */
export function nextMergeRequestPollDelayMs(
  observation: MergeRequestObservation | undefined,
  consecutiveUnchangedPolls: number,
): number | null {
  if (observation?.state !== undefined && TERMINAL_STATES.has(observation.state)) return null;
  const doublings = Math.max(0, Math.min(consecutiveUnchangedPolls, 16));
  const delay = MERGE_REQUEST_POLL_MIN_MS * 2 ** doublings;
  return Math.min(delay, MERGE_REQUEST_POLL_MAX_MS);
}
