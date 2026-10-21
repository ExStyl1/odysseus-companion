# -*- coding: utf-8 -*-
"""Presentation spec: JSON → deck.

The agent describes content in a file, not code. Two consequences follow:

* edits go into the same file and rebuild — nothing to break since there is
  no layout in the spec;
* typos are caught here, not as blank spots on slides. Hence strict validation:
  unknown field is an error, not a silent skip.

Format described in `references/layouts.md`.
"""
import json
import os

from . import layouts as L
from .deck import Deck
from .model import SpecError
from .schema import _check_slide

# Which fields a layout takes is a property of the layout, so it lives with the
# rest of them in layouts.py. Layout names here are semantic: the concrete
# variant (2x2 vs 2x3 grid) is chosen from the element count by the record.
LAYOUTS = L.PUBLIC

_TOP_FIELDS = ('title', 'slides')


def load_spec(path):
    """Load spec file. Parse error includes line number."""
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except ValueError as exc:
        message = '%s: file is not valid JSON - %s' % (path, exc)
        # Nearly always a formula pasted with single backslashes: `\(` and
        # `\m` are not JSON escapes, and the bare error never says so.
        if 'Invalid \\escape' in str(exc):
            message += ('. In JSON every backslash is doubled: a formula is '
                        'written "\\\\(\\\\frac{a}{b}\\\\)"')
        raise SpecError([message])


def deck_from_spec(spec, skill_dir=None, _allow_draft=False):
    """Spec → ready deck. All errors collected at once.

    `_allow_draft` is not a spec-authoring switch - it exists so tests and
    future re-enabling work can still drive a `status='draft'` layout (see
    `layouts.py`) end to end through this exact path while `layouts.DRAFT`
    keeps it out of reach for a normal content-authoring spec. Nothing in the
    JSON format exposes it.
    """
    problems = []

    if not isinstance(spec, dict):
        raise SpecError(['the spec must be an object with a "slides" field'])

    for key in spec:
        if key not in _TOP_FIELDS:
            problems.append('top level: unknown field "%s"; '
                            'allowed: %s' % (key, ', '.join(_TOP_FIELDS)))

    if 'title' in spec and not isinstance(spec['title'], str):
        problems.append('top level: "title" must be a string')

    slides = spec.get('slides')
    if not isinstance(slides, list) or not slides:
        problems.append('the "slides" field is required and must be a non-empty list')
        raise SpecError(problems)

    prepared = []
    for index, raw in enumerate(slides, 1):
        prepared.append(_check_slide(raw, index, problems, _allow_draft))

    if problems:
        raise SpecError(problems)

    deck = Deck(skill_dir=skill_dir)
    deck.doc_title = spec.get('title')
    for index, slide in enumerate(prepared, 1):
        try:
            _add(deck, slide)
        except ValueError as exc:
            problems.append('slide %d (%s): %s' % (index, slide['layout'], exc))
        except Exception as exc:                      # icon not found, etc.
            problems.append('slide %d (%s): %s' % (index, slide['layout'], exc))
    if problems:
        raise SpecError(problems)
    return deck


# ------------------------------------------------------------------ build

def _add(deck, slide):
    """Hand one validated slide to the deck.

    There is no dispatch left here. Every field a layout accepts is named the
    same in the spec and in the slide data, so the object goes through as it
    stands and `Deck.add` reads the rest of the rule out of the registry. The
    `final` slide is the one that needs anything: an absent `text` means the
    default closing line, and that default lives in `Deck.final`.
    """
    data = dict((key, value) for key, value in slide.items()
               if key not in ('layout', 'notes'))
    notes = slide.get('notes')
    if slide['layout'] == 'final' and not data.get('text'):
        return deck.final(notes=notes)
    return deck.add(slide['layout'], data, notes=notes)


def example_spec_path(skill_dir):
    return os.path.join(skill_dir, 'assets', 'example-deck.json')
