/**
 * P6.505 — the merge-request watch decides what to read, when, what to say, and
 * what it refuses to do.
 *
 * The assertions that carry the row are the refusals: every request is a GET,
 * and the failure line names both things this product will not do. The rest
 * holds the edge-triggering, which is what separates a notification channel a
 * user keeps from one they mute.
 */
import { describe, expect, it } from 'bun:test';
import {
  MERGE_REQUEST_POLL_MAX_MS,
  MERGE_REQUEST_POLL_MIN_MS,
  MERGE_REQUEST_WATCH_REFUSAL_LINE,
  mergeRequestPollRequests,
  mergeRequestWatchTransition,
  nextMergeRequestPollDelayMs,
  parseMergeRequestRef,
} from './merge-request-watch.ts';

const REF = { origin: 'https://gitlab.example.com', projectPath: 'group/sub/app', iid: 42 };

describe('parseMergeRequestRef', () => {
  it('reads a merge-request URL, including a nested project path', () => {
    expect(parseMergeRequestRef('https://gitlab.example.com/group/sub/app/-/merge_requests/42'))
      .toEqual(REF);
    // A query or a tab suffix is still the same merge request.
    expect(parseMergeRequestRef('https://gitlab.example.com/group/sub/app/-/merge_requests/42/pipelines'))
      .toEqual(REF);
  });

  it('reads the short `path!iid` form only when an origin is supplied', () => {
    expect(parseMergeRequestRef('group/sub/app!42', 'https://gitlab.example.com/')).toEqual(REF);
    // Without an instance there is nothing to poll, and guessing one would be
    // a request to a host the user never named.
    expect(parseMergeRequestRef('group/sub/app!42')).toBeNull();
  });

  it('refuses rather than guesses', () => {
    for (const bad of [
      '',
      '   ',
      'https://gitlab.example.com/group/app/merge_requests/42', // no `/-/` route
      'https://gitlab.example.com/group/app/-/merge_requests/abc',
      'group/app!',
      'just some text',
    ]) {
      expect(parseMergeRequestRef(bad, 'https://gitlab.example.com')).toBeNull();
    }
    // A traversal segment would climb out of the API route.
    expect(parseMergeRequestRef('group/../../admin!1', 'https://gitlab.example.com')).toBeNull();
  });
});

describe('mergeRequestPollRequests', () => {
  it('describes GETs and nothing else — the refusal is the TYPE', () => {
    const requests = mergeRequestPollRequests(REF);

    expect(requests).toHaveLength(2);
    expect(requests.every(request => request.method === 'GET')).toBe(true);
    // `no forge write of any kind is issued`: there is no other method the
    // shape can hold, so this asserts what the type already guarantees and
    // fails loudly if the type is ever widened.
    expect(new Set(requests.map(request => request.method))).toEqual(new Set(['GET']));
  });

  it('encodes the namespaced project path whole, slashes included', () => {
    // GitLab v4 takes `group%2Fsub%2Fapp` as the project id; leaving the slashes
    // raw addresses a different route entirely.
    expect(mergeRequestPollRequests(REF)[0]?.url)
      .toBe('https://gitlab.example.com/api/v4/projects/group%2Fsub%2Fapp/merge_requests/42');
    expect(mergeRequestPollRequests(REF)[1]?.url).toEndWith('/merge_requests/42/pipelines');
  });
});

describe('MERGE_REQUEST_WATCH_REFUSAL_LINE', () => {
  it('names BOTH refusals, so neither can be dropped quietly', () => {
    // Q-den 27 refused auto-fix and auto-merge for different reasons, and a
    // refusal nobody can see is indistinguishable from a defect.
    expect(MERGE_REQUEST_WATCH_REFUSAL_LINE).toContain('not push a fix');
    expect(MERGE_REQUEST_WATCH_REFUSAL_LINE).toContain('not merge');
  });
});

describe('mergeRequestWatchTransition', () => {
  it('announces a settled pipeline once, and never repeats it', () => {
    // A poller that re-announced "failed" every interval is how a channel gets
    // muted — and a muted channel is worse than none, because the user believes
    // they are being watched over.
    const first = mergeRequestWatchTransition(
      { state: 'opened', pipeline: 'running' },
      { state: 'opened', pipeline: 'failed' },
    );
    expect(first.notify).toContain('The pipeline failed.');
    expect(first.notify).toContain(MERGE_REQUEST_WATCH_REFUSAL_LINE);

    const again = mergeRequestWatchTransition(
      { state: 'opened', pipeline: 'failed' },
      { state: 'opened', pipeline: 'failed' },
    );
    expect(again.notify).toBeNull();
  });

  it('is quiet on a first observation that is still running, loud on one already settled', () => {
    expect(mergeRequestWatchTransition(undefined, { state: 'opened', pipeline: 'running' }).notify)
      .toBeNull();
    expect(mergeRequestWatchTransition(undefined, { state: 'opened', pipeline: 'failed' }).notify)
      .toContain('The pipeline failed.');
  });

  it('archives on merged AND on closed — and on nothing else', () => {
    expect(mergeRequestWatchTransition({ state: 'opened' }, { state: 'merged' }))
      .toEqual({ notify: 'The merge request was merged.', archiveSession: true, stopWatching: true });
    expect(mergeRequestWatchTransition({ state: 'opened' }, { state: 'closed' }))
      .toEqual({ notify: 'The merge request was closed.', archiveSession: true, stopWatching: true });
    // The negative that keeps the positive meaningful: a green pipeline is not
    // a merge, and archiving on it would close a session still doing work.
    expect(mergeRequestWatchTransition({ state: 'opened', pipeline: 'running' }, { state: 'opened', pipeline: 'success' }).archiveSession)
      .toBe(false);
    // Nor does a re-observed terminal state archive twice.
    expect(mergeRequestWatchTransition({ state: 'merged' }, { state: 'merged' }))
      .toEqual({ notify: null, archiveSession: false, stopWatching: true });
  });
});

describe('nextMergeRequestPollDelayMs', () => {
  it('starts at the floor and backs off to the ceiling', () => {
    expect(nextMergeRequestPollDelayMs({ state: 'opened' }, 0)).toBe(MERGE_REQUEST_POLL_MIN_MS);
    expect(nextMergeRequestPollDelayMs({ state: 'opened' }, 1)).toBe(MERGE_REQUEST_POLL_MIN_MS * 2);
    expect(nextMergeRequestPollDelayMs({ state: 'opened' }, 5)).toBe(MERGE_REQUEST_POLL_MAX_MS);
    // Never past the ceiling, and never overflowed by an absurd counter.
    expect(nextMergeRequestPollDelayMs({ state: 'opened' }, 9_999)).toBe(MERGE_REQUEST_POLL_MAX_MS);
  });

  it('stops entirely once the merge request is terminal', () => {
    expect(nextMergeRequestPollDelayMs({ state: 'merged' }, 0)).toBeNull();
    expect(nextMergeRequestPollDelayMs({ state: 'closed' }, 0)).toBeNull();
    // A watch that has observed nothing yet still polls — `undefined` is "not
    // asked", not "finished".
    expect(nextMergeRequestPollDelayMs(undefined, 0)).toBe(MERGE_REQUEST_POLL_MIN_MS);
  });
});
