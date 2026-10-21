/**
 * D1.97 + D1.98 · the flat list, and the three facts it must not merge.
 *
 * The row pair is one build: cron records the session will run later and the
 * background work (watches included) it runs now, as ONE list. What can go
 * wrong is not the mapping — it is the three pairs of facts a flat list invites
 * a reader to collapse:
 *
 *  1. **empty vs unreadable.** A page with no entries and a page the host could
 *     not produce must not render the same sentence, or a panel tells a user
 *     "nothing is running" about a session it never asked.
 *  2. **running vs scheduled.** A cron record is neither running nor finished;
 *     forcing it into a background status would make the panel claim work that
 *     has not started.
 *  3. **a watch vs its name (D1.98).** The row's build line asks for a `watch`
 *     type; the monitor service files every watch under the documented
 *     `monitor` type, so the assertion is that the list carries it through
 *     UNCHANGED rather than that a second name appears.
 */
import { describe, expect, it } from 'bun:test';
import {
  SESSION_SCHEDULED_WORK_EMPTY_LINE,
  SESSION_SCHEDULED_WORK_UNAVAILABLE_LINE,
  formatSessionScheduledWorkReport,
  projectSessionScheduledWork,
  type SessionScheduledWorkPageV1,
} from '../session-scheduled-work.ts';

const page = (entries: ReturnType<typeof projectSessionScheduledWork>): SessionScheduledWorkPageV1 =>
  ({ schemaVersion: 1, entries });

describe('D1.97/D1.98 · projectSessionScheduledWork', () => {
  it('carries a watch through as `monitor`, with its server and tool, and running work before scheduled', () => {
    const entries = projectSessionScheduledWork({
      tasks: [
        { id: 'mon_1', type: 'monitor', status: 'running', description: 'watch the build log', server: 'example.test', tool: 'ws' },
        { id: 'sh_1', type: 'shell', status: 'running', description: 'npm run dev', command: 'npm run dev' },
        { id: 'sub_1', type: 'subagent', status: 'running', description: 'draft the tests', agent_type: 'general-purpose' },
      ],
      crons: [
        { id: 'cron_1', schedule: '0 9 * * *', recurring: true, prompt: 'run the nightly review' },
      ],
    });

    // D1.98: the watch is HERE, under the documented name. No `watch` type is
    // minted — that would be two names for one fact.
    expect(entries.map(entry => entry.type)).toEqual(['monitor', 'shell', 'subagent', 'scheduled']);
    expect(entries.some(entry => entry.type === 'watch')).toBe(false);
    // Running work first, scheduled after it, and the cron row is `scheduled`
    // rather than borrowed from the background statuses.
    expect(entries.map(entry => entry.status)).toEqual(['running', 'running', 'running', 'scheduled']);
    // The hook contract's snake_case is renamed ONCE, here.
    expect(entries[2]).toMatchObject({ agentType: 'general-purpose' });
    expect('agent_type' in entries[2]!).toBe(false);
    expect(entries[0]).toMatchObject({ server: 'example.test', tool: 'ws' });
    expect(entries[3]).toMatchObject({ schedule: '0 9 * * *', recurring: true, description: 'run the nightly review' });
  });

  it('omits the per-kind fields the source did not carry, rather than emitting empty ones', () => {
    const [entry] = projectSessionScheduledWork({
      tasks: [{ id: 'evaluator_1', type: 'quantum_evaluator', status: 'running', description: 'evaluator_1' }],
      crons: [],
    });
    // An unrecognised runtime discriminant survives as itself, exactly as the
    // registry leaves it — the negative half of the `monitor` assertion above.
    expect(entry).toEqual({ id: 'evaluator_1', type: 'quantum_evaluator', status: 'running', description: 'evaluator_1' });
  });
});

describe('D1.97/D1.98 · formatSessionScheduledWorkReport', () => {
  it('says nothing-queued and could-not-be-read with DIFFERENT sentences', () => {
    expect(formatSessionScheduledWorkReport(page([]))).toBe(SESSION_SCHEDULED_WORK_EMPTY_LINE);
    expect(formatSessionScheduledWorkReport({ schemaVersion: 1, entries: [], unavailable: 'not-supported' }))
      .toBe(SESSION_SCHEDULED_WORK_UNAVAILABLE_LINE);
    expect(formatSessionScheduledWorkReport({ schemaVersion: 1, entries: [], unavailable: 'session-not-found' }))
      .toBe(SESSION_SCHEDULED_WORK_UNAVAILABLE_LINE);
    // The pair is the point: two different facts, two different sentences.
    expect(SESSION_SCHEDULED_WORK_EMPTY_LINE).not.toBe(SESSION_SCHEDULED_WORK_UNAVAILABLE_LINE);
  });

  it('spells a one-shot and a repeating record differently, and both sections appear', () => {
    const report = formatSessionScheduledWorkReport(page(projectSessionScheduledWork({
      tasks: [{ id: 'mon_1', type: 'monitor', status: 'running', description: 'watch the build log' }],
      crons: [
        { id: 'cron_1', schedule: '0 9 * * *', recurring: true, prompt: 'nightly review' },
        { id: 'cron_2', schedule: 'in 10 minutes', recurring: false, prompt: 'remind me' },
      ],
    })));
    expect(report).toContain('Background work in this session right now:');
    expect(report).toContain('monitor mon_1 — running — watch the build log');
    expect(report).toContain('Scheduled to run later:');
    // `recurring` is spelled out because the expression does not always say so,
    // and a one-shot read as repeating is the wrong way round for a user
    // deciding whether to cancel it.
    expect(report).toContain('cron_1 — 0 9 * * * (repeats) — nightly review');
    expect(report).toContain('cron_2 — in 10 minutes (once) — remind me');
    // Neither empty sentence may appear beside a real listing.
    expect(report).not.toContain(SESSION_SCHEDULED_WORK_EMPTY_LINE);
    expect(report).not.toContain(SESSION_SCHEDULED_WORK_UNAVAILABLE_LINE);
  });

  it('prints only the section it has, so a running-only session gets no empty heading', () => {
    const runningOnly = formatSessionScheduledWorkReport(page(projectSessionScheduledWork({
      tasks: [{ id: 'sh_1', type: 'shell', status: 'running', description: 'npm run dev' }],
      crons: [],
    })));
    expect(runningOnly).toContain('Background work in this session right now:');
    expect(runningOnly).not.toContain('Scheduled to run later:');

    const scheduledOnly = formatSessionScheduledWorkReport(page(projectSessionScheduledWork({
      tasks: [],
      crons: [{ id: 'cron_1', schedule: '0 9 * * *', recurring: true, prompt: 'nightly review' }],
    })));
    expect(scheduledOnly).toContain('Scheduled to run later:');
    expect(scheduledOnly).not.toContain('Background work in this session right now:');
  });
});
