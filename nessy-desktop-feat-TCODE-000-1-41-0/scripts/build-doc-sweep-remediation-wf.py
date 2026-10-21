#!/usr/bin/env python3
"""Emit the phase-2.5 workflow: one remediation spec per SURVIVING finding.

Phase 2 answers "is this divergence real". This phase answers the question the
sweep exists for: what exactly have we not built, what have we built wrong, and
what is the concrete change. One agent per survivor, each persisting its own
spec to disk for the same reason the challengers do — see
docs/superpowers/specs/data/phase2-verdicts and the run's durability note.

Usage: python3 scripts/build-doc-sweep-remediation-wf.py <output.js>
"""

import json
import os
import sys

REPO = "/Users/i.i.gavrikov/Desktop/work/nessy-desktop"
DATA = f"{REPO}/docs/superpowers/specs/data"
SDIR = f"{DATA}/phase25-specs"
PHASE2 = f"{DATA}/2026-07-31-doc-sweep-phase2.json"

SPEC_SCHEMA = {
    "type": "object",
    "required": ["kind", "subsystem", "docRequirement", "current", "divergence",
                 "change", "blastRadius", "userImpact", "effort", "confidence"],
    "properties": {
        "kind": {"type": "string", "enum": ["not-built", "built-wrong", "built-partial"]},
        "subsystem": {"type": "string"},
        "docRequirement": {"type": "string"},
        "current": {"type": "string"},
        "divergence": {"type": "string"},
        "change": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["file", "what"],
                "properties": {
                    "file": {"type": "string"},
                    "symbol": {"type": "string"},
                    "what": {"type": "string"},
                },
            },
        },
        "blastRadius": {"type": "string"},
        "userImpact": {"type": "string"},
        "effort": {"type": "string", "enum": ["S", "M", "L"]},
        "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
        "notes": {"type": "string"},
    },
}

PROMPT = r"""A challenger already tried to refute a divergence between Claude Code's docs and the fork at {repo}, and FAILED — it stands. Your job is not to re-litigate it. Your job is to say, in implementable detail, what we have not built or have built wrong.

Your finding is `{fid}`, against https://code.claude.com/docs/en/{slug}.md. Load it first — it carries the verbatim doc sentence, the documented behaviour, our state and evidence as filed, and the challenger's reasoning and corrected statement:

  python3 -c "import json;d=json.load(open('{p2}'));print(json.dumps([r for r in d['results'] if r['id']=='{fid}'][0],ensure_ascii=False,indent=1))"

Read the real code before you write anything. Use codegraph_explore first — it returns verbatim line-numbered source plus callers and blast radius in one call. `curl -sL` the page again if you need surrounding context; never WebFetch, it paraphrases. For any absence claim use `grep -a`: several files here carry a NUL byte and plain grep skips them silently.

Produce:

- kind — `not-built` (the mechanism is absent), `built-wrong` (it exists and its
  observable behaviour contradicts the doc), or `built-partial` (present, but
  narrower than specified). Decide from code, not from the filed severity.
- subsystem — one of hooks, plugins, mcp, skills, commands, agents, permissions,
  sessions, context, sandbox, output, settings, other. Name the subsystem you
  actually read; an identically-named symbol in a sibling subsystem is the
  classic wrong answer here.
- docRequirement — what the page BINDS us to, in one or two sentences. Keep any
  identifier or field name exactly as the page spells it.
- current — what we do instead, with `path:line` for every claim.
- divergence — the delta alone, precisely. If a value is right and only the key
  name is wrong, say that; it changes the fix.
- change — the concrete edit list. One entry per file, with the symbol and what
  it must become. Enough for someone to start without re-deriving anything. If
  the fix is one line, say so; do not inflate it.
- blastRadius — what else reads this. Name callers, tests, wire/schema
  boundaries, imported-plugin paths. If it crosses a persistence or wire
  boundary, say so explicitly — that is a risk trigger in this repo.
- userImpact — what a user actually experiences today. Be concrete: which
  action, which surface, what they see or fail to see. Write "none observable"
  if it is latent, and say what would make it surface. This orders the report,
  so an honest "none observable" is more useful than a guess.
- effort — S (a line or a few), M (a file or two plus tests), L (crosses
  packages or a wire boundary).
- confidence — high only if you read every file you cite. If part of this rests
  on inference, say medium or low and put what you could not verify in notes.

MANDATORY LAST STEP — persist before you return, the run can be stopped at any moment. Write {sdir}/{fid}.json holding exactly your spec object plus `"id": "{fid}"` and `"slug": "{slug}"`. Use a quoted heredoc so the shell cannot touch the content:

  cat > {sdir}/{fid}.json <<'JSON'
  ...your JSON...
  JSON

Verify it parses with `python3 -m json.tool {sdir}/{fid}.json`, fix and re-verify if it does not, then return the same object as your structured output."""


def main() -> int:
    out_path = sys.argv[1]
    phase2 = json.load(open(PHASE2))
    survivors = [r for r in phase2["results"] if not r["verdict"]["refuted"]]

    os.makedirs(SDIR, exist_ok=True)
    already = {n[:-5] for n in os.listdir(SDIR) if n.endswith(".json")}
    todo = [s for s in survivors if s["id"] not in already]

    items = [
        {
            "id": s["id"],
            "slug": s["slug"],
            "prompt": PROMPT.format(repo=REPO, sdir=SDIR, p2=PHASE2,
                                    fid=s["id"], slug=s["slug"]),
        }
        for s in todo
    ]

    script = """export const meta = {
  name: 'claude-doc-sweep-phase25',
  description: 'One implementable remediation spec per surviving doc-sweep finding',
  phases: [{ title: 'Specify', detail: 'read the code, classify not-built / built-wrong / built-partial' }],
}

const ITEMS = %(items)s
const SPEC_SCHEMA = %(schema)s

phase('Specify')
log(`${ITEMS.length} surviving findings to specify`)

const specs = await parallel(
  ITEMS.map((it) => () =>
    agent(it.prompt, { label: `spec:${it.id}:${it.slug}`, phase: 'Specify', schema: SPEC_SCHEMA })
      .then((s) => ({ id: it.id, slug: it.slug, spec: s })),
  ),
)

const ok = specs.filter((s) => s && s.spec)
log(`${ok.length} specs written, ${specs.length - ok.length} agents died`)

return {
  dispatched: ITEMS.length,
  returned: ok.length,
  diedIds: specs.map((s, i) => (s && s.spec ? null : ITEMS[i].id)).filter(Boolean),
}
""" % {"items": json.dumps(items, ensure_ascii=False), "schema": json.dumps(SPEC_SCHEMA)}

    open(out_path, "w").write(script)
    print(f"survivors {len(survivors)} | already specified {len(already)} | dispatching {len(todo)}")
    print(f"wrote {out_path} ({os.path.getsize(out_path)} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
