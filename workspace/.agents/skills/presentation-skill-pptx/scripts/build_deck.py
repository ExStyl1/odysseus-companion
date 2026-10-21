#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Build a PPTX presentation from a spec file.

The spec is JSON with a "slides" list; the format is described in
references/layouts.md. The result is written next to the spec:
deck.json produces deck.pptx.

    python3 scripts/build_deck.py deck.json
    python3 scripts/build_deck.py deck.json --check
    python3 scripts/build_deck.py deck.json --out out/results.pptx

Exit codes: 0 built, 1 the spec or its content failed validation,
2 environment problem (missing file, PPTX not produced).
"""
import argparse
import logging
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from deckkit import BuildError, SpecError, deck_from_spec, load_spec  # noqa: E402


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description='Build a PPTX presentation from a JSON spec.',
        epilog='Spec format: references/layouts.md')
    parser.add_argument('spec', help='spec file (JSON)')
    parser.add_argument('--out', metavar='FILE',
                        help='where to write the PPTX; defaults to the spec '
                             'path with a .pptx extension')
    parser.add_argument('--check', action='store_true',
                        help='validate the spec only, write no files')
    parser.add_argument('--keep-html', action='store_true',
                        help='keep the intermediate HTML next to the PPTX')
    parser.add_argument('--allow-warnings', action='store_true',
                        help='do not print warnings, build quietly')
    parser.add_argument('--quiet', action='store_true',
                        help='print only the path to the result')
    return parser.parse_args(argv)


def report(issues, stream):
    for issue in issues:
        stream.write('%s\n' % issue)


def main(argv=None):
    args = parse_args(argv)
    logging.basicConfig(level=logging.ERROR, format='%(message)s')

    if not os.path.isfile(args.spec):
        sys.stderr.write('spec file not found: %s\n' % args.spec)
        return 2

    try:
        spec = load_spec(args.spec)
        deck = deck_from_spec(spec)
    except SpecError as exc:
        sys.stderr.write('spec rejected:\n')
        for problem in exc.problems:
            sys.stderr.write('  %s\n' % problem)
        return 1

    out_path = args.out or os.path.splitext(args.spec)[0] + '.pptx'

    if args.check:
        # Validate without leaving files beside the spec: the layout is
        # computed against a temporary HTML that is removed afterwards.
        tmp = tempfile.mkdtemp(prefix='deckcheck-')
        try:
            try:
                result = deck.build(os.path.join(tmp, 'check'), strict=False,
                                    pptx=False)
            except BuildError as exc:
                sys.stderr.write('presentation not built:\n')
                report(exc.issues, sys.stderr)
                return 1
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
        report(result.issues, sys.stderr)
        if result.errors:
            sys.stderr.write('errors: %d\n' % len(result.errors))
            return 1
        if not args.quiet:
            sys.stdout.write('spec is valid: %d slides, %d warnings\n'
                             % (result.slides, len(result.warnings)))
        return 0

    try:
        result = deck.build(out_path, title=deck.doc_title, strict=True,
                            keep_html=args.keep_html)
    except BuildError as exc:
        sys.stderr.write('presentation not built:\n')
        report(exc.issues, sys.stderr)
        return 1

    if result.warnings and not args.allow_warnings:
        report(result.warnings, sys.stderr)

    if not result.pptx_path or not os.path.isfile(result.pptx_path):
        sys.stderr.write('PPTX was not created\n')
        return 2

    sys.stdout.write('%s\n' % result.pptx_path)
    if not args.quiet:
        sys.stdout.write('slides: %d, warnings: %d\n'
                         % (result.slides, len(result.warnings)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
