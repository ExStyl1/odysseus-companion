# -*- coding: utf-8 -*-
"""Skill reference fragments as the source of markup.

Layout is NOT repeated in code: each layout is read from
`assets/layouts/*.html` and filled with content. Therefore editing the reference
immediately reflects in built presentations, and there is nothing to diverge.
"""
import copy
import os

from lxml import html as lhtml

from .html2pptx import formula
from . import layouts as L
from .typeset import typeset as _typeset
from .model import FormulaError

# The list of fragment files used to live here, as a second copy of
# assets/layouts/layouts.json. It is derived from that registry now
# (layouts.fragment_file): the builder cannot know a layout the template does
# not have, and the two cannot fall out of step.
# Markup lives in assets/layouts/ because the agent does not read it — the builder does.


def find_skill_dir(start=None):
    """Skill directory. The library lives in scripts/deckkit/, so the skill is two
    levels up; no need to search directories by brute force."""
    if start:
        root = os.path.abspath(start)
    else:
        root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
    if os.path.isdir(os.path.join(root, 'assets', 'layouts')) \
            and os.path.isdir(os.path.join(root, 'assets', 'icons')):
        return root
    raise IOError('skill directory not found: %s has no assets/layouts and assets/icons'
                  % root)


class FragmentLibrary(object):
    def __init__(self, skill_dir):
        self.skill_dir = skill_dir
        self.slides_dir = os.path.join(skill_dir, 'assets', 'layouts')
        self._cache = {}

    def load(self, layout):
        """Fresh copy of layout markup — can be freely edited."""
        if layout not in self._cache:
            path = os.path.join(self.slides_dir,
                                L.fragment_file(self.skill_dir, layout))
            # Fragments have no <meta charset>: if we relied on autodetection,
            # Cyrillic would turn into garbage.
            with open(path, 'rb') as f:
                text = f.read().decode('utf-8')
            root = lhtml.fragment_fromstring(text, create_parent='div')
            slides = root.xpath(".//*[contains(concat(' ', normalize-space(@class), ' '), ' slide ')]")
            if not slides:
                raise IOError('fragment %s has no slide block' % path)
            self._cache[layout] = slides[0]
        return copy.deepcopy(self._cache[layout])


# ------------------------------------------------------------------ utilities

def borrow(library, layout, class_name):
    """Copy a node from another reference layout.

    Needed to reuse a ready block — for example a bullet list inside a card.
    Markup still comes from the template, not from code: assembling it with
    tags here is not allowed.
    """
    source = library.load(layout)
    node = first(source, class_name)
    if node is None:
        raise KeyError('layout %s has no .%s block' % (layout, class_name))
    parent = node.getparent()
    if parent is not None:
        parent.remove(node)
    return node


def by_class(root, name):
    """All elements with this class, in document order."""
    expr = ".//*[contains(concat(' ', normalize-space(@class), ' '), ' %s ')]" % name
    return root.xpath(expr)


def first(root, name):
    found = by_class(root, name)
    return found[0] if found else None


def set_text(el, text, typeset=True):
    """Element text; newline becomes <br>, as in references.

    Spaces that must not break become NBSP (`typeset.py`). Pass
    ``typeset=False`` for a field that is one line by contract and has its own
    check for wrapping, such as a metric value: glued, its overflow would be
    reported as a generic width error instead of ``METRIC_WRAP``.
    """
    if el is None:
        return
    if typeset:
        text = _typeset(text)
    for child in list(el):
        if child.tag == 'br':
            el.remove(child)
    el.text = None
    parts = (text or '').split('\n')
    el.text = parts[0]
    tail = el
    for part in parts[1:]:
        br = el.makeelement('br', {})
        br.tail = part
        el.append(br)
        tail = br
    return tail


def set_text_formula(el, text):
    """Element text where explicit ``\\(...\\)`` spans become math markers.

    A rejected formula is not raised from here. It is recorded on its own
    marker as ``data-error`` and the walk carries on, so one build reports
    every bad formula in the deck instead of only the first — the same reason
    ``spec.py`` reports every bad field at once. ``build.render_html`` collects
    those markers and refuses before anything is written; nothing downstream
    ever sees one, because a deck carrying any of them does not get that far.
    """
    if el is None:
        return
    for child in list(el):
        if child.tag in ('br', 'span'):
            el.remove(child)
    el.text = None
    tail = None

    def append_text(value):
        if not value:
            return
        if tail is None:
            el.text = (el.text or '') + value
        else:
            tail.tail = (tail.tail or '') + value

    def append_error(message):
        attrs = {'class': 'math', 'data-error': message}
        where = el.get('class')
        if where:
            attrs['data-field'] = where
        span = el.makeelement('span', attrs)
        el.append(span)
        return span

    for line_no, line in enumerate((text or '').split('\n')):
        if line_no:
            br = el.makeelement('br', {})
            el.append(br)
            tail = br
        try:
            pieces = formula.parse_inline(line)
        except FormulaError as exc:
            tail = append_error(str(exc))
            continue
        for kind, value in pieces:
            if kind == 'text':
                append_text(_typeset(value))
                continue
            try:
                _, mathtext = formula.validate(value)
            except FormulaError as exc:
                tail = append_error(str(exc))
                continue
            # Both spellings travel in the HTML, the same round trip the chart
            # layout uses for its data: the pipeline serializes the document
            # and re-parses it, so anything not written here is gone by the
            # time the layout engine walks the tree. `data-latex` is the
            # author's source and becomes OMML; `data-mathtext` is the
            # canonical form every measurement and the PNG raster read.
            span = el.makeelement('span', {'class': 'math',
                                           'data-latex': value,
                                           'data-mathtext': mathtext})
            el.append(span)
            tail = span
    return tail if tail is not None else el


def formula_errors(element):
    """Every rejected formula under `element`, as (field class, message)."""
    out = []
    for span in element.iter('span'):
        message = span.get('data-error')
        if message:
            out.append((span.get('data-field'), message))
    return out


def keep_first(elements, count):
    """Keep first `count` elements, remove the rest from the document."""
    for extra in elements[count:]:
        parent = extra.getparent()
        if parent is not None:
            parent.remove(extra)
    return elements[:count]


def set_icon(img, filename, prefix):
    """Set icon path relative to the future presentation file."""
    if img is None or not filename:
        return
    img.set('src', prefix + 'assets/icons/' + filename)


def drop_icon(card):
    """Remove icon block entirely — used when icon is not specified."""
    holder = first(card, 'icon-container')
    if holder is not None and holder.getparent() is not None:
        holder.getparent().remove(holder)


def retarget_assets(root, prefix):
    """Rewrite paths from reference to match result location.

    In fragments paths are written relative to assets/layouts/ — `../icons/x.png`.
    In the built presentation they must lead from the presentation file to the skill directory.
    """
    for el in root.iter():
        for attr in ('src', 'href'):
            value = el.get(attr)
            if not value or not value.startswith('../'):
                continue
            el.set(attr, prefix + 'assets/' + value[3:])
