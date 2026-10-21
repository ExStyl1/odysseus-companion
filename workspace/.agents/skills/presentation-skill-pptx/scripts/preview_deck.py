#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Render slides to PNG so the result can be inspected visually.

Neither PPTX nor HTML shows how the text actually landed. The preview draws the
same layout that goes into the presentation, so line breaks, empty space and
collisions are visible.

    python3 scripts/preview_deck.py deck.json
    python3 scripts/preview_deck.py deck.json --slides 1,4 --scale 0.5
    python3 scripts/preview_deck.py assets/layouts/template.html --out preview

Images go to a "preview" subdirectory next to the input file by default.

Exit codes: 0 images written, 1 input rejected, 2 nothing to render.
"""
import argparse
import logging
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from deckkit import SpecError, deck_from_spec, load_spec      # noqa: E402
from deckkit.fragments import find_skill_dir                  # noqa: E402
from deckkit.preview import render_file                       # noqa: E402
from deckkit.html2pptx.paint import PaintError                 # noqa: E402
from deckkit.html2pptx.layout import GridPlacementError        # noqa: E402


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description='PNG previews of slides from a spec or a finished HTML.')
    parser.add_argument('input', help='spec file (JSON) or HTML')
    parser.add_argument('--slides', help='comma-separated numbers, e.g. 1,3,6')
    parser.add_argument('--out', metavar='DIR',
                        help='directory for the images; defaults to "preview" '
                             'next to the input file')
    parser.add_argument('--scale', type=float, default=0.5,
                        help='scale relative to 1920x1080 (default 0.5)')
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    logging.basicConfig(level=logging.ERROR, format='%(message)s')

    if not os.path.isfile(args.input):
        sys.stderr.write('file not found: %s\n' % args.input)
        return 1

    wanted = None
    if args.slides:
        try:
            wanted = set(int(n) for n in args.slides.split(','))
        except ValueError:
            sys.stderr.write('slide numbers are comma-separated: 1,3,6\n')
            return 1

    stem = os.path.splitext(os.path.basename(args.input))[0]
    out_dir = args.out or os.path.join(os.path.dirname(os.path.abspath(args.input)),
                                       'preview')
    skill_dir = find_skill_dir()
    temp_dir = None

    try:
        if args.input.lower().endswith('.json'):
            try:
                deck = deck_from_spec(load_spec(args.input))
            except SpecError as exc:
                sys.stderr.write('spec rejected:\n')
                for problem in exc.problems:
                    sys.stderr.write('  %s\n' % problem)
                return 1
            temp_dir = tempfile.mkdtemp(prefix='deckpreview-')
            result = deck.build(os.path.join(temp_dir, stem), strict=False,
                                pptx=False, keep_html=True)
            html_path = result.html_path
        else:
            html_path = args.input

        images = render_file(html_path, out_dir, skill_dir, wanted=wanted,
                             scale=args.scale, stem=stem)
    except PaintError as exc:
        sys.stderr.write('preview not rendered:\n%s\n' % exc)
        return 1
    except GridPlacementError as exc:
        sys.stderr.write('preview layout rejected:\n%s\n' % exc)
        return 1
    finally:
        if temp_dir:
            shutil.rmtree(temp_dir, ignore_errors=True)

    if not images:
        sys.stderr.write('no slides to render\n')
        return 2
    for path in images:
        sys.stdout.write('%s\n' % path)
    return 0


if __name__ == '__main__':
    sys.exit(main())
