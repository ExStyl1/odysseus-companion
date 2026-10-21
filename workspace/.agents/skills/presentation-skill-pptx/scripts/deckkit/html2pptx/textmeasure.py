"""Text measurement and wrapping by REAL T-Sans font metrics.

Why this exists. PowerPoint wraps text itself, and if we relied on it,
lines would break differently than in the browser — card heights would
drift and everything below in the flow would misalign. So we compute
wraps ourselves using the same TTF files the HTML uses, and put already
wrapped lines into the PPTX.

Built on PIL.ImageFont (Pillow is in the environment; cairo/pango are not).
"""
import logging
import os
import re

from PIL import ImageFont

from . import sfnt
from .fonts import (FILE_BY_WEIGHT, FONT_DIR_NAME, FontSetError, face_info,
                    is_brand, normalize_weight)
from .formula import MathRun, math_width

log = logging.getLogger(__name__)

# Which file is which weight, and what PowerPoint calls it, both live in
# `fonts.py`. This module is about measurement and keeps only the runtime:
# directory resolution, the PIL cache and the advances cache.

# Where to look for the font directory, relative to the input HTML directory.
# Try from the HTML directory and from the connected CSS directory: the first
# option is the skill root, the second is the assets/ itself where base.css lives.
# The basename comes from `fonts` so that a rename of the directory is one edit.
_FONT_DIR_CANDIDATES = tuple(
    os.path.join(prefix, FONT_DIR_NAME)
    for prefix in ('assets/fonts', 'fonts', '../assets/fonts'))

_FALLBACKS = (
    '/System/Library/Fonts/Supplemental/Arial.ttf',
    '/System/Library/Fonts/Helvetica.ttc',
    '/Library/Fonts/Arial.ttf',
)


# The family a box falls back to when its CSS names none. The brand face, and
# the only family the skill ships.
DEFAULT_FAMILY = 'T-Sans'


class _Advances:
    """Exact character widths from font tables (units per em).

    PIL calculates width by rounding each glyph's advance to integer pixels
    at the given size. At 144px heading size this gives an error of ~10 pixels
    and causes extra line wraps. The browser works with fractional widths,
    so we take them directly from hmtx/cmap via fontTools.
    """

    def __init__(self, path):
        self.ok = False
        self.widths = {}
        self.upem = 1000
        self.default = 500
        found = sfnt.metrics(path)
        if found is None:
            log.debug('exact metrics unavailable for %s', path)
            return
        self.upem, self.widths, self.default = found
        self.ok = bool(self.widths)

    def length(self, text, size_px):
        total = 0
        for ch in text:
            total += self.widths.get(ord(ch), self.default)
        return total * float(size_px) / self.upem


class _MeasuredFont:
    """Wrapper: exact widths from fontTools + PIL metrics for baseline."""

    __slots__ = ('pil', 'adv', 'size')

    def __init__(self, pil_font, advances, size_px):
        self.pil = pil_font
        self.adv = advances
        self.size = size_px

    def getlength(self, text):
        if self.adv is not None and self.adv.ok:
            return self.adv.length(text, self.size)
        return self.pil.getlength(text)

    def getmetrics(self):
        return self.pil.getmetrics()


class FontBook:
    """Finds font files and returns PIL objects with caching."""

    def __init__(self, base_dir, extra_dirs=()):
        # Look for fonts not only next to HTML but also next to connected CSS:
        # the presentation can be anywhere, but styles and assets are in the skill.
        self.dir = None
        roots = [base_dir] + [d for d in extra_dirs if d]
        for root in roots:
            for rel in _FONT_DIR_CANDIDATES:
                path = os.path.normpath(os.path.join(root, rel))
                if os.path.isdir(path):
                    self.dir = path
                    break
            if self.dir:
                break
        if self.dir:
            log.info('[OK] fonts found: %s', self.dir)
        else:
            log.warning('[WARN] T-Sans font directory not found — '
                        'metrics will use fallback font, '
                        'line wraps may differ from HTML')
        self._cache = {}
        self._advances = {}
        self._faces = {}
        self._missing_reported = set()

    def _advances_for(self, path):
        if path not in self._advances:
            self._advances[path] = _Advances(path) if path else None
        return self._advances[path]

    def face(self, family, weight):
        """(typeface name for PPTX, bold flag) for the requested weight."""
        key = (family, normalize_weight(weight))
        cached = self._faces.get(key)
        if cached is not None:
            return cached
        path = self._file_for(family, weight)
        name, is_bold = face_info(path)
        if not name:
            # Fallback: CSS name as-is, bold by numeric weight.
            name = primary_family(family)
            is_bold = normalize_weight(weight) >= 600
        self._faces[key] = (name, is_bold)
        return self._faces[key]

    def _file_for(self, family, weight):
        family = (family or 't-sans').strip().strip('"\'').lower()
        # font-family can be a list: "'T-Sans', 'Arial', sans-serif".
        primary = family.split(',')[0].strip().strip('"\'').lower()
        weight = normalize_weight(weight)
        name = FILE_BY_WEIGHT.get((primary, weight))
        if name and self.dir:
            path = os.path.join(self.dir, name)
            if os.path.exists(path):
                return path
        # One of ours, and we cannot serve it: stop. Falling back here would
        # measure the box with Arial widths, write `a:latin typeface="Arial"`
        # and leave the run unembedded — a deck that is wrong in a way nothing
        # downstream can see, and wrong differently on each build machine. It
        # can only happen when a brand face reached the CSS without reaching
        # `fonts.FILE_BY_WEIGHT`, or when its file went missing.
        #
        # Scoped to the brand deliberately. `self.dir is None` (no font set at
        # all) stays a warning — that is graceful degradation, not a mistake —
        # and a non-brand family keeps the fallback, because a font we do not
        # ship could not be embedded even if we recognised it.
        if self.dir and is_brand(primary):
            raise FontSetError(
                '%s weight %s is not in fonts.FILE_BY_WEIGHT (or its file is '
                'missing from %s) — a brand face must not fall back'
                % (primary, weight, self.dir))
        if primary not in self._missing_reported and self.dir:
            log.warning('[WARN] weight %s %s missing — using fallback', primary, weight)
            self._missing_reported.add(primary)
        for fb in _FALLBACKS:
            if os.path.exists(fb):
                return fb
        return None

    def get(self, family, weight, size_px):
        """PIL font of the requested weight and size (size in px)."""
        key = (family, normalize_weight(weight), round(float(size_px), 1))
        font = self._cache.get(key)
        if font is not None:
            return font
        path = self._file_for(family, weight)
        size = max(1, int(round(float(size_px))))
        try:
            pil = ImageFont.truetype(path, size) if path else ImageFont.load_default()
        except Exception as exc:                       # noqa: BLE001
            log.warning('[WARN] font failed to load (%s): %s', path, exc)
            pil = ImageFont.load_default()
            path = None
        font = _MeasuredFont(pil, self._advances_for(path), float(size_px))
        self._cache[key] = font
        return font


def primary_family(value):
    """`'T-Sans', 'Arial', sans-serif` → `T-Sans`; the default when empty."""
    if not value:
        return DEFAULT_FAMILY
    return str(value).split(',')[0].strip().strip('"\'') or DEFAULT_FAMILY


class Run:
    """A piece of text with its own weight (e.g. inside <strong>)."""

    __slots__ = ('text', 'weight')

    def __init__(self, text, weight):
        self.text = text
        self.weight = weight

    def __repr__(self):
        return 'Run(%r, %s)' % (self.text, self.weight)


def baseline_offset(line_box, descent):
    """Baseline within a line box, measured from its top.

    The one formula, used by everything that has to agree with the text:
    `layout` records line baselines from it, the PNG rasteriser draws from
    those values, and `autofit` places the bullet marker against it.

    PowerPoint sets text on the **bottom** of an exact line box. Every line is
    written as its own paragraph with `line_spacing` in points
    (`render._add_text`), and the baseline then sits `descent` above that
    box's bottom edge. This function used to compute CSS half-leading instead —
    centring the font box inside the line — and claimed in its own docstring
    that PowerPoint did the same. It does not.

    The mistake was invisible for three releases because on a prose line the
    two rules land within ~1px of each other and of the truth. At 140% leading
    the slack is 0.169 em — 5.75px at 34px type — so half-leading puts the
    baseline 2.9px above the bottom-aligned one, and a measured export puts the
    real one between the two. What closes that last 2px is not the leading rule
    but the second face on the line: see MATH_LINE_DESCENT_EM.

    A formula line is where they part. Its box is the 1.16 height reserve, so
    the slack is 0.16*(ascent+descent) — 15px on slide 12 of the test deck,
    not 6 — and half-leading spends half of that below the baseline. Against a
    desktop export of 22 bullets: bottom-align is out by 2.1px on that line,
    half-leading by 9.6px, and on the tallest line in the deck by 2.1 against
    11.4. The old rule was out by −19 to +6 and changed sign between formulas,
    which is what made it look like no single rule could work.

    `descent` must be the real descent of the tallest thing on the line and
    never a reserved one. The math height reserve exists to keep a formula
    inside its box; feeding it in here moved the text instead of padding it,
    by exactly 0.16*raw_descent.
    """
    return line_box - descent


def measure_runs(runs, fontbook, family, size_px):
    """Total line width from runs in px."""
    total = 0.0
    for run in runs:
        if isinstance(run, MathRun):
            total += math_width(run.mathtext, size_px, run.weight)
            continue
        if not run.text:
            continue
        font = fontbook.get(family, run.weight, size_px)
        total += font.getlength(run.text)
    return total


def wrap_runs(runs, max_width, fontbook, family, size_px):
    """Greedy word wrap preserving weights.

    Returns a list of lines, each line a list of Runs. An empty run list
    means an empty line (e.g. two <br> in a row).
    """
    if max_width is None or max_width <= 0:
        return [list(runs)]

    # Split into 'word + following space' so spaces are not lost.
    tokens = []
    for run in runs:
        if isinstance(run, MathRun):
            tokens.append(run)
            continue
        text = run.text
        if not text:
            continue
        buf = ''
        for ch in text:
            buf += ch
            if ch == ' ':
                tokens.append(Run(buf, run.weight))
                buf = ''
        if buf:
            tokens.append(Run(buf, run.weight))

    lines = []
    current = []
    current_width = 0.0

    for token in tokens:
        if isinstance(token, MathRun):
            width = width_no_trail = math_width(
                token.mathtext, size_px, token.weight)
        else:
            font = fontbook.get(family, token.weight, size_px)
            width = font.getlength(token.text)
            # Trailing space does not affect line wrap.
            width_no_trail = font.getlength(token.text.rstrip(' '))

        if current and current_width + width_no_trail > max_width + 0.5:
            lines.append(_strip_trailing_space(current))
            current = [token]
            current_width = width
        else:
            current.append(token)
            current_width += width

    if current:
        lines.append(_strip_trailing_space(current))
    return lines or [[]]


def _strip_trailing_space(runs):
    """Remove trailing prose space without changing formula-run identity."""
    out = [r if isinstance(r, MathRun) else Run(r.text, r.weight) for r in runs]
    while out and not isinstance(out[-1], MathRun) and not out[-1].text.strip():
        out.pop()
    if out and not isinstance(out[-1], MathRun):
        out[-1] = Run(out[-1].text.rstrip(' '), out[-1].weight)
    return out


def line_height_px(line_height_value, font_size_px):
    """CSS `line-height` → line height in px.

    Supports percentages ('90%'), absolute px ('65px'), unitless multiplier,
    and `normal` (taken as 1.2 — like most browsers).
    """
    if line_height_value is None:
        return font_size_px * 1.2
    text = str(line_height_value).strip().lower()
    if text in ('normal', ''):
        return font_size_px * 1.2
    if text.endswith('%'):
        try:
            return font_size_px * float(text.rstrip('%')) / 100.0
        except ValueError:
            return font_size_px * 1.2
    if text.endswith('px'):
        try:
            return float(text[:-2])
        except ValueError:
            return font_size_px * 1.2
    try:
        return font_size_px * float(text)
    except ValueError:
        return font_size_px * 1.2
