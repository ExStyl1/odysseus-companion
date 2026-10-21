#!/usr/bin/env python3
"""Deterministic linter for documentation Markdown pages.

Checks the bright-line rules from the team documentation standard that a model
easily forgets: frontmatter, a single `# Title` with an intro, anchors on
`##`/`###` headings, no trailing period in headings, no emoji, the upper size
bound and file name. Root README files are exempt from portal-only rules.

Usage:
    python3 check_doc.py <file.md> [<file2.md> ...]

Exit code 0 = clean, 1 = violations found. Lines inside fenced code blocks are
ignored so examples never trip the checks.
"""
import re
import sys
import os

# Emoji blocks only. Arrows (U+2190-21FF: → ← ↔) are deliberately excluded —
# the editorial policy uses → for UI navigation.
EMOJI = re.compile(
    "[\U0001F000-\U0001FAFF\U00002600-\U000027BF\U0001F1E6-\U0001F1FF]"
)
HEADING = re.compile(r"^(#{1,6})\s+(.*?)\s*$")
ANCHOR = re.compile(r"\{#[a-z0-9][a-z0-9-]*\}\s*$")


def strip_code_fences(lines):
    """Yield (lineno, text) for lines outside ``` fenced blocks."""
    in_fence = False
    for i, line in enumerate(lines, 1):
        if line.lstrip().startswith("```"):
            in_fence = not in_fence
            continue
        if not in_fence:
            yield i, line


def lint(path):
    problems = []
    with open(path, encoding="utf-8", errors="replace") as f:
        raw = f.read()
    lines = raw.splitlines()
    body_lines = list(strip_code_fences(lines))
    base = os.path.basename(path)
    is_readme = base.lower() == "readme.md"

    # --- frontmatter ---
    has_frontmatter = lines[:1] == ["---"] and "---" in lines[1:50]
    fm_end = 0
    if has_frontmatter:
        fm_end = lines.index("---", 1)
    elif not is_readme:
        problems.append("no YAML frontmatter (--- title/sidebar ---) at the top")

    # --- single H1 title + intro ---
    h1 = [(n, m.group(2)) for n, l in body_lines for m in [HEADING.match(l)] if m and len(m.group(1)) == 1]
    if len(h1) == 0:
        problems.append("no `# Title` heading — every page opens with one H1 that answers its question")
    elif len(h1) > 1:
        problems.append(f"{len(h1)} `# ` H1 headings — keep exactly one page title (lines {[n for n,_ in h1]})")
    if h1:
        title_line = h1[0][0]
        # first non-empty, non-heading line after the title = intro
        intro = None
        for n, l in body_lines:
            if n > title_line and l.strip() and not HEADING.match(l):
                intro = l.strip()
                break
        if not intro:
            problems.append("no intro paragraph under the `# Title` (1-2 sentences: what the page covers and for whom)")

    # --- headings: anchors on ##/###, no trailing period ---
    for n, l in body_lines:
        m = HEADING.match(l)
        if not m:
            continue
        level, text = len(m.group(1)), m.group(2)
        if not is_readme and level in (2, 3) and not ANCHOR.search(l):
            problems.append(f"line {n}: heading without {{#anchor}} — `{l.strip()}`")
        text_no_anchor = re.sub(r"\s*\{#[^}]*\}\s*$", "", text)
        if text_no_anchor.endswith(".") and not text_no_anchor.endswith(".."):
            problems.append(f"line {n}: heading ends with a period — `{text_no_anchor}`")

    # --- emoji in body ---
    for n, l in body_lines:
        if EMOJI.search(l):
            problems.append(f"line {n}: emoji in documentation body — remove it")

    # --- size ---
    n_lines = len(lines)
    if n_lines > 400:
        problems.append(f"{n_lines} lines (>400) — usually several topics, split it")

    # --- file name ---
    stem = base[:-3] if base.endswith(".md") else base
    if not is_readme and stem not in ("index", "_category_") and ("_" in stem or stem != stem.lower() or " " in stem):
        problems.append(f"file name `{base}` — use lower-case, hyphen-separated words, no underscores")

    return problems


USAGE = """\
usage: check_doc.py <file.md> [<file2.md> ...]

Deterministic linter for documentation Markdown pages. Checks bright-line
rules: frontmatter, a single `# Title` with intro, anchors on `##`/`###`,
no trailing period in headings, no emoji, maximum size (400 lines), file name.

Exit code: 0 = clean, 1 = violations found, 2 = bad invocation.
"""


def main(argv):
    files = argv[1:]
    if "-h" in files or "--help" in files:
        print(USAGE)
        return 0
    if not files:
        print(USAGE, file=sys.stderr)
        return 2
    total = 0
    for path in files:
        problems = lint(path)
        if problems:
            total += len(problems)
            print(f"\n{path}: {len(problems)} issue(s)")
            for p in problems:
                print(f"  - {p}")
        else:
            print(f"{path}: OK")
    if total:
        print(f"\n{total} issue(s) found.")
        return 1
    print("\nAll checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
