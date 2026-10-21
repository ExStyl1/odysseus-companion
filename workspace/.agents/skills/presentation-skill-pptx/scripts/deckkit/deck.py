# -*- coding: utf-8 -*-
"""Public deck API: one method per slide layout.

Each method corresponds to a template layout. Card counts are fixed per layout,
so errors like "7 cards in a 6-card grid" are caught at call time, not in the
final file.

The methods are sugar. All of them go through `add()`, which reads the rule out
of `layouts.PUBLIC` — the count, the physical variant it selects and how icons
reach the slide. Before 1.5 each method restated those three things itself, and
the counts lived here while the fragment they chose lived in two other files.
"""
import copy
import os

from . import build as B
from . import fragments as F
from . import layouts as L
from . import elements as E
from . import media as M
from .schema import _check_slide
from .icons import IconLibrary, IconAllocator, default_index_path, default_concepts_path
from .model import Slide


class Deck(object):
    def __init__(self, skill_dir=None):
        self.skill_dir = skill_dir or F.find_skill_dir()
        self.fragments = F.FragmentLibrary(self.skill_dir)
        self.icons = IconLibrary(
            default_index_path(self.skill_dir),
            default_concepts_path(self.skill_dir)
        )
        self.allocator = IconAllocator(self.icons)
        self.slides = []
        self.doc_title = None

    # -------------------------------------------------------------- slides

    def title(self, text, subtitle=None, author=None):
        """Title slide. Newlines in text split the headline."""
        return self.add('title', {
            'text': text, 'subtitle': subtitle or '', 'author': author})

    def agenda(self, title, items):
        """Agenda: 2 to 6 items, numbering auto-generated."""
        return self.add('agenda', {'title': title, 'items': list(items)})

    def cards(self, title, cards):
        """Row of 1–4 cards. Last card is yellow per template."""
        return self.add('cards', {'title': title, 'cards': list(cards)})

    def grid(self, title, cards):
        """Two-row grid: 4, 6 or 8 cards."""
        return self.add('grid', {'title': title, 'cards': list(cards)})

    def complex_cards(self, title, cards):
        """Four cards left, one tall card right — emphasis on the last."""
        return self.add('complex', {'title': title, 'cards': list(cards)})

    def pyramid(self, title, cards):
        """Three cards top, two bottom: from details to conclusions."""
        return self.add('pyramid', {'title': title, 'cards': list(cards)})

    # -------------------- v1.4: new slide families

    def timeline(self, title, points, look=None):
        """Timeline: 3, 4, or 5 points with numbered circles and connector line.

        points: list of dicts with 'text' (required) and 'title' (optional).
        For 3 points, decorative discs appear on the right background.
        look: 'grey' (default) or 'yellow' (4 or 5 points only).
        """
        return self.add('timeline', {'title': title, 'points': list(points),
                                     'look': look})

    def flow(self, title, steps, summary=None, look=None, highlight_last=False):
        """Flow: 4 or 5 steps with icons in a white rounded panel.

        steps: list of dicts with 'icon' (icon name/keyword) and 'text'.
        summary: optional {'title', 'text'} block along the bottom of the
        panel. Leaving it out hands its share of the panel back to the step
        captions, so the row does not sit at the top with empty space below.
        look: 'line' (default) or 'zigzag' (alternating captions, no summary).
        highlight_last: a bool, yellow last circle and connector in either look.
        """
        return self.add('flow', {'title': title, 'steps': list(steps),
                                 'summary': summary, 'look': look,
                                 'highlight_last': highlight_last})

    def columns(self, title, columns):
        """Columns dark: 3 to 6 columns on dark background with yellow header.

        columns: list of dicts with 'title' and 'text'.
        """
        return self.add('columns', {'title': title, 'columns': list(columns)})

    def text(self, text, look=None):
        """A statement: one phrase across the slide, on glass by default.

        `look` is "glass" or "cards" (two lines), as in the spec.
        """
        data = {'text': text}
        if look:
            data['look'] = look
        return self.add('statement', data)

    def text_slide(self, title, text):
        """Draft text slide: a heading and bottom-anchored prose."""
        return self.add('text-slide', {'title': title, 'text': text})

    def metrics(self, title, subtitle, metrics):
        """Three large numbers or six in a grid."""
        return self.add('metrics', {
            'title': title, 'subtitle': subtitle or '',
            'metrics': list(metrics)})

    def image(self, title, src, note_icon=None, note=None, caption=None):
        """Legacy draft: a JPEG/PNG on the right, title and an optional note
        (icon + text) on the left. `src` must resolve to a readable PNG/JPEG —
        checked now, so a bad path surfaces before anything is written.
        """
        return self.add('image', {
            'title': title, 'src': src, 'note_icon': note_icon,
            'note': note or '', 'caption': caption or ''})

    def image_points(self, title, src, points, look=None, notes=None, fit=None):
        """One PNG/JPEG with 1–5 text/icon takeaways; plates by default."""
        return self.add('image-points', {
            'title': title, 'src': src, 'points': points, 'look': look, 'fit': fit},
            notes=notes)

    def self_intro(self, name, role, src, items, notes=None):
        """Speaker introduction with a photo and 2–4 bottom-aligned bullets."""
        return self.add('self-intro', {
            'name': name, 'role': role, 'src': src, 'items': items}, notes=notes)

    def circle(self, title, points, cards, notes=None):
        """Orbit diagram with three to six nodes and exactly two icon cards."""
        return self.add('circle', {'title': title, 'points': points,
                                  'cards': cards}, notes=notes)

    def illustration_points(self, title, points, notes=None):
        """Yellow illustration card with 2–4 titled icon takeaways."""
        return self.add('illustration-points', {'title': title, 'points': points},
                        notes=notes)

    def image_gallery(self, title, images, notes=None):
        """Two or three PNG/JPEG images, each with title, text and icon."""
        return self.add('image-gallery', {'title': title, 'images': images},
                        notes=notes)

    def screenshot_phone(self, title, text, images, fit=None, notes=None):
        """1–3 app screens, optional annotations; top-aligned cover by default."""
        return self.add('screenshot-phone', {
            'title': title, 'text': text, 'images': images, 'fit': fit},
            notes=notes)

    def screenshot_monitor(self, title, src, points, fit=None, notes=None):
        """One desktop screen with 1–4 top-aligned icon points."""
        return self.add('screenshot-monitor', {
            'title': title, 'src': src, 'points': points, 'fit': fit},
            notes=notes)

    def chart(self, title, data, x=None, y=None, chart_type='bar', mode=None,
              points=None, chart_title=None, center=None, value_labels=None,
              fill=None, number_format=None, look=None):
        """Chart slide: a native, editable chart, with 1-5 points on the left.

        points: a list of 1-5 {"text": …, "icon": …} dicts (icon required —
                the designer forbids an icon-less point, I1) —
        required; there is no note-only variant. data: a CSV path (then x/y
        name its columns) or the data itself, {'categories': [...], 'series':
        [{'name': ..., 'values': [...]}]}. chart_type: one of
        chartgeom.CHART_TYPES. mode: None, or 'value' to colour a single
        series of bars by sign. chart_title names the chart on the plate;
        center is the big figure inside a doughnut's ring, one line (the
        figure and its unit), linked to a workbook cell. A line chart
        also takes value_labels (True: every point labelled, on at most 2
        lines of 8 points); fill (areas) is off unless chart-palette.json
        features.line_fill is true. number_format: the Excel format code of
        the source cells ('0%', '#,##0', '0.0" млн"'), percentages given as
        fractions as Excel holds them; the labels and the workbook take it.
        look: 'plate' (the default, one white card) or 'plates' (2.4.0, the
        designers' charts_new: a stack of three, less room for the chart).
        """
        return self.add('chart', {
            'title': title, 'data': data, 'x': x, 'y': y,
            'chart_type': chart_type, 'mode': mode, 'points': points or [],
            'chart_title': chart_title, 'center': center,
            'value_labels': value_labels, 'fill': fill,
            'number_format': number_format, 'look': look})

    def table(self, title, header, rows, label_column=None, total_column=None,
              notes=None):
        """A native table on a fixed white card.

        header: 2-6 column headings. rows: up to 8 lists of cells, one per
        column; a cell is a string or {"text": ..., "tone": "positive" |
        "negative"} - green or red, the one place values are coloured
        outside a chart. A column of figures is set to the right by itself.
        label_column / total_column: the first / last column in Medium.
        """
        return self.add('table', {
            'title': title, 'header': header, 'rows': rows,
            'label_column': label_column, 'total_column': total_column},
            notes=notes)

    def table_compare(self, title, tables, notes=None):
        """Two small native tables side by side, yellow and grey.

        tables: exactly two {"title": ..., "rows": [{"label": ..., "value":
        ..., "tone": ...}]}, 2-6 rows each; values are set to the right in
        Medium.
        """
        return self.add('table-compare', {'title': title, 'tables': tables},
                        notes=notes)

    def final(self, text=None, notes=None):
        """Closing slide."""
        # Slide CONTENT stays Russian. Only what the calling agent reads -
        # SKILL.md, references/, log messages - is English. A comment-translation
        # pass turned this default into English and every deck built without an
        # explicit closing text silently shipped an English last slide.
        return self.add('final', {'text': text or 'Спасибо\nза внимание'},
                        notes=notes)

    # ---------------------------------------------------------------- add

    def add(self, layout, data, notes=None):
        """Add a slide by public layout name, with the spec's own field names.

        This is the one place that turns a public name into a physical layout.
        The count is checked before icons are looked up: a slide that is wrong
        in both ways reports the count, which is the error the author can act
        on without knowing the icon set. `notes` is speaker notes text, the
        same for every layout - it never affects the slide's own layout choice
        or content, only the .pptx notes pane.
        """
        record = L.PUBLIC.get(layout)
        if record is None:
            raise ValueError('unknown layout "%s"; allowed: %s'
                             % (layout, ', '.join(sorted(L.PUBLIC))))
        if not isinstance(data, dict):
            raise ValueError('slide data must be an object')
        for key in ('layout', 'notes'):
            if key in data:
                raise ValueError('"%s" is an argument to Deck.add, not a slide data field'
                                 % key)
        # One schema for both entry paths (P22.03): the pure checks a spec
        # gets run here too, before counts, file reads or icon allocation.
        # Card/Metric objects and tuples are the API's conveniences; the kind
        # supplies a spec view for the checks and materialises tuple values
        # before the deck takes ownership of the adapted data.
        data = dict(data)
        checked = dict(data)
        for field, kind in record.kinds_of(data).items():
            if data.get(field) is not None:
                data[field], checked[field] = kind.adapt(data[field])
        problems = []
        _check_slide(dict(checked, layout=layout, notes=notes),
                     len(self.slides) + 1, problems, _allow_draft=True)
        if problems:
            raise ValueError('\n'.join(problems))
        record.check_count(data)
        picked = record.variant(data)
        # Normalisation replaces nested chart data and resolves icons in place.
        # Own the validated input; tuple item iterators were materialised above.
        data = copy.deepcopy(data)
        record.normalise(data, self.allocator, self.skill_dir)
        if 'src' in record.required:
            self._resolve_image(data)
        return self._add(picked, data, notes=notes)

    @staticmethod
    def _resolve_image(data):
        """Validate the picture an image slide carries.

        Same discipline as icons and charts: a bad path surfaces here, before
        anything is written to disk, not as a broken picture discovered only
        in the final file.
        """
        M.resolve_image(data['src'])
        # Absolute: `AssetResolver.resolve()` (html2pptx/assets.py) treats a
        # relative path as relative to the *output HTML's* directory, not the
        # caller's cwd where this validation just ran — a relative `src` would
        # pass here and then silently paint nothing.
        data['src'] = os.path.abspath(data['src'])

    # -------------------------------------------------------------- build

    def build(self, out_path, title=None, strict=True, pptx=True, keep_html=False):
        """Build presentation. Returns object with paths and warnings."""
        return B.build(self, out_path, title=title, strict=strict, pptx=pptx,
                       keep_html=keep_html)

    # -------------------------------------------------------------- internal

    def _add(self, layout, data, notes=None):
        self.slides.append(Slide(layout, data, notes=notes))
        return self

    def __len__(self):
        return len(self.slides)

    def __repr__(self):
        return 'Deck(%d slides)' % len(self.slides)
