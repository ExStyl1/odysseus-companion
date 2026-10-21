#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Look up icons by meaning.

In a spec an icon is named by a word («рост», «безопасность»), not by filename.
This prints what such words resolve to — useful for picking a deck's icons in
one go instead of one call per card.

    python3 scripts/find_icon.py рост риск команда сроки
    python3 scripts/find_icon.py безопасность --limit 10
    python3 scripts/find_icon.py рост --exclude chart-grow.png
    python3 scripts/find_icon.py --concepts
    python3 scripts/find_icon.py --categories

Pass every word the deck needs in one invocation: the candidates are printed in
the order the builder would pick them, so the whole set can be chosen at a
glance and the same icon does not end up on two cards of one slide.

Exit codes: 0 everything matched, 1 at least one word matched nothing.
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from deckkit.fragments import find_skill_dir                  # noqa: E402
from deckkit.icons import (                                   # noqa: E402
    IconLibrary, default_index_path, default_concepts_path
)


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description='Find icons by meaning. Several words at once.')
    parser.add_argument('query', nargs='*',
                        help='one or more words; each is reported separately')
    parser.add_argument('--limit', type=int, default=5,
                        help='how many candidates per word (default 5)')
    parser.add_argument('--categories', action='store_true',
                        help='list the categories and exit')
    parser.add_argument('--concepts', action='store_true',
                        help='list the business concepts and exit')
    parser.add_argument('--exclude', action='append', default=[], metavar='FILE',
                        help='skip this icon; repeat for several')
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    skill_dir = find_skill_dir()
    library = IconLibrary(default_index_path(skill_dir),
                          default_concepts_path(skill_dir))

    if args.categories:
        for name in library.categories():
            sys.stdout.write('%s\n' % name)
        return 0

    if args.concepts:
        concepts = library.concepts
        for concept in sorted(concepts):
            sys.stdout.write('%-24s %s\n'
                             % (concept, ', '.join(concepts[concept][:4])))
        sys.stdout.write('\n%d concepts\n' % len(concepts))
        return 0

    if not args.query:
        sys.stderr.write('a query, --concepts or --categories is required\n')
        return 1

    exclude = set(args.exclude)
    exit_code = 0

    for query in args.query:
        # Один и тот же порядок кандидатов, что и у сборки: сперва понятие,
        # затем поиск по ключевым словам. Раньше эти две ветки печатались
        # по-разному, и для слова-понятия варианты из поиска не показывались
        # вовсе — то есть выбирать было не из чего.
        options = [name for name in library.candidates(query)
                   if name not in exclude]
        if not options:
            sys.stderr.write('nothing matched "%s" among %d icons\n'
                             % (query, len(library)))
            exit_code = 1
            continue

        concept = library.has_concept(query)
        sys.stdout.write('%s%s\n' % (query, '  [concept]' if concept else ''))
        for name in options[:args.limit]:
            entry = library._by_file.get(name)
            keywords = ', '.join(entry['keywords'][:5]) if entry else ''
            category = entry['category'] if entry else ''
            sys.stdout.write('    %-30s %-14s %s\n'
                             % (name, category, keywords))

    return exit_code


if __name__ == '__main__':
    sys.exit(main())
