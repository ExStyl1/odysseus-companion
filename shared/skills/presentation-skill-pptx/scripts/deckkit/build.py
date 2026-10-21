# -*- coding: utf-8 -*-
"""Build: slides → HTML document → PPTX.

HTML here is not an intermediate hack but a full-fledged result: it can be opened
in a browser and shown as is. PPTX comes from it via the same converter as before,
so a second layout implementation is not needed.
"""
import html
import logging
import os
import tempfile

from lxml import etree

from . import fragments as F
from . import layouts as L
from . import slides as S
from . import validate as V
from .model import BuildError, FormulaError, Issue

log = logging.getLogger(__name__)

_DOC = """<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>%(title)s</title>
  <link rel="stylesheet" href="%(prefix)sassets/base.css">
</head>
<body>

%(slides)s

</body>
</html>
"""


class BuildResult(object):
    __slots__ = ('html_path', 'pptx_path', 'issues', 'slides', 'sizes')

    def __init__(self, html_path, pptx_path, issues, slides, sizes=()):
        self.html_path = html_path
        self.pptx_path = pptx_path
        self.issues = issues
        self.slides = slides
        # One autofit.Sizes per slide: the type size the build actually chose.
        # Reported rather than discarded, so that finding out what shipped does
        # not mean running the size search a second time over the result.
        self.sizes = list(sizes)

    @property
    def errors(self):
        return [i for i in self.issues if i.level == 'error']

    @property
    def warnings(self):
        return [i for i in self.issues if i.level == 'warning']

    def __repr__(self):
        return 'BuildResult(%d slides, %d issues)' % (self.slides, len(self.issues))


def asset_prefix(out_dir, skill_dir):
    """Path from result directory to skill, as a prefix for src/href."""
    rel = os.path.relpath(os.path.abspath(skill_dir), os.path.abspath(out_dir))
    if rel == '.':
        return ''
    return rel.replace(os.sep, '/') + '/'


def render_html(deck, out_path, title=None):
    """Build HTML document text for a deck."""
    for value in (title, getattr(deck, 'doc_title', None)):
        if value is not None and not isinstance(value, str):
            raise ValueError('document title must be a string or None')
    out_dir = os.path.dirname(os.path.abspath(out_path)) or '.'
    prefix = asset_prefix(out_dir, deck.skill_dir)

    chunks = []
    issues = []
    for index, slide in enumerate(deck.slides, 1):
        try:
            element = S.render(deck.fragments, slide.layout, slide.data,
                               deck.icons, prefix)
        except FormulaError as exc:
            # A filler that rejects a formula outside set_text_formula. That
            # path aborts the slide, so there is nothing further to collect
            # from it — but keep walking the remaining slides.
            issues.append(Issue('error', 'FORMULA', index, str(exc)))
            continue
        for field, message in F.formula_errors(element):
            issues.append(Issue('error', 'FORMULA', index,
                                '%s: %s' % (field, message) if field
                                else message))
        markup = etree.tostring(element, encoding='unicode', pretty_print=False)
        chunks.append('  <!-- %s -->\n%s' % (slide.layout, markup.strip()))

    # Every bad formula in the deck, not the first: an author fixing a
    # formula-heavy deck should need one build, not one per mistake.
    if issues:
        raise BuildError(issues)

    return _DOC % {
        'title': html.escape(title or _guess_title(deck)),
        'prefix': prefix,
        'slides': '\n\n'.join(chunks),
    }


def _guess_title(deck):
    if getattr(deck, 'doc_title', None):
        return deck.doc_title
    for slide in deck.slides:
        if slide.layout == 'title':
            text = slide.data.get('text')
            if text is not None and not isinstance(text, str):
                raise ValueError('title slide text must be a string or None')
            return (text or 'Презентация').replace('\n', ' ')
    return 'Презентация'


def _check_slide_count(actual, expected, stage):
    """Do not fit or assign notes against a different slide sequence."""
    if actual != expected:
        raise BuildError([Issue('error', 'SLIDE_COUNT', 0,
                                '%s has %d slides; deck has %d'
                                % (stage, actual, expected))])


def _write_notes(pptx_path, deck):
    """Copy each slide's speaker notes into the .pptx notes pane.

    A second open+save of the file the render just wrote, not folded into
    convert.py: notes are plain text with no layout or measurement, so they
    do not belong in the box-tree pipeline the rest of the build shares.
    """
    from pptx import Presentation
    prs = Presentation(pptx_path)
    _check_slide_count(len(prs.slides), len(deck.slides), 'PPTX')
    changed = False
    for i, slide in enumerate(deck.slides):
        if slide.notes:
            prs.slides[i].notes_slide.notes_text_frame.text = slide.notes
            changed = True
    if changed:
        prs.save(pptx_path)


def build(deck, out_path, title=None, strict=True, pptx=True, keep_html=False):
    """Write HTML, validate and, if all is well, assemble PPTX.

    HTML is an intermediate step: layout is computed from it. By default it
    is removed so that there is no second file next to the result that
    is easy to mistake for the final one and start editing by hand.
    """
    if not deck.slides:
        raise BuildError([])

    # Result name is given without extension: both .pptx and intermediate .html
    # come from the same base. Ready extension on input is discarded,
    # otherwise we get "presentation.pptx.pptx".
    base, ext = os.path.splitext(out_path)
    if ext.lower() not in ('.html', '.htm', '.pptx'):
        base = out_path
    html_path = base + '.html'

    out_dir = os.path.dirname(os.path.abspath(html_path))
    if out_dir and not os.path.isdir(out_dir):
        os.makedirs(out_dir)

    markup = render_html(deck, html_path, title=title)
    with open(html_path, 'w', encoding='utf-8') as f:
        f.write(markup)
    log.info('[OK] HTML written: %s', html_path)

    # From here on there is one document, laid out once and handed on. Autofit
    # measures it to pick the type sizes, the validator reads the same box
    # trees, and the PPTX is written from them — before v1.5 each of the three
    # opened the file and built its own engine, so the deck was laid out three
    # times over and two of the measurements were thrown away.
    from .html2pptx.document import Document
    document = Document.open(html_path, extra_dirs=[deck.skill_dir])
    _check_slide_count(len(document.elements), len(deck.slides), 'HTML')

    # The size is picked by measurement and written back into the file, before
    # validation. The order matters both ways: earlier, there's nothing to
    # measure the layout from; later, the validator would complain about a size
    # that the build itself fixes a line down. The file is rewritten because
    # the HTML on disk has to carry the sizes the PPTX carries.
    from . import autofit as A
    sizes = A.fit(document, deck.skill_dir, [s.layout for s in deck.slides])
    document.save()

    # The validator reads the same box trees, and the size search's own
    # verdict on the headlines it could not seat.
    issues = V.check(deck, document, sizes)
    errors = [i for i in issues if i.level == 'error']
    if errors and strict:
        raise BuildError(issues)

    pptx_path = None
    if pptx and not errors:
        from .html2pptx.convert import write_pptx
        from .html2pptx.paint import PaintError
        # Publish only after every editor succeeds. The staging directory is
        # on the destination filesystem, so replacement is atomic; its context
        # also removes partial archives on any failure, including save/replace.
        with tempfile.TemporaryDirectory(prefix='.deck-build-', dir=out_dir) as work:
            staged_path = os.path.join(work, 'presentation.pptx')
            try:
                write_pptx(document, staged_path, group_roots=L.GROUP_ROOTS)
            except PaintError as exc:
                issues.extend(V.paint_issues(exc.diagnostics))
                if strict:
                    raise BuildError(issues) from exc
                for issue in issues:
                    log.warning('%s', issue)
                return BuildResult(html_path, None, issues, len(deck.slides), sizes)

            _write_notes(staged_path, deck)

            # The colour gallery PowerPoint offers the reader comes from the theme,
            # and the theme comes from python-pptx's default template — Office 2007
            # blue until we overwrite it. Nothing on the slides depends on it, and
            # that is exactly why it would never be noticed: the deck looks right
            # and the dropdown belongs to another company.
            from .html2pptx.theme import apply_theme_colors
            log.info('[OK] theme colours: %s',
                     apply_theme_colors(staged_path, deck.skill_dir))

            # Fonts go inside the file: the name "T-Sans Medium" is not resolved by
            # everyone, and without embedding weight 500 is drawn as regular by some readers.
            # We do not suppress the error: a silently returned file without fonts looks intact,
            # but the problem surfaces for the reader, on another machine.
            from .html2pptx.font_embed import embed_fonts
            families = embed_fonts(staged_path, deck.skill_dir)
            log.info('[OK] fonts embedded: %s', ', '.join(families))
            os.replace(staged_path, base + '.pptx')
        pptx_path = base + '.pptx'
        log.info('[OK] PPTX written: %s', pptx_path)

        if not keep_html:
            os.remove(html_path)
            html_path = None

    for issue in issues:
        log.warning('%s', issue)

    return BuildResult(html_path, pptx_path, issues, len(deck.slides), sizes)
