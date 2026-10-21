#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Regenerate the layout fragments from assets/layouts/template.html.

The template is the single source of truth for markup. Fragments (NN-slug.html)
are cut from it by this script, so they cannot drift away from it. Run it after
every template edit; otherwise the builder keeps using the old fragments.

    python3 scripts/sync_layouts.py
    python3 scripts/sync_layouts.py --check

Order and descriptions come from assets/layouts/layouts.json. If the number of
slides in the template does not match the registry, the script stops: a layout
was added or removed and the registry needs updating by hand.

Exit codes: 0 in sync, 1 mismatch (with --check nothing is rewritten).
"""
import argparse
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from deckkit import layouts as L                              # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL = os.path.dirname(HERE)
LAYOUTS_DIR = os.path.join(SKILL, 'assets', 'layouts')
TEMPLATE = os.path.join(LAYOUTS_DIR, 'template.html')
REGISTRY = os.path.join(LAYOUTS_DIR, 'layouts.json')

# Slide marker in the template: <!-- NAME ===== -->
MARK_RE = re.compile(r'^[ \t]*' + re.escape('<!--') + r'[ \t]+(.+?)[ \t]+=+[ \t]*'
                     + re.escape('-->') + r'[ \t]*$', re.M)

# Labels are English, the descriptions stay in the language of the registry —
# the same language as the sample copy inside the fragments.
HEADER = """<!--
  %(name)s

  When to use: %(when)s
  Structure: %(structure)s

  Generated from assets/layouts/template.html by scripts/sync_layouts.py.
  Edit the template, not this file.
-->
"""


def read(path):
    with open(path, 'r', encoding='utf-8') as f:
        return f.read()


def cut_slides(doc):
    """Document to a list of slide HTML blocks, in order."""
    marks = list(MARK_RE.finditer(doc))
    blocks = []
    for index, mark in enumerate(marks):
        end = marks[index + 1].start() if index + 1 < len(marks) else len(doc)
        chunk = doc[mark.end():end]
        stop = chunk.find('</body>')
        if stop != -1:
            chunk = chunk[:stop]
        blocks.append(chunk.strip('\n'))
    return blocks


def fragment_text(layout, html):
    return HEADER % {
        'name': layout['name'].upper(),
        'when': layout['when'],
        'structure': layout['structure'],
    } + html + '\n'


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description='Regenerate layout fragments from the template.')
    parser.add_argument('--check', action='store_true',
                        help='compare only, rewrite nothing')
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    registry = json.loads(read(REGISTRY))['layouts']
    blocks = cut_slides(read(TEMPLATE))

    if len(blocks) != len(registry):
        sys.stderr.write('template has %d slides, registry has %d entries — '
                         'update assets/layouts/layouts.json\n'
                         % (len(blocks), len(registry)))
        return 1

    planned = {}
    for index, (layout, html) in enumerate(zip(registry, blocks), 1):
        planned['%02d-%s.html' % (index, layout['slug'])] = fragment_text(layout, html)

    # The builder no longer keeps its own list of fragment files — it derives
    # them from this registry — so "does the registry cover what the builder
    # knows" cannot fail any more. What can still fail is the other direction:
    # a slide in the template that no public layout can reach.
    unreachable = sorted(set(entry['slug'] for entry in registry)
                         - L.known_slugs())
    if unreachable:
        sys.stderr.write('template slides no layout record can fill: %s\n'
                         % ', '.join(unreachable))
        return 1

    if args.check:
        stale = []
        for name, text in sorted(planned.items()):
            path = os.path.join(LAYOUTS_DIR, name)
            if not os.path.isfile(path) or read(path) != text:
                stale.append(name)
        if stale:
            sys.stderr.write('fragments differ from the template: %s\n'
                             % ', '.join(stale))
            return 1
        sys.stdout.write('fragments match the template: %d layouts\n'
                         % len(planned))
        return 0

    for old in sorted(os.listdir(LAYOUTS_DIR)):
        if old.endswith('.html') and old != 'template.html':
            os.remove(os.path.join(LAYOUTS_DIR, old))

    for name, text in sorted(planned.items()):
        with open(os.path.join(LAYOUTS_DIR, name), 'w', encoding='utf-8') as f:
            f.write(text)
        sys.stdout.write('%s\n' % name)
    sys.stdout.write('layouts regenerated: %d\n' % len(planned))
    return 0


if __name__ == '__main__':
    sys.exit(main())
