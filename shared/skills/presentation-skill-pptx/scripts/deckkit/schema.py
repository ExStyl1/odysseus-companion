"""Pure slide field validation shared by JSON specs and image APIs."""
from . import elements as E
from . import layouts as L
from .html2pptx import formula
from .model import FormulaError

# chart-cards has no chart title: the slide title names the chart above it.
_CARDS_TITLE = (' - the chart on "chart-cards" has no title of its own: the '
                'slide title names it; take "chart" for a named chart')

# The fields of a native table (2.4.0); elements.Table checks them as one.
_TABLE_FIELDS = ('header', 'rows', 'tables', 'label_column', 'total_column')

# ------------------------------------------------------------------ validation

def _check_slide(raw, index, problems, _allow_draft=False):
    where = 'slide %d' % index
    if not isinstance(raw, dict):
        problems.append('%s: must be an object' % where)
        return {'layout': '?'}

    layout = raw.get('layout')
    if layout == 'bullets':
        # v2.0 folded it into cards. Specs and agents written before that
        # still reach for it, and a bare "unknown layout" leaves the rewrite
        # to be guessed.
        problems.append('%s: the "bullets" layout was folded into "cards" - a '
                        'list as the whole slide is one card with "items": '
                        '{"layout": "cards", "title": ..., "cards": [{"title": '
                        '..., "icon": ..., "items": [...]}]}' % where)
        return {'layout': layout}
    if not isinstance(layout, str) or layout not in L.PUBLIC \
            or (layout in L.DRAFT and not _allow_draft):
        problems.append('%s: unknown layout "%s"; allowed: %s'
                        % (where, layout,
                           ', '.join(sorted(set(L.PUBLIC) - L.DRAFT))))
        return {'layout': layout or '?'}

    where = 'slide %d (%s)' % (index, layout)
    record = L.PUBLIC[layout]
    required, optional = record.required, record.optional
    # 'notes' is not part of any layout's own fields - every layout can carry
    # optional speaker notes, written to the .pptx notes pane and nowhere else.
    allowed = ('layout', 'notes') + required + optional

    for key in raw:
        if key not in allowed:
            problems.append('%s: unknown field "%s"; allowed: %s%s'
                            % (where, key, E.offered(allowed),
                               _CARDS_TITLE if key == 'chart_title'
                               and layout == 'chart-cards' else ''))
    for key in required:
        value = raw.get(key)
        if value in (None, '', []) or (isinstance(value, str) and not value.strip()):
            problems.append('%s: the "%s" field is required' % (where, key))

    notes = raw.get('notes')
    if notes is not None and not isinstance(notes, str):
        problems.append('%s: the "notes" field must be a string, not %s'
                        % (where, type(notes).__name__))

    # Element fields are checked by their kind (elements.py); what is left
    # here are the scalar fields every layout shares.
    for key in required + optional:
        value = raw.get(key)
        if value is None:
            continue
        if key in record.kinds:
            record.kinds_of(raw)[key].check(value, where, problems)
        elif record.table and key in _TABLE_FIELDS:
            pass                        # E.TABLE.check, below
        elif key == 'highlight_last':
            if not isinstance(value, bool):
                problems.append('%s: "highlight_last" is true or false, not %r'
                                % (where, value))
        elif key == 'numbered':
            if not isinstance(value, bool):
                problems.append('%s: "numbered" is true or false, not %r'
                                % (where, value))
            elif value and isinstance(raw.get(record.element), list) \
                    and len(raw[record.element]) not in record.numbered:
                problems.append(
                    '%s: a numbered %s takes %s cards, got %d'
                    % (where, record.subject.split(' ', 1)[-1],
                       L._count_phrase(record.numbered),
                       len(raw[record.element])))
        elif key == 'items':
            E.check_str_list(value, key, where, problems)
        elif key == record.chart:
            E.CHART.check_list(value, where, problems)
        elif key == 'data' and record.chart == 'slide':
            # A CSV path, or the data itself: {categories, series}. The shape
            # of the inline object is checked when it is parsed, in
            # chartdata.from_inline, with the same messages as a CSV.
            if not isinstance(value, (str, dict)):
                problems.append(
                    '%s: the "data" field must be a CSV path or an object '
                    '{"categories": [...], "series": [...]}, not %s'
                    % (where, type(value).__name__))
        elif record.chart == 'slide' and key in E.Chart.LINE_FIELDS:
            pass                        # E.CHART.check_source, below
        elif key == 'look' and record.looks:
            pass                        # named with its options, below
        elif key == 'y':
            # A chart's value column: one header, or several for multi-series.
            if isinstance(value, list):
                E.check_str_list(value, key, where, problems)
            elif not isinstance(value, str):
                problems.append(
                    '%s: the "y" field must be a string or a list of strings, '
                    'not %s' % (where, type(value).__name__))
        elif not isinstance(value, str):
            problems.append('%s: the "%s" field must be a string, not %s'
                            % (where, key, type(value).__name__))

    look = raw.get('look')
    if 'fit' in record.optional and isinstance(raw.get('fit'), str):
        E.check_image_fit(raw['fit'], where, problems)
    if record.name == 'statement' and look == 'pattern':
        problems.append('%s: the "pattern" look was retired in 2.4.0 - take '
                        '"glass" (three lines) or "cards" (two)' % where)
    elif record.looks and look is not None and not isinstance(look, str):
        problems.append('%s: the "look" field must be a string, not %s - '
                        '"look" is one of %s'
                        % (where, type(look).__name__,
                           ', '.join('"%s"' % name for name in record.looks)))
    elif record.looks and isinstance(look, str) and look not in record.looks:
        problems.append('%s: "look" is one of %s, not "%s"'
                        % (where, ', '.join('"%s"' % name
                                            for name in record.looks), look))
    if record.chart == 'slide':
        E.CHART.check_source(raw, where, problems)
        refused = record.check_chart_type(raw.get('chart_type'))
        if refused:
            problems.append('%s: %s' % (where, refused))
    if record.table:
        E.TABLE.check(raw, record.table, where, problems)
    if 'note_icon' in record.slide_icons \
            and bool(raw.get('note')) != bool(raw.get('note_icon')):
        # An icon with no text beside it, or a note with nothing marking it,
        # both read as unfinished - the fields are a pair even though each is
        # optional on its own.
        problems.append(
            '%s: "note" and "note_icon" go together - set both or neither'
            % where)
    _check_formula_fields(raw, record, where, problems)
    return raw


def _check_formula_fields(raw, record, where, problems):
    """Reject intentional formula markup outside the body-text paths.

    Which paths take one is a property of the element kinds the layout holds
    (`Layout.formula_paths`), not a list kept here.
    """
    allowed = record.formula_paths()

    def walk(value, path):
        if isinstance(value, str):
            if path in allowed:
                return
            try:
                intended = formula.contains_formula(value)
            except FormulaError as exc:
                problems.append('%s: field "%s": %s' % (where, path, exc))
                return
            if intended:
                # `where` already names the slide and its layout, so naming
                # the layout again here read as `field "metrics.metrics[]
                # .value"` — the same word twice, in a message an author has
                # to map back onto their JSON.
                # Naming the fields that do take one is the fix itself: on a
                # metric it points at the caption, elsewhere it says there is
                # nowhere on this layout and the formula has to become prose.
                if allowed:
                    hint = 'on this layout formulas go in %s' % ', '.join(
                        '"%s"' % name for name in sorted(allowed))
                else:
                    hint = 'this layout takes no formulas - write it in prose'
                problems.append(
                    '%s: formulas are not allowed in field "%s"; %s'
                    % (where, path, hint))
            return
        if isinstance(value, list):
            for item in value:
                walk(item, path + '[]')
            return
        if isinstance(value, dict):
            for key, item in value.items():
                if key == 'layout':
                    continue
                walk(item, path + ('.' if path else '') + key)

    walk(raw, '')
