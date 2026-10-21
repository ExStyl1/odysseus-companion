# -*- coding: utf-8 -*-
"""Slide content. There is no and must be no geometry or CSS classes here:
layout lives in the skill's reference fragments, and here is only what the author writes.

The chart data types and the formula and chart errors are defined by the
engine, which lays out and writes charts and formulas (`html2pptx/chartgeom.py`,
`html2pptx/formula.py`); they are named here as well because they are part of
what an author hands the deck and what the deck raises.
"""
from .html2pptx.chartgeom import ChartData, ChartDataError, Series  # noqa: F401
from .html2pptx.formula import FormulaError                       # noqa: F401


class Card(object):
    """Card: subtitle or large value, description, icon.

    `icon` is not a filename but a meaning ('growth', 'security'). The file is matched
    by the icon index; so the presentation author physically cannot reference
    a non-existent image.
    """

    __slots__ = ('title', 'text', 'icon', 'items', 'value')

    def __init__(self, title='', text='', icon=None, items=None, value=None):
        self.title = title
        self.value = value
        self.text = text
        self.icon = icon
        # Bullet list inside the card. Markup is borrowed from the reference
        # fragment 'bullets', the one list the template draws.
        self.items = list(items) if items else []

    def __repr__(self):
        return 'Card(%r)' % (self.title,)


class Metric(object):
    """Number and caption."""

    __slots__ = ('value', 'text')

    def __init__(self, value, text=''):
        self.value = value
        self.text = text

    def __repr__(self):
        return 'Metric(%r)' % (self.value,)


class Slide(object):
    """Internal representation: layout and data for it."""

    __slots__ = ('layout', 'data', 'notes')

    def __init__(self, layout, data, notes=None):
        self.layout = layout
        self.data = data
        self.notes = notes

    def __repr__(self):
        return 'Slide(%s)' % (self.layout,)


class Issue(object):
    """Pre-flight check remark."""

    __slots__ = ('level', 'code', 'slide', 'message')

    def __init__(self, level, code, slide, message):
        self.level = level          # 'error' | 'warning'
        self.code = code
        self.slide = slide          # slide number, 1-based
        self.message = message

    def __str__(self):
        mark = 'ERROR' if self.level == 'error' else 'warning'
        return '[%s] slide %d: %s' % (mark, self.slide, self.message)


class BuildError(Exception):
    """Build stopped: deck has errors."""

    def __init__(self, issues):
        self.issues = issues
        Exception.__init__(self, '\n'.join(str(i) for i in issues))


class IconNotFound(Exception):
    """Icon not found, and guessing is not allowed."""
    pass


class MediaError(Exception):
    """Image source for the `image`/`chart` layouts does not read: missing
    file or a format PPTX cannot embed. Raised at build time, not the
    icon-style silent [WARN] — a typo'd filename should fail the build, not
    a slide that quietly ends up with no picture on it.
    """
    pass



class SpecError(Exception):
    """Spec does not read: unknown layout, field or wrong type.

    Collects all remarks at once, rather than failing on the first: it is easier
    for the agent to fix the file in one go than to restart the build on every typo.
    """

    def __init__(self, problems):
        self.problems = list(problems)
        Exception.__init__(self, '\n'.join(self.problems))
