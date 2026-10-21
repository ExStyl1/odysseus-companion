#!/usr/bin/env python3
"""Rebuild `scripts/claude-doc-pages.tsv` from Claude Code's `llms.txt`.

    curl -sL https://code.claude.com/docs/llms.txt \
      | python3 scripts/refresh-claude-doc-pages.py > scripts/claude-doc-pages.tsv

Reads llms.txt on stdin so the fetch stays visible in the shell history rather
than hidden inside this script — the repo's rule is that a doc claim names the
fetch that produced it.

The header's `Snapshot:` line is re-stamped here rather than by hand, because
the hand-maintained version went stale silently. Measured 2026-08-25: the old
substitution was `re.sub(r"\d+ pages\.", ...)`, and the line it had to match
reads `Snapshot: 2026-08-22, 186 pages (was 185 on 2026-08-09).` — "pages" is
followed by " (was", never by ".", so the regex matched nothing and the
regenerate command carried the previous snapshot's date and count forward into a
file whose data rows had changed. A stamp that cannot fail loudly is worse than
no stamp, so a miss now warns on stderr.
"""
import datetime
import re
import sys

HEADER = open(__file__).read().split('"""')[1]

SNAPSHOT_RE = re.compile(
    r"Snapshot: (?P<date>\d{4}-\d{2}-\d{2}), (?P<count>\d+) pages"
    r"(?: \(was (?P<prev>\d+) on (?P<prev_date>\d{4}-\d{2}-\d{2})\))?\."
)


def restamp(comments: str, count: int, today: str) -> str:
    """Re-date the header's `Snapshot:` line to today's fetch and page count.

    A changed count pushes the old one into the `(was N on DATE)` parenthetical,
    so the file carries its own last two measurements. An unchanged count keeps
    that parenthetical as it was — re-dating a corpus that did not move should
    not erase when it last did.
    """

    def one(match: "re.Match[str]") -> str:
        if int(match["count"]) == count:
            previous = (
                f" (was {match['prev']} on {match['prev_date']})" if match["prev"] else ""
            )
            return f"Snapshot: {today}, {count} pages{previous}."
        return f"Snapshot: {today}, {count} pages (was {match['count']} on {match['date']})."

    stamped, hits = SNAPSHOT_RE.subn(one, comments)
    if hits == 0:
        print(
            "WARNING: no `Snapshot: <date>, <n> pages ...` line in the header — "
            f"the emitted file says nothing about being a {count}-page snapshot "
            f"taken {today}. Add one, or this regenerate is undated.",
            file=sys.stderr,
        )
    return stamped


def main() -> int:
    raw = sys.stdin.read()
    pages = re.findall(
        r"- \[([^\]]+)\]\(https://code\.claude\.com/docs/en/([a-zA-Z0-9/_-]+)\.md\)", raw
    )
    if not pages:
        print("no pages parsed — is this llms.txt?", file=sys.stderr)
        return 1
    # One row per SLUG (UB12.95). Measured 2026-10-17: `llms.txt` now repeats a
    # section's featured pages under its own `### ` heading, so it held 264 page
    # links over 228 slugs, 36 of them listed twice with the same title. Writing
    # every link would have emitted 36 duplicate rows and stamped 264 pages — the
    # duplicate-counting failure `check-coverage-map.ts` already names. A repeated
    # slug with a DIFFERENT title is not a repeat, so that refuses.
    titles: dict[str, str] = {}
    for title, slug in pages:
        if titles.setdefault(slug, title) != title:
            print(f"`{slug}` is listed with two titles: {titles[slug]!r} and {title!r}", file=sys.stderr)
            return 1
    existing = open("scripts/claude-doc-pages.tsv").read()
    comments = "".join(l for l in existing.splitlines(True) if l.startswith("#"))
    today = datetime.date.today().isoformat()
    sys.stdout.write(restamp(comments, len(titles), today))
    for slug in sorted(titles):
        sys.stdout.write(f"{slug}\t{titles[slug]}\n")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
