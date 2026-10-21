#!/usr/bin/env python3
"""Emit the phase-2 workflow: one adversarial challenger per unchallenged finding.

Re-runnable. Findings whose verdict is already on disk are skipped, so a run
killed by a session limit or a TaskStop resumes by regenerating and relaunching
— no finding is re-argued and none is lost. Collection is against what was
DISPATCHED, not against what came back: a challenger that dies simply leaves its
finding in the unchallenged state, and the next generation picks it up.

Usage: python3 scripts/build-doc-sweep-challenge-wf.py <output.js>
"""

import json
import os
import sys

REPO = "/Users/i.i.gavrikov/Desktop/work/nessy-desktop"
DATA = f"{REPO}/docs/superpowers/specs/data"
VDIR = f"{DATA}/phase2-verdicts"
PHASE1 = f"{DATA}/2026-07-31-doc-sweep-phase1.json"

PROMPT = r"""Try to REFUTE this claimed divergence between Claude Code's docs and the fork at {repo}.

PAGE: https://code.claude.com/docs/en/{slug}.md
CLAIMED DOC SENTENCE: "{quote}"
CLAIMED BEHAVIOUR: {claim}
CLAIMED OUR STATE: {ourState}
CLAIMED EVIDENCE: {evidence}

Do three things:
1. `curl -sL` the page and confirm the quoted sentence EXISTS VERBATIM. A paraphrase presented as a quote refutes the finding outright. Do NOT use WebFetch — it paraphrases, and that has already cost this project three wrong hook field names. Read the WHOLE line you find it on: several defects in this series hid in the second sentence of a two-sentence line, where the second half reverses the conclusion.
2. Open the cited file:line in our repo and confirm it says what was claimed. Use codegraph_explore or Read. Note that several files here carry a NUL byte and plain grep SKIPS them silently — pass `-a` for any absence claim.
3. Look one layer up and one layer down. This repo's audit history says the recurring false positive is "the identifier really is unwired, but the consequence is false because something upstream already handled it" — and its mirror, an identically-named symbol in a sibling subsystem (`disallowed-tools` is enforced for subagents and not for skills; naming the wrong subsystem is a refutation). Verify the CONSEQUENCE separately from the identifier.

Also check {repo}/docs/superpowers/specs/2026-07-29-inert-worklist.md section 3: nine dated owner decisions live there. If this "gap" is one of them, it is a recorded decision with a reason, not a defect — refute it and say which. Same for a deliberate product difference: this fork drops Claude/ChatGPT subscription flows, targets a corporate gateway, and is renamed throughout (NESSY_ prefixes, package scope, binary names). A finding that is really one of those is refuted.

Default to refuted=true when you cannot positively confirm all three. An unchallenged claim is weaker evidence than a challenged one.

MANDATORY LAST STEP — persist your verdict before you return. The run may be stopped or hit a session limit at any moment, and a verdict that exists only in your reply is lost. Write {vdir}/{fid}.json with exactly these keys:

  {{"id": "{fid}", "slug": "{slug}", "refuted": <true|false>, "why": "<your reasoning>", "correctedState": "<corrected statement, or empty string>"}}

Use a quoted heredoc so the shell does not touch the content:

  cat > {vdir}/{fid}.json <<'JSON'
  ...your JSON...
  JSON

Then verify it parses: `python3 -m json.tool {vdir}/{fid}.json`. If it does not parse, fix it and re-verify. Only then return the same verdict as your structured output."""

VERDICT_SCHEMA = {
    "type": "object",
    "required": ["refuted", "why"],
    "properties": {
        "refuted": {"type": "boolean"},
        "why": {"type": "string"},
        "correctedState": {"type": "string"},
    },
}


def main():
    out_path = sys.argv[1]
    flagged = json.load(open(PHASE1))["flagged"]
    os.makedirs(VDIR, exist_ok=True)
    done = {n[:-5] for n in os.listdir(VDIR) if n.endswith(".json")}

    items = []
    for i, f in enumerate(flagged):
        fid = "f%03d" % i
        if fid in done:
            continue
        items.append({
            "id": fid, "slug": f["slug"],
            "prompt": PROMPT.format(repo=REPO, vdir=VDIR, fid=fid, slug=f["slug"],
                                    quote=f["quote"], claim=f["claim"],
                                    ourState=f["ourState"], evidence=f["evidence"]),
        })

    script = """export const meta = {
  name: 'claude-doc-sweep-challenge',
  description: 'Challenge the still-unchallenged doc-sweep findings, persisting each verdict to disk',
  phases: [{ title: 'Challenge', detail: 'one adversarial refuter per finding' }],
}

const VDIR = %(vdir)s
const ITEMS = %(items)s
const VERDICT_SCHEMA = %(schema)s

phase('Challenge')
log(`${ITEMS.length} findings still unchallenged; each verdict lands in ${VDIR} the moment it is reached`)

const challenged = await parallel(
  ITEMS.map((it) => () =>
    agent(it.prompt, { label: `challenge:${it.id}:${it.slug}`, phase: 'Challenge', schema: VERDICT_SCHEMA })
      .then((v) => ({ id: it.id, verdict: v })),
  ),
)

const ok = challenged.filter((c) => c && c.verdict)
log(`${ok.filter((c) => !c.verdict.refuted).length} survived, ${ok.filter((c) => c.verdict.refuted).length} refuted, ${challenged.length - ok.length} died`)

return {
  dispatched: ITEMS.length,
  returned: ok.length,
  survived: ok.filter((c) => !c.verdict.refuted).length,
  refuted: ok.filter((c) => c.verdict.refuted).length,
  died: challenged.length - ok.length,
}
""" % {"vdir": json.dumps(VDIR),
       "items": json.dumps(items, ensure_ascii=False),
       "schema": json.dumps(VERDICT_SCHEMA)}

    open(out_path, "w").write(script)
    print(f"on disk {len(done)} · dispatching {len(items)} · total {len(flagged)}")
    print(f"wrote {out_path}")


if __name__ == "__main__":
    main()
