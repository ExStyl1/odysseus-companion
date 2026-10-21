"""Conversion entry point: HTML → PPTX.

Universal pass: find all `div.slide` elements, compute styles, lay out
with generic engine and render. Slide type is not recognized and not needed —
all difference between the template's types is expressed in CSS the engine
executes. The engine's own vocabulary is two replaced elements, a chart
(`<div class="chart-canvas" data-chart>`) and an inline formula
(`<span class="math" data-latex data-mathtext>`); anything else a caller
knows about its markup - which classes to group - it passes in.

Parsing, the stylesheet, the fonts and the layout all live in `document.py`;
what is left here is the render. `write_pptx` takes an open `Document` rather
than a path so that a caller which has already laid the deck out — the build
does, to pick type sizes and to validate — hands the measurement over instead
of paying for it a third time.
"""
import logging
import os
import tempfile

from .document import Document
from .render import Renderer
from .paint import PaintError

log = logging.getLogger(__name__)


def convert(input_path, output_path=None, cache_dir=None, extra_css=None):
    """Convert HTML presentation to PPTX. Return path to result."""
    document = Document.open(input_path, extra_css=extra_css)
    if output_path is None:
        output_path = os.path.splitext(document.path)[0] + '.pptx'
    return write_pptx(document, output_path, cache_dir)


def write_pptx(document, output_path, cache_dir=None, group_roots=()):
    """Render an open document to PPTX. Return path to result.

    `group_roots` names the classes whose boxes are one design object drawn
    as several shapes, to be grouped back into one (see `grouping.py`).
    """
    if cache_dir is None:
        cache_dir = os.path.join(tempfile.gettempdir(), 'html2pptx-cache')

    if not document.elements:
        log.error('[ERROR] no div.slide found in file — '
                  'markup not recognized, result would be empty')
        raise SystemExit(2)

    log.info('[OK] slides found: %d', len(document.elements))

    assets = document.assets(cache_dir)
    renderer = Renderer(assets, document.fonts, group_roots=group_roots)

    diagnostics = []
    for index, element in enumerate(document.elements, 1):
        try:
            painted = renderer.render_slide(document.box(index), index)
        except PaintError as exc:
            diagnostics.extend(exc.diagnostics)
            continue
        log.info('[OK] slide %02d: elements rendered %d (%s)',
                 index, painted, _describe(element))

    if diagnostics:
        raise PaintError(diagnostics)
    renderer.save(output_path)
    log.info('[OK] saved: %s', output_path)
    if assets.missing:
        log.warning('[WARN] assets not found: %d — %s',
                    len(assets.missing), ', '.join(assets.missing[:5]))
    return output_path


def _describe(el):
    """Short slide caption for log — by title or classes."""
    for xp in ('.//h1', './/*[contains(@class,"title")]',
               './/*[contains(@class,"slide-title")]'):
        found = el.xpath(xp)
        if found:
            text = ' '.join(''.join(found[0].itertext()).split())
            if text:
                return text[:48]
    classes = ' '.join(sorted(set((el.get('class') or '').split())))
    return classes or 'no title'
