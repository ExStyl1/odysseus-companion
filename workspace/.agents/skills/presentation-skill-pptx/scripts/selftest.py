#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Skill self-test: layouts, spec, icon matching, build.

Run after any change to template, layout registry, or documentation —
checks catch exactly the mismatches that silently break the skill:
fragment diverged from template, layout documented but not implemented,
asset missing from disk.

    python3 scripts/selftest.py
    python3 scripts/selftest.py --verbose

Return codes: 0 — all passed, 1 — failures.
"""
import argparse
import collections
import copy
import json
import io
import logging
import os
import posixpath
import re
import shutil
import subprocess
import sys
import tempfile
import traceback
import zipfile

from lxml import etree
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from deckkit import Card, Deck, Metric, SpecError               # noqa: E402
from deckkit import chartdata as CD                              # noqa: E402
from deckkit import elements as E                               # noqa: E402
from deckkit import fragments as F                              # noqa: E402
from deckkit import layouts as L                                # noqa: E402
from deckkit import media as MD                                  # noqa: E402
from deckkit import slides as S                                 # noqa: E402
from deckkit import spec as SP                                  # noqa: E402
from deckkit import validate as VD                              # noqa: E402
from deckkit.html2pptx import chartgeom as G                     # noqa: E402
from deckkit.html2pptx import formula as FM                      # noqa: E402
from deckkit.html2pptx.document import Document, parse_html     # noqa: E402
from deckkit.html2pptx.formula import MathRun                    # noqa: E402
from deckkit.model import (BuildError, ChartDataError, FormulaError, Slide,
                           IconNotFound, MediaError)              # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL = os.path.dirname(HERE)

FAILED = []
VERBOSE = False

# Icons live in `assets/icons/icons.zip`, not loose: 355 files would not fit
# the marketplace's 200-file limit. So `os.path.isfile` is no longer a valid
# test for an icon, and all "asset exists" checks go through asset_exists.
_ARCHIVE_CACHE = {}


def _archive_members(archive):
    if archive not in _ARCHIVE_CACHE:
        names = frozenset()
        if os.path.isfile(archive):
            try:
                with zipfile.ZipFile(archive) as z:
                    names = frozenset(n for n in z.namelist()
                                      if not n.endswith('/'))
            except (zipfile.BadZipFile, OSError):
                names = frozenset()
        _ARCHIVE_CACHE[archive] = names
    return _ARCHIVE_CACHE[archive]


def icon_archive(skill_dir=None):
    return os.path.join(skill_dir or SKILL, 'assets', 'icons', 'icons.zip')


def _norm_ru(text):
    """Same normalization as icon matching: lowercase and ё→е."""
    return (text or '').lower().replace('ё', 'е')


def asset_exists(path):
    """Asset exists: on disk or, if it's an icon, inside icons.zip."""
    if os.path.isfile(path):
        return True
    directory, name = os.path.split(os.path.normpath(path))
    if not name or os.path.basename(directory) != 'icons':
        return False
    return name in _archive_members(os.path.join(directory, 'icons.zip'))


def read_text(path):
    with open(path, 'r', encoding='utf-8') as f:
        return f.read()


def cut_template_slides(doc):
    """Template slides cut by the same markers that sync_layouts.py uses.

    sync_layouts itself can't be imported: it lives right next door in
    scripts/, but it drags along its argparse scaffolding and printing.
    There's one regex for both, so if the markers in the template ever
    change, both places break equally visibly.
    """
    import sync_layouts

    return sync_layouts.cut_slides(doc)


def check(name, condition, detail=''):
    if condition:
        if VERBOSE:
            sys.stdout.write('[OK]   %s\n' % name)
    else:
        sys.stdout.write('[FAIL] %s%s\n' % (name, (' — ' + detail) if detail else ''))
        FAILED.append(name)


def run(func, *args):
    """Call one test, and survive it raising.

    `check` collects failures and carries on, so a test that fails a check
    never stopped the suite. An exception the checks never see — an
    IndexError in a helper, a missing attribute after a refactor, anything
    outside a `check` call — is a different matter: `main` used to call the
    47 tests as bare statements, so the first one to raise aborted the run.
    The remaining tests did not execute, and the `FAILED n:` summary was not
    printed either, so one broken test hid the state of every test after it.
    """
    try:
        func(*args)
    except Exception as exc:                    # noqa: BLE001 — that is the point
        check('%s did not finish' % func.__name__, False,
              '%s: %s' % (type(exc).__name__, exc))
        traceback.print_exc(file=sys.stdout)


def leaf_shapes(collection):
    """Every drawn shape in tree order, descending into groups.

    `slide.shapes` is top level only, and since v1.7 the layers of a single
    design object — a glass panel, a ring, a badge — live inside a group. A
    check that iterates the slide directly stops seeing them, which is how the
    glass-shadow check went red the moment grouping arrived.
    """
    out = []
    for shape in collection:
        nested = getattr(shape, 'shapes', None)
        if nested is None:
            out.append(shape)
        else:
            out.extend(leaf_shapes(nested))
    return out


def skeleton(element):
    """Structural fingerprint: tags, classes and styles without text.

    Text changes — layout does not. If assembled slide fingerprint matches
    reference, builder has not moved or lost anything.
    """
    parts = []
    for node in element.iter():
        if not isinstance(node.tag, str):
            continue
        parts.append('%s|%s|%s' % (node.tag, node.get('class', ''),
                                   node.get('style', '')))
    return parts


# ------------------------------------------------------------------ layout

def test_layouts_match_reference(deck):
    """Each layout assembles to exactly the same markup as reference."""
    library = deck.fragments
    cases = [
        # In title and final reference, heading is split to two lines,
        # so pass text with newline here too — otherwise <br> disappears and
        # fingerprints legitimately diverge by one node.
        ('title', {'text': 'первая\nвторая', 'subtitle': 'п', 'author': 'а'}),
        ('cards-1', {'title': 'з', 'cards': [Card('a', 'b', None)]}),
        ('cards-2', {'title': 'з', 'cards': [Card('a', 'b'), Card('c', 'd')]}),
        ('cards-3', {'title': 'з', 'cards': [Card('a'), Card('b'), Card('c')]}),
        ('cards-4', {'title': 'з', 'cards': [Card(str(i)) for i in range(4)]}),
        ('grid-2x2', {'title': 'з', 'cards': [Card(str(i)) for i in range(4)]}),
        ('grid-2x3', {'title': 'з', 'cards': [Card(str(i)) for i in range(6)]}),
        ('grid-2x4', {'title': 'з', 'cards': [Card(str(i)) for i in range(8)]}),
        ('complex', {'title': 'з', 'cards': [Card(str(i)) for i in range(5)]}),
        ('pyramid', {'title': 'з', 'cards': [Card(str(i)) for i in range(5)]}),
        ('statement-glass', {'text': 'коротко'}),
        ('statement-cards', {'text': 'коротко'}),
        ('final', {'text': 'спасибо\nвсем'}),
    ]
    for layout, data in cases:
        # Icons not specified, so built slide has no icon blocks —
        # compare with reference where they are also removed.
        reference = library.load(layout)
        for holder in F.by_class(reference, 'icon-container'):
            holder.getparent().remove(holder)

        built = S.render(library, layout, data, deck.icons, '')
        same = skeleton(built) == skeleton(reference)
        check('layout %s markup matches reference' % layout, same,
              'nodes: %d vs %d' % (len(skeleton(built)), len(skeleton(reference))))


def test_trimming(deck):
    """Extra repeated blocks are removed, not left empty."""
    agenda = S.render(deck.fragments, 'agenda',
                      {'title': 'з', 'items': ['раз', 'два', 'три']}, deck.icons, '')
    check('agenda has 3 items',
          len(F.by_class(agenda, 'agenda-number')) == 3)
    numbers = [n.text for n in F.by_class(agenda, 'agenda-number')]
    check('item numbering is sequential', numbers == ['01', '02', '03'], str(numbers))

    listed = S.render(deck.fragments, 'cards-1',
                      {'title': 'з', 'cards': [Card('к', items=['a', 'b'])]},
                      deck.icons, '')
    check('list has 2 items',
          len(F.by_class(listed, 'bullet-item')) == 2)

    metrics = S.render(deck.fragments, 'metrics-3col',
                       {'title': 'з', 'subtitle': 'п',
                        'metrics': [Metric('1', 'раз'), Metric('2', 'два')]},
                       deck.icons, '')
    check('2 metrics remain',
          len(F.by_class(metrics, 'metric-value-large')) == 2)


def test_input_ownership(out_dir):
    """Normalisation owns its nested data, on success and partial failure."""
    def chart(title):
        return {'chart_type': 'bar', 'chart_title': title,
                'data': {'categories': ['2024', '2025'],
                         'series': [{'name': 'Revenue', 'values': [3, 4]}]}}

    for shared in (False, True):
        first = chart('Revenue')
        raw = {'title': 'Two charts',
               'charts': [first, first if shared else chart('Clients')]}
        original = copy.deepcopy(raw)
        spec = {'slides': [dict(raw, layout='chart-two')]}
        for attempt in (1, 2):
            for route in ('spec', 'add'):
                label = 'ownership: %s shared=%s attempt=%d' % (route, shared, attempt)
                try:
                    deck = (SP.deck_from_spec(spec, skill_dir=SKILL) if route == 'spec'
                            else Deck(skill_dir=SKILL).add('chart-two', raw))
                    result = deck.build(os.path.join(out_dir, 'owned-%s-%s-%s'
                                                    % (route, shared, attempt)),
                                        strict=False)
                    check(label + ' builds', not result.errors, repr(result.issues))
                except Exception as exc:
                    check(label + ' builds', False, str(exc))
                check(label + ' preserves source', raw == original)
                try:
                    json.dumps(spec)
                    serializable = True
                except TypeError:
                    serializable = False
                check(label + ' keeps JSON data', serializable)

    raw = {'title': 'Two charts', 'charts': [chart('Revenue'), chart('Clients')]}
    raw['charts'][1]['data']['series'][0]['values'][1] = 'invalid'
    original = copy.deepcopy(raw)
    for route in ('spec', 'add'):
        _raises('ownership: %s refuses second chart data' % route,
                (SpecError, ChartDataError), 'not a number',
                lambda: SP.deck_from_spec({'slides': [dict(raw, layout='chart-two')]},
                                         skill_dir=SKILL) if route == 'spec'
                else Deck(skill_dir=SKILL).add('chart-two', raw))
        check('ownership: %s failure preserves both charts' % route, raw == original)
        # Restore the fixture for the other route even on a broken implementation.
        raw = copy.deepcopy(original)

    data = {'title': 'Two charts', 'charts': [chart('Revenue'), chart('Clients')]}
    deck = Deck(skill_dir=SKILL).add('chart-two', data)
    data['charts'][0]['chart_title'] = 'Changed by caller'
    data['charts'][0]['data']['series'][0]['values'][0] = 999
    check('ownership: later caller edits do not alter stored charts',
          deck.slides[0].data['charts'][0]['chart_title'] == 'Revenue'
          and deck.slides[0].data['charts'][0]['data'].series[0].values == [3, 4])

    raw = {'title': 'Agenda', 'items': ['First', 'Second']}
    deck = Deck(skill_dir=SKILL).add('agenda', raw)
    raw['items'][0] = 'Caller edit'
    check('ownership: later caller edits do not alter agenda items',
          deck.slides[0].data['items'] == ['First', 'Second'])


def test_reused_card_ownership():
    """Each card occurrence receives its own icon and bullet-list storage."""
    card = Card('Growth', 'Short text', 'рост', ['First', 'Second'])
    deck = Deck(skill_dir=SKILL)
    deck.cards('Shared card', [card, card])
    first, second = deck.slides[0].data['cards']
    check('ownership: repeated card produces independent objects',
          first is not second and first is not card and second is not card)
    check('ownership: repeated concept receives distinct slide icons',
          first.icon != second.icon)
    check('ownership: caller card retains all fields',
          (card.title, card.text, card.icon, card.items, card.value)
          == ('Growth', 'Short text', 'рост', ['First', 'Second'], None))
    first.items.append('Internal edit')
    check('ownership: repeated card bullet lists are independent',
          second.items == ['First', 'Second'] and card.items == ['First', 'Second'])
    deck.cards('Another slide', [card, card])
    another = Deck(skill_dir=SKILL).cards('Another deck', [card, card])
    check('ownership: slide and deck reuse resolves the original concept',
          [c.icon for c in deck.slides[1].data['cards']]
          == [c.icon for c in another.slides[0].data['cards']]
          and len(set(c.icon for c in another.slides[0].data['cards'])) == 2)
    card.title = 'Caller edit'
    card.items.append('Caller bullet')
    check('ownership: later caller edits do not alter stored cards',
          first.title == 'Growth' and second.items == ['First', 'Second'])

    failed_card = Card('Growth', 'Short text', 'рост', ['First'])
    _raises('ownership: missing second icon is reported', IconNotFound,
            'no icon matched', lambda: Deck(skill_dir=SKILL).cards('Bad icon',
                [failed_card, Card('Other', 'Short text', 'missing-p22-icon')]))
    check('ownership: failed allocation leaves caller card unchanged',
          failed_card.icon == 'рост' and failed_card.items == ['First'])

    for numbered in (False, True):
        for representation in ('dict', 'tuple', 'Card'):
            icon = None if numbered else 'рост'
            if representation == 'dict':
                item = {'title': 'Growth', 'text': 'Short text', 'items': ['First']}
                if icon is not None:
                    item['icon'] = icon
            elif representation == 'tuple':
                item = ('Growth', 'Short text', icon, ['First'])
            else:
                item = Card('Growth', 'Short text', icon, ['First'])
            raw = {'title': 'Cards', 'cards': [item, item], 'numbered': numbered}
            result = Deck(skill_dir=SKILL).add('cards', raw).slides[0].data['cards']
            result[0].items.append('Internal edit')
            source_items = (item['items'] if representation == 'dict' else
                            item[3] if representation == 'tuple' else item.items)
            check('ownership: %s numbered=%s separates occurrences' %
                  (representation, numbered), result[0] is not result[1]
                  and result[1].items == ['First'] and source_items == ['First'])

    reads = []
    def bullets():
        reads.append('read')
        yield 'First'
        yield 'Second'
    result = Deck(skill_dir=SKILL).cards('Iterator',
        [('Growth', '', 'рост', bullets())]).slides[0].data['cards'][0]
    check('ownership: tuple items iterator is consumed once before copying',
          reads == ['read'] and result.items == ['First', 'Second'])


def test_card_items(deck):
    """Bullet markers inside card: markup taken from reference."""
    built = S.render(deck.fragments, 'cards-2',
                     {'title': 'з', 'cards': E.CARD.normalise([
                         {'title': 'Раз', 'items': ['a', 'b', 'c']},
                         {'title': 'Два', 'text': 'вводная', 'items': ['d']}],
                         deck.allocator)},
                     deck.icons, '')
    check('bullet lists appear in cards',
          len(F.by_class(built, 'bullet-list')) == 2)
    check('first card has 3 items',
          len(F.by_class(F.by_class(built, 'card')[0], 'bullet-item')) == 3)
    check('second card has 1 item',
          len(F.by_class(F.by_class(built, 'card')[1], 'bullet-item')) == 1)

    # List font size must match card description font size, otherwise
    # in dense grid list would be larger than surrounding text.
    reference = deck.fragments.load('cards-2')
    expected = _font_size(F.first(reference, 'card-description'))
    line = F.first(built, 'bullet-text')
    check('list font taken from card description',
          expected and expected in (line.get('style') or ''),
          'expected %s, got %s' % (expected, line.get('style')))

    # Marker is image from assets; path must lead to existing file.
    marker = F.first(built, 'bullet')
    images = marker.xpath('.//img/@src') if marker is not None else []
    for src in images:
        check('bullet marker path leads to file',
              os.path.isfile(os.path.join(SKILL, src.lstrip('/'))), src)

    try:
        E.CARD.normalise([{'title': 'Раз', 'items': ['a'] * 6}], deck.allocator)
        check('more than five items in card rejected', False)
    except ValueError:
        check('more than five items in card rejected', True)


def _font_size(element):
    for declaration in (element.get('style') or '').split(';'):
        name, _, value = declaration.partition(':')
        if name.strip() == 'font-size':
            return 'font-size:%s' % value.strip()
    return None


def test_fragments_present(deck):
    """All layouts known to builder exist on disk and are readable."""
    for layout, entry in L.physical(SKILL).items():
        path = os.path.join(deck.fragments.slides_dir, entry.file)
        check('layout %s fragment exists' % layout, os.path.isfile(path), path)


def test_assets_exist():
    """Every image and font referenced in template and CSS exists."""
    layouts_dir = os.path.join(SKILL, 'assets', 'layouts')
    missing = []
    for name in sorted(os.listdir(layouts_dir)):
        if not name.endswith('.html'):
            continue
        path = os.path.join(layouts_dir, name)
        with open(path, 'r', encoding='utf-8') as f:
            text = f.read()
        for url in re.findall(r'(?:src|href)="([^"]+)"', text):
            if url.startswith(('http', 'data:', '#')):
                continue
            full = os.path.normpath(os.path.join(layouts_dir, url))
            if not asset_exists(full):
                missing.append('%s → %s' % (name, url))
    check('template assets exist', not missing, '; '.join(missing[:5]))

    css = os.path.join(SKILL, 'assets', 'base.css')
    with open(css, 'r', encoding='utf-8') as f:
        text = f.read()
    css_missing = []
    for url in re.findall(r"url\(['\"]?([^'\")]+)['\"]?\)", text):
        full = os.path.normpath(os.path.join(os.path.dirname(css), url))
        if not os.path.isfile(full):
            css_missing.append(url)
    check('base.css assets exist', not css_missing, '; '.join(css_missing))


def test_no_slide_numbers():
    """Template has no slide numbers — they were removed."""
    hits = []
    for root, _dirs, files in os.walk(os.path.join(SKILL, 'assets')):
        for name in files:
            if not name.endswith(('.html', '.css')):
                continue
            with open(os.path.join(root, name), 'r', encoding='utf-8') as f:
                if 'slide__number' in f.read():
                    hits.append(name)
    check('template has no slide numbers', not hits, '; '.join(hits))


# ------------------------------------------------------------ chart data

def test_chartdata_parsing():
    """CSV to categories/series: the good cases, and every bad one raises."""
    good = 'quarter,revenue\nQ1,10\nQ2,20\nQ3,30\n'
    data = CD.parse_csv(good, 'quarter', 'revenue')
    check('chartdata: plain csv categories', data.categories == ['Q1', 'Q2', 'Q3'])
    check('chartdata: plain csv values', data.series[0].values == [10.0, 20.0, 30.0])

    multi = 'quarter,revenue,cost\nQ1,10,4\nQ2,20,9\n'
    data = CD.parse_csv(multi, 'quarter', ['revenue', 'cost'])
    check('chartdata: multi-series count', len(data.series) == 2)
    check('chartdata: multi-series names',
          [s.name for s in data.series] == ['revenue', 'cost'])

    # Russian-locale Excel export: ';' field separator, ',' decimal point.
    ru = 'квартал;доход\nQ1;10,5\nQ2;20,25\n'
    data = CD.parse_csv(ru, 'квартал', 'доход')
    check('chartdata: ru-locale semicolons + decimal comma',
          data.series[0].values == [10.5, 20.25])

    thousands = 'quarter,revenue\nQ1,"1,234.5"\nQ2,"2,000.0"\n'
    data = CD.parse_csv(thousands, 'quarter', 'revenue')
    check('chartdata: thousands-comma + decimal dot',
          data.series[0].values == [1234.5, 2000.0])

    bad = [
        ('empty file', '', 'quarter', 'revenue'),
        ('header only', 'quarter,revenue\n', 'quarter', 'revenue'),
        ('missing column', 'quarter,revenue\nQ1,10\n', 'quarter', 'profit'),
        ('non-numeric value', 'quarter,revenue\nQ1,abc\n', 'quarter', 'revenue'),
        ('ragged row', 'quarter,revenue\nQ1,10,extra\n', 'quarter', 'revenue'),
        ('no value column', 'quarter,revenue\nQ1,10\n', 'quarter', []),
    ]
    for name, text, x, y in bad:
        try:
            CD.parse_csv(text, x, y)
            check('chartdata rejects: %s' % name, False, 'no error')
        except ChartDataError:
            check('chartdata rejects: %s' % name, True)


def test_chartdata_finite_values(out_dir):
    """Reject non-finite inputs before geometry, with literal locations."""
    def rejected(label, call, expected, error_type=ChartDataError):
        try:
            call()
        except error_type as error:
            check('chartdata finite: ' + label, str(error) == expected, str(error))
        except Exception as error:
            check('chartdata finite: ' + label, False,
                  '%s: %s' % (type(error).__name__, error))
        else:
            check('chartdata finite: ' + label, False, 'accepted invalid data')

    def inline(value):
        return {'categories': ['Q1', 'Q2'], 'series': [
            {'name': 'Revenue', 'values': [3, 4]},
            {'name': 'Cost', 'values': [2, value]}]}

    tokens = ('NaN', '+nAn', '-NaN', 'inf', '+INF', '-inf', 'Infinity',
              '+Infinity', '-Infinity', '1e400', '-1e400', ' 1e400 ', '1,0e400')
    for raw in tokens:
        for delimiter in (',', ';', '\t'):
            text = delimiter.join(('period', 'Revenue', 'Cost')) + '\n'
            text += delimiter.join(('Q1', '3', '2')) + '\n'
            text += delimiter.join(('Q2', '4', '"%s"' % raw)) + '\n'
            rejected('CSV %r %r' % (delimiter, raw),
                     lambda: CD.parse_csv(text, 'period', ['Revenue', 'Cost'],
                                          source='finite.csv'),
                     "finite.csv: row 3, column 'Cost' is not finite: %r" % raw)
        rejected('inline string %r' % raw,
                 lambda: CD.from_inline(inline(raw), source='input.data'),
                 "input.data.series[2]: row 2, column 'Cost' is not finite: %r" % raw)

    for raw in (float('nan'), float('inf'), -float('inf'), 10 ** 400, -(10 ** 400)):
        rejected('inline numeric %r' % raw,
                 lambda: CD.from_inline(inline(raw), source='input.data'),
                 "input.data.series[2]: row 2, column 'Cost' is not finite: %r" % raw)
    decoded = json.loads('{"categories": ["Q1", "Q2"], "series": '
                         '[{"name": "Cost", "values": [2, 1e400]}]}')
    rejected('JSON exponent overflow', lambda: CD.from_inline(decoded),
             "data.series[1]: row 2, column 'Cost' is not finite: inf")

    # These are data-parser controls; extreme-value rendering is separate.
    controls = [('0', 0.0), ('-0', -0.0), ('12,5', 12.5),
                ('1.234,5', 1234.5), ('1,234.5', 1234.5),
                ('1\xa0234,5', 1234.5), ('-4.25', -4.25),
                ('1e300', 1e300), ('1e-300', 1e-300),
                ('1.7976931348623157e308', 1.7976931348623157e308)]
    for raw, expected in controls:
        csv = CD.parse_csv('period,value\nQ1,"%s"\n' % raw, 'period', 'value')
        data = CD.from_inline({'categories': ['Q1'], 'series': [
            {'name': 'Value', 'values': [raw]}]})
        numeric = CD.from_inline({'categories': ['Q1'], 'series': [
            {'name': 'Value', 'values': [expected]}]})
        check('chartdata finite: control %r' % raw,
              csv.series[0].values == data.series[0].values
              == numeric.series[0].values == [expected])
    data = CD.from_inline(inline(42))
    check('chartdata finite: categories and series order',
          data.categories == ['Q1', 'Q2'] and
          [(s.name, s.values) for s in data.series]
          == [('Revenue', [3.0, 4.0]), ('Cost', [2.0, 42.0])])

    for raw, suffix in [('', "row 2, column 'Cost' is empty"),
                        ('oops', "row 2, column 'Cost' is not a number: 'oops'"),
                        (True, 'value 2 is a boolean'),
                        (None, 'value 2 is not a number: None')]:
        rejected('existing inline %r' % raw, lambda: CD.from_inline(inline(raw)),
                 'data.series[2]: ' + suffix)
    for raw, suffix in [('', 'is empty'), ('oops', "is not a number: 'oops'")]:
        rejected('existing CSV %r' % raw,
                 lambda: CD.parse_csv('period,Cost\nQ1,%s\n' % raw, 'period', 'Cost'),
                 "<csv>: row 2, column 'Cost' " + suffix)

    for raw in ('NaN', '1e400', float('inf'), 10 ** 400):
        chart = {'title': 'Bad chart', 'chart_type': 'bar', 'data': inline(raw)}
        expected = "data.series[2]: row 2, column 'Cost' is not finite: %r" % raw
        rejected('Deck.add %r' % raw,
                 lambda: Deck(skill_dir=SKILL).add('chart-wide', chart), expected)
        rejected('spec %r' % raw,
                 lambda: SP.deck_from_spec({'slides': [dict(chart, layout='chart-wide')]},
                                          skill_dir=SKILL),
                 'slide 1 (chart-wide): ' + expected, SpecError)
    path = os.path.join(out_dir, 'nonfinite.csv')
    with io.open(path, 'w', encoding='utf-8') as stream:
        stream.write('period,Revenue,Cost\nQ1,3,2\nQ2,4,1e400\n')
    chart = dict(title='Bad CSV chart', chart_type='bar', data=path,
                 x='period', y=['Revenue', 'Cost'])
    expected = "%s: row 3, column 'Cost' is not finite: '1e400'" % path
    rejected('CSV Deck.add', lambda: Deck(skill_dir=SKILL).add('chart-wide', chart),
             expected)
    rejected('CSV spec',
             lambda: SP.deck_from_spec({'slides': [dict(chart, layout='chart-wide')]},
                                      skill_dir=SKILL),
             'slide 1 (chart-wide): ' + expected, SpecError)


def test_chartdata_delimiter_counts():
    """Quote-aware counts and candidate selection have independent expectations."""
    for label, text, expected in [
        ('quoted punctuation', '"x; note; detail",y\nA,12.5\n', {',': 1, ';': 0, '\t': 0}),
        ('doubled quotes', '"x ""; detail;""",y\nA,12.5\n', {',': 1, ';': 0, '\t': 0}),
        ('tab punctuation', 'x\t"y; income; total"\tcost\nA\t10\t20\n', {',': 0, ';': 0, '\t': 2}),
        ('multiline', '"x, note\ndetail";y\nA;12,5\n', {',': 0, ';': 1, '\t': 0}),
        ('blank records', '\n"";""\nx;y\nA;12,5\n', {',': 0, ';': 1, '\t': 0}),
        ('literal quote', 'x"note;y\nA;12,5\n', {',': 0, ';': 1, '\t': 0}),
        ('header only', 'x;y\nA, one, two, three;12,5\n', {',': 0, ';': 1, '\t': 0}),
        ('tie', 'x;note,y\nA,12.5\n', {',': 1, ';': 1, '\t': 0}),
    ]:
        check('CSV header: %s unquoted separator counts' % label,
              CD._header_delimiters(text) == expected)
    check('CSV header: ambiguous counts retain comma priority',
          CD._sniff_delimiter('a;b,c\n') == ',')

    from unittest.mock import patch
    real_reader = CD.csv.reader

    def failed_candidate(stream, delimiter):
        if delimiter == ';':
            raise CD.csv.Error('injected candidate failure')
        return real_reader(stream, delimiter=delimiter)

    with patch.object(CD.csv, 'reader', side_effect=failed_candidate):
        try:
            selected = CD._sniff_delimiter('x,y\nA,12\n', ['x', 'y'])
        except CD.csv.Error:
            selected = None
    check('CSV header: unreadable alternative does not block a valid separator', selected == ',')


def test_chartdata_delimiters():
    """CSV quoting belongs to the reader, including escapes and logical rows."""
    cases = [
        ('quoted semicolons', '"x; note; detail",y\nA,12.5\nB,20\n',
         'x; note; detail', 'y', ',', ['A', 'B']),
        ('quoted comma', '"x, note";y\nA;12,5\nB;20\n',
         'x, note', 'y', ';', ['A', 'B']),
        ('tab with quoted punctuation', '"x, note; detail\tunit"\ty\nA\t12,5\nB\t20\n',
         'x, note; detail\tunit', 'y', '\t', ['A', 'B']),
        ('escaped quotes comma', '"x ""; detail;""",y\n"A; one",12.5\n"B, two",20\n',
         'x "; detail;"', 'y', ',', ['A; one', 'B, two']),
        ('escaped quotes semicolon', '"x "", detail,""";y\n"A; one";12,5\n"B, two";20\n',
         'x ", detail,"', 'y', ';', ['A; one', 'B, two']),
        ('escaped quotes tab', '"x "",;\t"""\ty\n"A\tone"\t12,5\n"B, two"\t20\n',
         'x ",;\t"', 'y', '\t', ['A\tone', 'B, two']),
        ('multiline comma', '"x; note;\ndetail",y\nA,12.5\nB,20\n',
         'x; note;\ndetail', 'y', ',', ['A', 'B']),
        ('multiline semicolon', '"x, note\ndetail";y\nA;12,5\nB;20\n',
         'x, note\ndetail', 'y', ';', ['A', 'B']),
        ('multiline tab', '"x, note\ndetail"\ty\nA\t12,5\nB\t20\n',
         'x, note\ndetail', 'y', '\t', ['A', 'B']),
        ('blank rows comma', '\n \n"x; note; detail",y\nA,12.5\nB,20\n',
         'x; note; detail', 'y', ',', ['A', 'B']),
        ('blank rows semicolon', '\r\n \r\nx;y\r\nA;12,5\r\nB;20\r\n',
         'x', 'y', ';', ['A', 'B']),
        ('blank rows tab', '\n \nx\ty\nA\t12,5\nB\t20\n',
         'x', 'y', '\t', ['A', 'B']),
        ('literal quote comma', 'x"note,y\nA,12.5\nB,20\n',
         'x"note', 'y', ',', ['A', 'B']),
        ('literal quote semicolon', 'x"note;y\nA;12,5\nB;20\n',
         'x"note', 'y', ';', ['A', 'B']),
        ('literal quote tab', 'x"note\ty\nA\t12,5\nB\t20\n',
         'x"note', 'y', '\t', ['A', 'B']),
        ('tie prefers comma', 'x;note,y\nA,12.5\nB,20\n',
         'x;note', 'y', ',', ['A', 'B']),
        ('header only sniff', 'x;y\nA, one, two, three;12,5\nB;20\n',
         'x', 'y', ';', ['A, one, two, three', 'B']),
        ('one semicolon control', '"x; note",y\nA,12.5\nB,20\n',
         'x; note', 'y', ',', ['A', 'B']),
        ('blank delimited rows', ';;\n"";" "\nx;y\nA;12,5\nB;20\n',
         'x', 'y', ';', ['A', 'B']),
        ('blank quoted comma', '"","",""\n"x; note; detail",y\nA,12.5\nB,20\n',
         'x; note; detail', 'y', ',', ['A', 'B']),
        ('blank quoted semicolon', '"";"";""\n"x, note";y\nA;12,5\nB;20\n',
         'x, note', 'y', ';', ['A', 'B']),
        ('blank quoted tab', '""\t""\t""\n"x, note"\ty\nA\t12,5\nB\t20\n',
         'x, note', 'y', '\t', ['A', 'B']),
        ('quoted unused header mimics columns', 'x,y,"note;x;y;more;stuff"\nA,12.5,30\nB,20,40\n',
         'x', 'y', ',', ['A', 'B']),
    ]
    for label, text, x, y, delimiter, categories in cases:
        try:
            data = CD.parse_csv(text, x, y)
        except ChartDataError as error:
            check('CSV delimiter: %s preserves fields and values' % label, False, str(error))
        else:
            check('CSV delimiter: %s preserves fields and values' % label,
                  data.categories == categories and len(data.series) == 1
                  and data.series[0].name == 'y'
                  and data.series[0].values == [12.5, 20.0])

    # Literal expectations cover decimal/thousands conventions on all separators.
    for label, text in [
        ('comma', 'x,"y; income; total",cost\nA,"1.234,5","2,000.5"\n'),
        ('semicolon', 'x;"y; income; total";cost\nA;"1.234,5";"2,000.5"\n'),
        ('tab', 'x\t"y; income; total"\tcost\nA\t"1.234,5"\t"2,000.5"\n'),
    ]:
        try:
            data = CD.parse_csv(text, 'x', ['y; income; total', 'cost'])
        except ChartDataError as error:
            check('CSV delimiter: %s multi-series decimals' % label, False, str(error))
        else:
            check('CSV delimiter: %s multi-series decimals' % label,
                  data.categories == ['A']
                  and [s.name for s in data.series] == ['y; income; total', 'cost']
                  and [s.values for s in data.series] == [[1234.5], [2000.5]])

    for label, text, x, y, expected in [
        ('missing column', '"x; note; detail",y\nA,12\n', 'x; note; detail', 'z',
         "probe: column 'z' not found — header is ['x; note; detail', 'y']"),
        ('ragged row', '"x, note";y\nA;12;extra\n', 'x, note', 'y',
         'probe: row 2 has 3 columns, header has 2'),
        ('invalid number', 'x\ty\nA\tbad\n', 'x', 'y',
         "probe: row 2, column 'y' is not a number: 'bad'"),
    ]:
        try:
            CD.parse_csv(text, x, y, source='probe')
        except ChartDataError as error:
            check('CSV delimiter: %s exact diagnostic' % label, str(error) == expected, str(error))
        else:
            check('CSV delimiter: %s exact diagnostic' % label, False, 'no error')

    for label, text, x, y, names, values in [
        ('literal quote after semicolon', 'x;"note,y,z\nA,12.5,20\n',
         'x;"note', ['y', 'z'], ['y', 'z'], [[12.5], [20.0]]),
        ('paired literal quotes after semicolons', 'x;;"note,y,z",value\nA,10,20,12.5\n',
         'x;;"note', 'value', ['value'], [[12.5]]),
    ]:
        try:
            data = CD.parse_csv(text, x, y)
        except ChartDataError as error:
            check('CSV delimiter: %s preserves legacy data' % label, False, str(error))
        else:
            check('CSV delimiter: %s preserves legacy data' % label,
                  data.categories == ['A'] and [s.name for s in data.series] == names
                  and [s.values for s in data.series] == values)


# --------------------------------------------------------------- formulas

def test_formula_parsing():
    """The inline delimiter and bounded converter reject ambiguity."""
    check('formula: one inline span',
          FM.parse_inline('До \\(x^2\\) после') == [
              ('text', 'До '), ('math', 'x^2'), ('text', ' после')])
    check('formula: currency stays prose',
          FM.parse_inline('с $5 млн до $12 млн') == [
              ('text', 'с $5 млн до $12 млн')])
    check('formula: escaped opener stays prose',
          FM.parse_inline('пишем \\\\( буквально') == [
              ('text', 'пишем \\( буквально')])
    # Both halves unescape, or the same text is read two ways: the closer used
    # to come back still carrying its backslash.
    check('formula: escaped closer stays prose',
          FM.parse_inline('пишем \\\\) буквально') == [
              ('text', 'пишем \\) буквально')])
    check('formula: unmatched opener stays prose',
          FM.parse_inline('пишем \\(x') == [('text', 'пишем \\(x')])
    try:
        FM.parse_inline('пусто \\( \\)')
        check('formula: empty span rejected', False, 'no error')
    except FormulaError:
        check('formula: empty span rejected', True)

    cases = {
        'scripts': r'x_i^2+y^2=z^2',
        'nary with operand': r'\sum_{i=1}^{n}x_i',
        'nary without limits': r'\sum x_i',
        'product and integral': r'\prod_{i=1}^{n}x_i+\int_0^1 x^2',
        'nary stops before addition': r'\sum_{i=1}^{n}x_i+y',
        'fraction and nary': (r'\mathrm{Cov}(X,Y)=\frac{1}{n}'
                              r'\sum_{i=1}^{n}(x_i-\bar{x})'),
        'plain root': r'\sqrt{x}',
        'indexed root': r'\sqrt[3]{x}',
        'operators': r'\log_2 x+\ln x+\exp(x)',
        'delimiters': r'\left|x-y\right|',
        'blackboard regular': r'\mathbb{E}[X]\neq 0',
        'blackboard specials': r'\mathbb{R}\to\mathbb{N}',
    }
    built = {}
    sources = {}
    for name, latex in cases.items():
        try:
            omath, source = FM.validate(latex)
            xml = etree.tostring(omath, encoding='unicode')
            built[name] = xml
            sources[name] = source
            check('formula subset: %s' % name, '<m:oMath' in xml, xml[:120])
        except FormulaError as exc:
            check('formula subset: %s' % name, False, str(exc))
    nary = built.get('nary with operand', '')
    check('formula: nary owns its mandatory operand',
          '<m:nary>' in nary and '<m:e><m:sSub>' in nary
          and nary.rfind('<m:sSub>') < nary.rfind('</m:nary>')
          and '<m:t>=</m:t>' in nary, nary[:400])
    bounded = built.get('nary stops before addition', '')
    check('formula: unbraced nary body stops before addition',
          '</m:nary><m:r>' in bounded and '<m:t>+</m:t>' in bounded,
          bounded[:400])
    hidden_limits = built.get('nary without limits', '')
    check('formula: omitted nary limits are hidden but structurally populated',
          '<m:subHide m:val="on"' in hidden_limits
          and '<m:supHide m:val="on"' in hidden_limits
          and '<m:sub><m:r>' in hidden_limits
          and '<m:sup><m:r>' in hidden_limits,
          hidden_limits[:500])
    operators = built.get('operators', '')
    check('formula: named operators use native function application',
          operators.count('<m:func>') == 3
          and '<m:fName><m:sSub>' in operators,
          operators[:500])
    plain_root = built.get('plain root', '')
    check('formula: plain root hides a populated invisible degree',
          '<m:degHide m:val="on"' in plain_root
          and '<m:deg><m:r>' in plain_root and '​' in plain_root,
          plain_root[:300])
    indexed_root = built.get('indexed root', '')
    check('formula: indexed root carries its degree',
          '<m:degHide' not in indexed_root and '<m:deg><m:r>' in indexed_root,
          indexed_root[:300])
    blackboard = built.get('blackboard specials', '')
    check('formula: special blackboard letters use assigned glyphs',
          'ℝ' in blackboard and 'ℕ' in blackboard, blackboard[:300])

    # An alphabet command reaches the runs *inside* a construct, the way TeX
    # applies it. `_apply_style` used to return any non-`run` node untouched,
    # so `\mathbf{x^2}` and `\boldsymbol{\hat\beta}` came out plain with no
    # error at all — the one failure shape this module exists to prevent.
    styled = {
        r'\mathbf{x^2}': ('{\\mathbf{x}}^{\\mathbf{2}}', '\U0001D431\U0001D7D0'),
        r'\mathbf{\frac{a}{b}}': ('\\frac{\\mathbf{a}}{\\mathbf{b}}',
                                  '\U0001D41A\U0001D41B'),
        # Greek reaches the glyph, not only the canonical source. Bold italic
        # beta, not the italic one `SYMBOLS` starts from: a style that stopped
        # at the source drew bold in the PNG preview and plain in PowerPoint.
        r'\boldsymbol{\hat\beta}': ('\\hat{\\boldsymbol{\\beta}}',
                                    '\U0001D737'),
        r'\mathbf{\Sigma}': ('\\mathbf{\\Sigma}', '\U0001D6BA'),
        r'\mathrm{\alpha}': ('\\mathrm{\\alpha}', 'α'),
        r'\mathbf{\sqrt{x}}': ('\\sqrt{\\mathbf{x}}', '\U0001D431'),
    }
    for latex, (source, glyphs) in styled.items():
        try:
            omath, produced = FM.validate(latex)
        except FormulaError as exc:
            check('formula: %s keeps its style' % latex, False, str(exc)[:180])
            continue
        text = ''.join(omath.itertext())
        check('formula: %s keeps its style' % latex,
              produced == source and all(ch in text for ch in glyphs),
              'source %r, omml text %r' % (produced, text))

    # Unicode assigned no blackboard or script Greek, so the build says so
    # rather than handing back an unstyled letter.
    for latex, style in ((r'\mathbb{\alpha}', 'mathbb'),
                         (r'\mathcal{\beta}', 'mathcal')):
        try:
            FM.validate(latex)
            check('formula: %s refused' % latex, False, 'no error')
        except FormulaError as exc:
            check('formula: %s refused' % latex,
                  '\\%s has no Greek letters' % style in str(exc),
                  str(exc)[:180])

    # Refused, not dropped: neither consumer takes a styled operator name.
    for latex, what in ((r'\mathbf{\log x}', 'a named operator'),
                        (r'\mathbf{\sum_i x_i}',
                         'a sum, product or integral')):
        try:
            FM.validate(latex)
            check('formula: %s refused' % latex, False, 'no error')
        except FormulaError as exc:
            check('formula: %s refused' % latex,
                  what in str(exc) and 'style its operand' in str(exc),
                  str(exc)[:180])

    invalid = (
        (r'\sum_{i=1}^{n}', 'requires an operand'),
        # `\not` before a bare letter built `\notx` and the failure surfaced
        # from mathtext as an unknown command, skipping the message written
        # here for exactly this mistake.
        (r'\not x', 'applies to one relation'),
        (r'\frac{}{2}', 'non-empty argument'),
        (r'\frac{1}{}', 'non-empty argument'),
        (r'x^{}', 'script value is empty'),
        (r'\bar{}', 'non-empty argument'),
        (r'\hat{}', 'non-empty argument'),
        (r'\left(\right)', 'non-empty body'),
        # An unpaired closer used to be reported as `unexpected '\'`, which
        # named the backslash rather than the half that is missing.
        (r'x \right)', 'no matching opener'),
        (r'x\bigr]', 'no matching opener'),
        (r'\sqrt[]{x}', 'non-empty index'),
        (r'\mathrm{}', 'non-empty argument'),
        (r'\text{}', 'non-empty argument'),
        ('{' * 1200 + 'x' + '}' * 1200, 'nested too deeply'),
    )
    for latex, reason in invalid:
        try:
            FM.validate(latex)
            check('formula: %s rejected cleanly' % reason, False, 'no error')
        except FormulaError as exc:
            check('formula: %s rejected cleanly' % reason,
                  reason in str(exc), str(exc)[:180])

    try:
        FM.latex_to_omml(r'\begin{matrix}x\end{matrix}')
        check('formula: unsupported environment rejected', False, 'no error')
    except FormulaError as exc:
        check('formula: unsupported environment rejected',
              '\\begin is not supported' in str(exc)
              and 'not inline math' in str(exc), str(exc))
    try:
        FM.latex_to_omml(r'\zzz')
        check('formula: unknown command rejected', False, 'no error')
    except FormulaError as exc:
        check('formula: unknown command rejected',
              'unsupported command \\zzz' in str(exc), str(exc))


# One minimal formula per command that needs more than the bare name to
# parse. Anything absent from here is exercised as `\name` on its own.
_FORMULA_USAGE = {
    'frac': r'\frac{1}{2}', 'sqrt': r'\sqrt{x}', 'bar': r'\bar{x}',
    'overline': r'\overline{x}', 'text': r'\text{ok}',
    'left': r'\left(x\right)', 'right': r'\left[x\right]',
    'arg': r'\arg\min_{x} f', 'not': r'\not\in',
    'sum': r'\sum_{i} x_i', 'prod': r'\prod_{i} x_i', 'int': r'\int_0^1 x',
    'oint': r'\oint_C x', 'bigcup': r'\bigcup_{i} A_i',
    'bigcap': r'\bigcap_{i} A_i', 'bigoplus': r'\bigoplus_{i} A_i',
    'bigl': r'\bigl(x\bigr)', 'Bigl': r'\Bigl(x\Bigr)',
    'biggl': r'\biggl(x\biggr)', 'Biggl': r'\Biggl(x\Biggr)',
    'bigr': r'\bigl[x\bigr]', 'Bigr': r'\Bigl[x\Bigr]',
    'biggr': r'\biggl[x\biggr]', 'Biggr': r'\Biggl[x\Biggr]',
    'big': r'\big|', 'Big': r'\Big|', 'bigg': r'\bigg|', 'Bigg': r'\Bigg|',
    'dfrac': r'\dfrac{1}{2}', 'tfrac': r'\tfrac{1}{2}',
    # Spacing commands set nothing on their own, so they need neighbours.
    ',': r'a \, b', ';': r'a \; b', ':': r'a \: b', '!': r'a \! b',
    ' ': 'a \\ b', 'quad': r'a \quad b', 'qquad': r'a \qquad b',
}
# Commands whose argument is a single atom, spelt both ways: the unbraced form
# is what the corpus writes and what v1.8 rejected.
_FORMULA_UNBRACED = ('hat', 'tilde', 'bar', 'vec', 'sqrt')


def _formula_usage(name):
    if name in _FORMULA_USAGE:
        return _FORMULA_USAGE[name]
    # An alias is exercised through whatever it resolves to, spelt with the
    # alias: `\widehat` needs the argument `\hat` needs.
    target = FM._ALIASES.get(name, name)
    if target != name and target in _FORMULA_USAGE:
        return _FORMULA_USAGE[target].replace('\\' + target, '\\' + name, 1)
    if target in FM._ACCENTS:
        return '\\%s{x}' % name
    if target in FM._STYLES:
        return '\\%s{X}' % name
    if target in FM._FUNCTIONS:
        return '\\%s{x}' % name
    if target in FM._NARY:
        return '\\%s_{i} x_i' % name
    return '\\%s' % name


_M_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/math'
# OMML elements that must carry content. `m:deg` is absent from the list on
# purpose: a plain square root legitimately emits an empty degree.
_REQUIRED_ARGUMENTS = ('e', 'num', 'den', 'sub', 'sup', 'fName', 'lim')


def _braced_argument_commands():
    """Every supported command that takes a braced argument.

    Derived from the parser's own tables, not listed here, so a command added
    to `_ACCENTS` or `_FUNCTIONS` is swept without editing this file.
    """
    names = set(FM._ACCENTS) | set(FM._STYLES) | set(FM._FUNCTIONS)
    names |= {'frac', 'dfrac', 'tfrac', 'sqrt', 'overline', 'text'}
    for alias, target in FM._ALIASES.items():
        if target in names:
            names.add(alias)
    return names & (FM.SUPPORTED_COMMANDS | set(FM._FUNCTIONS)
                    | set(FM._STYLES))


def _childless_arguments(omath):
    """Required OMML arguments left empty, as tag names.

    A childless required argument is not an empty-looking formula: PowerPoint
    draws a dotted insertion placeholder where the content should be. That is
    what the first v1.8 production gate found, and what `_INVISIBLE_ARGUMENT`
    exists to prevent — so the sweep asserts it rather than trusting it.
    """
    bad = []
    for tag in _REQUIRED_ARGUMENTS:
        for node in omath.iter('{%s}%s' % (_M_NS, tag)):
            if len(node) == 0 and not (node.text or '').strip():
                bad.append('m:' + tag)
    return bad


def test_formula_command_coverage():
    """Every supported command works in BOTH consumers, and is documented.

    The reason this check exists rather than a paragraph promising it. The
    supported language is the *intersection* of our OMML parser and matplotlib
    mathtext, and before v1.8.1 nothing measured that intersection: the two
    read the same raw string through different parsers, so a command could be
    accepted here and rejected — or worse, silently substituted with a dummy
    glyph — there. A corpus audit found 174 of 271 real formulas rejected, and
    the fix was to widen these tables by about sixty entries. That is only
    safe if adding a row is checked, so every row is.
    """
    checked = 0
    for name in sorted(FM.SUPPORTED_COMMANDS):
        latex = _formula_usage(name)
        try:
            omath, source = FM.validate(latex)
        except Exception as exc:                        # noqa: BLE001
            check('formula command \\%s works in both consumers' % name,
                  False, '%s: %s' % (latex, str(exc)[:120]))
            continue
        checked += 1
        xml = etree.tostring(omath, encoding='unicode')
        check('formula command \\%s reaches OMML' % name,
              '<m:oMath' in xml and '<m:t>' in xml, xml[:120])
        check('formula command \\%s fills every required argument' % name,
              not _childless_arguments(omath),
              ', '.join(_childless_arguments(omath)) or xml[:120])
        check('formula command \\%s has a canonical spelling' % name,
              bool(source.strip()) or name in ('!', ',', ';', ':', ' '),
              repr(source))
    check('formula coverage: the whole table was exercised',
          checked == len(FM.SUPPORTED_COMMANDS),
          '%d of %d' % (checked, len(FM.SUPPORTED_COMMANDS)))

    # The unbraced argument form, which is what the corpus actually writes.
    for name in _FORMULA_UNBRACED:
        braced = '\\%s{x}' % name
        bare = '\\%s x' % name
        try:
            check('formula \\%s accepts an unbraced argument' % name,
                  FM.validate(bare)[1] == FM.validate(braced)[1],
                  '%r vs %r' % (FM.validate(bare)[1],
                                FM.validate(braced)[1]))
        except FormulaError as exc:
            check('formula \\%s accepts an unbraced argument' % name,
                  False, str(exc)[:140])

    # The empty-braced spelling of every command that takes an argument. A
    # reviewer found `\log{}` parsing clean and emitting a childless `m:e`:
    # `_function_argument` was the one argument path that checked for a missing
    # argument but not for an empty one, and the sweep above could not see it
    # because it only ever writes correct spellings. Refusing `\cmd{}` is
    # cheaper to check than detecting the placeholder it would otherwise ship.
    empty_checked = 0
    for name in sorted(_braced_argument_commands()):
        empty_checked += 1
        try:
            FM.latex_to_omml('\\%s{}' % name)
            check('formula \\%s{} is refused' % name, False,
                  'an empty argument parsed clean')
        except FormulaError as exc:
            check('formula \\%s{} is refused' % name,
                  'requires' in str(exc) or 'empty' in str(exc),
                  str(exc)[:140])
    check('formula: the empty-argument sweep covered the tables',
          empty_checked > 40, '%d commands' % empty_checked)

    # Every refusal names the construct and what to do instead, so the calling
    # agent can act on it without reading this source.
    for name, advice in sorted(FM._REFUSALS.items()):
        try:
            FM.latex_to_omml('\\%s{x}' % name)
            check('formula \\%s is refused' % name, False, 'accepted')
        except FormulaError as exc:
            check('formula \\%s is refused with advice' % name,
                  advice in str(exc), str(exc)[:140])

    # The pinned math face, and the promotion of a substituted glyph to an
    # error. Both are about output that does not depend on the environment:
    # nothing used to set `mathtext.fontset`, so deck geometry followed
    # whatever the ambient matplotlib configuration held.
    check('formula: the math face is pinned, not inherited',
          FM._MATHTEXT_RC.get('mathtext.fontset') == 'stix',
          repr(FM._MATHTEXT_RC))

    # A glyph mathtext *substitutes* rather than draws is a warning, not an
    # exception — it returns metrics for a dummy box. stix covers everything
    # this parser can emit, so the promotion is exercised against the face
    # that does not (the old inherited default), which is the combination
    # that produced a silently placeholder-shaped formula.
    saved = dict(FM._MATHTEXT_RC)
    probe = '\\mathbf{\U0001D6FD}'
    # The metrics cache is keyed by (source, size, weight) and deliberately
    # not by the face — the face is pinned, so it cannot vary in a build. This
    # probe is the one caller that varies it, so it has to evict first.
    for key in [k for k in FM._MATH_CACHE if k[0] == probe]:
        del FM._MATH_CACHE[key]
    try:
        FM._MATHTEXT_RC['mathtext.fontset'] = 'dejavusans'
        try:
            FM.math_metrics(probe, 34.0)
            substituted = False
        except FormulaError:
            substituted = True
    finally:
        FM._MATHTEXT_RC.clear()
        FM._MATHTEXT_RC.update(saved)
        for key in [k for k in FM._MATH_CACHE if k[0] == probe]:
            del FM._MATH_CACHE[key]
    check('formula: a substituted glyph is an error, not a placeholder',
          substituted, 'mathtext returned metrics for a dummy symbol')

    # Delimiters are part of the contract but are not commands, so the sweep
    # above cannot reach them. Each has to open and close a real pair.
    for spelling in sorted(FM._DELIMITERS):
        if spelling == '.':
            continue                    # the null delimiter, only ever a side
        try:
            FM.validate('\\left%s x \\right.' % spelling)
            ok, why = True, ''
        except FormulaError as exc:
            ok, why = False, str(exc)[:120]
        check('formula delimiter %s works in both consumers' % spelling,
              ok, why)

    # `_DELIMITERS` reads a spelling to a glyph and `_DELIMITER_TEX` writes the
    # glyph back for mathtext; they are two tables because the first is
    # many-to-one. They agree when the spelling mathtext receives parses back
    # to the same glyph - compared on the delimiter characters of the Office
    # Math both spellings produce, which carry glyphs, not spellings.
    for spelling in sorted(FM._DELIMITERS):
        source = '\\left%s{x}\\right.' % spelling
        try:
            again = FM.to_mathtext(FM.parse(source))
            ok = (_delimiter_glyphs(FM.latex_to_omml(again))
                  == _delimiter_glyphs(FM.latex_to_omml(source)))
            why = again
        except FormulaError as exc:
            ok, why = False, str(exc)[:120]
        check('formula delimiter %s survives the mathtext spelling' % spelling,
              ok, why)


def _delimiter_glyphs(omath):
    """The (opening, closing) characters of every m:d in an m:oMath."""
    ns = {'m': FM.M_NS}
    return [(d.xpath('string(m:dPr/m:begChr/@m:val)', namespaces=ns),
             d.xpath('string(m:dPr/m:endChr/@m:val)', namespaces=ns))
            for d in omath.xpath('.//m:d', namespaces=ns)]


def test_formula_docs_match_code():
    """The documented formula language is the implemented one, both ways.

    Two directions, because they fail differently. A command named in the
    docs but not supported is a promise the build breaks — the agent writes
    it and the deck fails. A refusal *not* named in the docs is worse: the
    agent has no way to know what to write instead, which is the whole point
    of refusing rather than approximating. Enumerating all ~185 commands in
    an agent-facing file would be unreadable, so the docs describe categories
    and this checks the claims they do make.
    """
    doc = os.path.join(SKILL, 'references', 'layouts.md')
    if not os.path.isfile(doc):
        check('references/layouts.md exists', False, doc)
        return
    with open(doc, 'r', encoding='utf-8') as f:
        text = f.read()
    start = text.find('### Inline formulas')
    end = text.find('### Speaker notes', start)
    section = text[start:end] if start >= 0 < end else ''
    check('layouts.md has a formula section', bool(section), '%d chars'
          % len(section))

    named = set(re.findall(r'`\\\\?([A-Za-z]+)', section))
    promised = named - set(FM._REFUSALS)
    unknown = sorted(promised - FM.SUPPORTED_COMMANDS)
    check('layouts.md promises only supported commands',
          not unknown, 'not implemented: %s' % ', '.join(unknown))

    for name in sorted(FM._REFUSALS):
        check('layouts.md names the refusal \\%s' % name,
              ('\\%s' % name) in section, 'missing from the doc')


def test_formula_delimiter_boundaries():
    """Arrow command names never open or close a delimiter pair."""
    import unicodedata
    ns = {'m': FM.M_NS}
    cases = [
        (r'\left(x\leftarrow y\right)', r'\left( x\leftarrow y \right)',
         'x←y', [('(', ')')]),
        (r'\left(x\rightarrow y\right)', r'\left( x\rightarrow y \right)',
         'x→y', [('(', ')')]),
        (r'\left[x\leftrightarrow y\right]', r'\left[ x\leftrightarrow y \right]',
         'x↔y', [('[', ']')]),
        (r'\left(x\leftarrow y\rightarrow z\right)',
         r'\left( x\leftarrow y\rightarrow z \right)', 'x←y→z', [('(', ')')]),
        (r'\left(x+\left[y\rightarrow z\right]\right)',
         r'\left( x+\left[ y\rightarrow z \right] \right)',
         'x+y→z', [('(', ')'), ('[', ']')]),
        (r'\left(\left[x\right]\leftarrow y\right)',
         r'\left( \left[ x \right]\leftarrow y \right)',
         'x←y', [('(', ')'), ('[', ']')]),
        (r'\left(x+\bigl[y\rightarrow z\bigr]\right)',
         r'\left( x+\left[ y\rightarrow z \right] \right)',
         'x+y→z', [('(', ')'), ('[', ']')]),
        (r'\bigl[\left(x\leftarrow y\right)\bigr]',
         r'\left[ \left( x\leftarrow y \right) \right]',
         'x←y', [('[', ']'), ('(', ')')]),
        (r'\left(x+y\right)', r'\left( x+y \right)', 'x+y', [('(', ')')]),
    ]
    for index, (latex, canonical, operands, delimiters) in enumerate(cases):
        try:
            omath, source = FM.validate(latex)
        except FormulaError as exc:
            check('formula boundaries: case %d accepts' % index, False, str(exc))
            continue
        check('formula boundaries: case %d canonical mathtext' % index,
              source == canonical, source)
        text = ''.join(omath.xpath('.//m:t/text()', namespaces=ns))
        normalized = ''.join(unicodedata.normalize('NFKD', text).split())
        pairs = [(d.xpath('string(m:dPr/m:begChr/@m:val)', namespaces=ns),
                  d.xpath('string(m:dPr/m:endChr/@m:val)', namespaces=ns))
                 for d in omath.xpath('.//m:d', namespaces=ns)]
        check('formula boundaries: case %d native operands and delimiters' % index,
              normalized == operands and pairs == delimiters
              and not _childless_arguments(omath), (normalized, pairs))
        if len(delimiters) == 2:
            check('formula boundaries: case %d native nesting' % index,
                  len(omath.xpath('./m:d/m:e/m:d', namespaces=ns)) == 1)

    # Literal columns pin the diagnostic to the original source, not to the
    # matching routine's internal scan cursor.
    invalid = [
        (r'\left(x\leftarrow y)', r'\left has no matching \right at column 7'),
        (r'\left(x\rightarrow y)', r'\left has no matching \right at column 7'),
        (r'\left(x\leftward y\right)', r'unsupported command \leftward at column 17'),
        (r'\left(x\rightward y\right)', r'unsupported command \rightward at column 18'),
        (r'\left(\right)', 'a delimiter pair requires a non-empty body at column 7'),
        (r'x\right)', r'\right has no matching opener — a delimiter pair needs both halves at column 2'),
    ]
    for index, (latex, reason) in enumerate(invalid):
        try:
            FM.validate(latex)
        except FormulaError as exc:
            expected = '%s in \\(%s\\)' % (reason, latex)
            check('formula boundaries: invalid %d exact diagnostic' % index,
                  str(exc) == expected, str(exc))
        else:
            check('formula boundaries: invalid %d exact diagnostic' % index, False, 'accepted')


def test_formula_office_math():
    """`formula.omml` hands the writer a finished, styled `<a14:m>`.

    Until 2.1 the writer parsed the LaTeX, wrapped it and styled every run
    itself (`render._style_omath`), away from the calibration that assumes
    Cambria Math. Now the style is part of the formula's answer.
    """
    ns = {'a': FM.A_NS, 'a14': FM.A14_NS, 'm': FM.M_NS}
    node = FM.omml('x_i^2 + \\alpha', 'T-Sans Medium', 34.0, True,
                   (255, 0, 0, 1.0))
    check('formula.omml returns an a14:m around one m:oMath',
          node.tag == '{%s}m' % FM.A14_NS
          and [c.tag for c in node] == ['{%s}oMath' % FM.M_NS], node.tag)
    props = node.xpath('.//a:rPr', namespaces=ns)
    check('formula.omml styles every run', bool(props), len(props))
    check('formula.omml: size, weight and colour of the prose',
          all(p.get('sz') == '2550' and p.get('b') == '1'
              and p.xpath('string(a:solidFill/a:srgbClr/@val)',
                          namespaces=ns) == 'FF0000' for p in props))
    check('formula.omml: Cambria Math for Latin, the prose face for the rest',
          all(p.xpath('string(a:latin/@typeface)', namespaces=ns) == 'Cambria Math'
              and p.xpath('string(a:ea/@typeface)', namespaces=ns) == 'T-Sans Medium'
              and p.xpath('string(a:cs/@typeface)', namespaces=ns) == 'T-Sans Medium'
              for p in props))
    # A negation with a precomposed character ships as that character, the
    # glyph Cambria Math designed for it; one without keeps the overlay.
    composed = {'=': u'\u2260', '<': u'\u226e', '\\leq': u'\u2270',
                '\\geq': u'\u2271', '\\in': u'\u2209', '\\ni': u'\u220c',
                '\\subset': u'\u2284', '\\subseteq': u'\u2288',
                '\\mid': u'\u2224', '\\sim': u'\u2241',
                '\\approx': u'\u2249', '\\equiv': u'\u2262',
                '\\propto': u'\u221d\u0338', '\\perp': u'\u22a5\u0338'}
    for relation, want in sorted(composed.items()):
        got = ''.join(FM.latex_to_omml('\\not' + relation).xpath(
            './/m:t/text()', namespaces=ns))
        check('formula: \\not%s ships as %s' % (relation, want.encode(
                  'unicode_escape').decode()),
              got == want, got.encode('unicode_escape').decode())

    regular = FM.omml('x', 'T-Sans', 34.0, False, (0, 0, 0, 1.0))
    check('formula.omml: no bold flag on regular prose',
          all(p.get('b') is None
              for p in regular.xpath('.//a:rPr', namespaces=ns)))


def test_formula_upright_style(out_dir):
    """Office Math plain style survives the writer independently of glyphs."""
    ns = {'m': FM.M_NS, 'a': FM.A_NS}
    # Literal glyphs/styles: NFKC would erase the Roman/italic distinction.
    cases = [
        (r'\mathrm{SE}(x)', [('S', 'p'), ('E', 'p'), ('(', 'p'), ('𝑥', None), (')', 'p')]),
        (r'\mathrm{Var}(x)', [('V', 'p'), ('a', 'p'), ('r', 'p'), ('(', 'p'), ('𝑥', None), (')', 'p')]),
        (r'\mathrm{x}+x', [('x', 'p'), ('+', 'p'), ('𝑥', None)]),
        (r'\mathrm{\alpha}+\alpha', [('α', 'p'), ('+', 'p'), ('𝛼', None)]),
        (r'\text{SE}+x', [('SE', 'p'), ('+', 'p'), ('𝑥', None)]),
        (r'\log x', [('log', 'p'), ('𝑥', None)]),
        (r'\mathbf{x}', [('𝐱', 'p')]),
        (r'\boldsymbol{\beta}', [('𝜷', None)]),
        (r'\mathit{x}', [('𝑥', None)]),
        (r'\mathbb{E}', [('𝔼', 'p')]),
        (r'\mathcal{L}', [('ℒ', 'p')]),
        (r'\mathsf{A}', [('𝖠', 'p')]),
        (r'\mathrm{x^2}', [('x', 'p'), ('2', 'p')]),
        (r'\frac{\mathrm{x}}{x}', [('x', 'p'), ('𝑥', None)]),
        (r'\sqrt[3]{\mathrm{x}}', [('3', 'p'), ('x', 'p')]),
        (r'\left(\mathrm{x}\right)', [('x', 'p')]),
        (r'\hat{\mathrm{x}}', [('x', 'p')]),
        (r'\mathrm{\frac{a}{b}}', [('a', 'p'), ('b', 'p')]),
        (r'x\leftrightarrow y', [('𝑥', None), ('↔', 'p'), (' ', 'p'), ('𝑦', None)]),
    ]
    def run_signature(node):
        return [(r.xpath('string(m:t)', namespaces=ns),
                 r.xpath('string(m:rPr/m:sty/@m:val)', namespaces=ns) or None)
                for r in node.xpath('.//m:r', namespaces=ns)]
    for index, (latex, expected) in enumerate(cases):
        plain = FM.latex_to_omml(latex)
        check('formula upright: case %d literal glyph/style' % index,
              run_signature(plain) == expected, repr(run_signature(plain)))
        for bold in (False, True):
            styled = FM.omml(latex, 'T-Sans Medium', 34.0, bold, (255, 0, 0, 1.0))
            check('formula upright: case %d writer bold=%s' % (index, bold),
                  run_signature(styled) == expected)
            runs = styled.xpath('.//m:r', namespaces=ns)
            check('formula upright: case %d property order bold=%s' % (index, bold),
                  all([c.tag for c in r] ==
                      ([FM._m('rPr')] if style == 'p' else []) +
                      [FM._a('rPr'), FM._m('t')]
                      for r, (_, style) in zip(runs, expected)))
            props = styled.xpath('.//m:r/a:rPr', namespaces=ns)
            check('formula upright: case %d prose formatting bold=%s' % (index, bold),
                  len(props) == len(expected) and all(
                      p.get('sz') == '2550' and p.get('b') == ('1' if bold else None)
                      and p.xpath('string(a:solidFill/a:srgbClr/@val)', namespaces=ns) == 'FF0000'
                      and p.xpath('string(a:latin/@typeface)', namespaces=ns) == 'Cambria Math'
                      and p.get('i') == ('1' if style is None else None)
                      for p, (_, style) in zip(props, expected)))
            check('formula upright: case %d preserves math spacing bold=%s' % (index, bold),
                  not styled.xpath('.//m:nor', namespaces=ns))
    for latex, want in [
            (r'\mathrm{SE}(x)', r'\mathrm{S}\mathrm{E}(x)'),
            (r'\mathrm{x}+x', r'\mathrm{x}+x'),
            (r'\mathrm{x^2}', r'{\mathrm{x}}^{\mathrm{2}}'),
            (r'\mathrm{\frac{a}{b}}', r'\frac{\mathrm{a}}{\mathrm{b}}')]:
        check('formula upright: canonical source %s' % latex,
              FM.validate(latex)[1] == want, FM.validate(latex)[1])
    control = FM.omml(r'\sum_{i=1}^n x_i', 'T-Sans', 34.0, False, (0, 0, 0, 1.0))
    check('formula upright: construct controls retain italic flags',
          control.xpath('.//m:ctrlPr/a:rPr/@i', namespaces=ns) == ['1', '1'])
    check('formula upright: populated argument slots', not _childless_arguments(control))

    deck = SP.deck_from_spec({'slides': [{'layout': 'cards', 'title': 'Style control',
        'cards': [{'title': 'Roman', 'text': r'Before \(\mathrm{x}+x\) after', 'icon': 'проверка'},
                  {'title': 'Alphabets', 'text': r'Before \(\mathbf{x}+\boldsymbol{x}\) after',
                   'icon': 'сравнение'}]}]}, skill_dir=SKILL)
    result = deck.build(os.path.join(out_dir, 'formula-upright'), strict=False, keep_html=True)
    with zipfile.ZipFile(result.pptx_path) as archive:
        root = etree.fromstring(archive.read('ppt/slides/slide1.xml'))
    maths = root.xpath('//m:oMath', namespaces=ns)
    check('formula upright: real writer emits two editable equations', len(maths) == 2)
    check('formula upright: real writer preserves literal styles',
          [run_signature(m) for m in maths] == [
              [('x', 'p'), ('+', 'p'), ('𝑥', None)],
              [('𝐱', 'p'), ('+', 'p'), ('𝒙', None)]])
    prose = ''.join(root.xpath('//a:t/text()', namespaces=ns))
    check('formula upright: continuation prose survives real build',
          prose.count('Before') == 2 and prose.count('after') == 2)


def test_formula_text_presentation():
    """An editable mathematical arrow never selects the prose fallback face."""
    ns = {'m': FM.M_NS, 'a': FM.A_NS}
    cases = [r'x\leftrightarrow y', r'\left[x\leftrightarrow y\right]',
             r'\mathbf{\leftrightarrow}', r'x_{\leftrightarrow}',
             r'\mathrm{\leftrightarrow}', r'x\leftrightarrow y\leftrightarrow z']
    for index, latex in enumerate(cases):
        node = FM.omml(latex, 'T-Sans Medium', 34.0, False, (0, 0, 0, 1.0))
        arrows = [run for run in node.xpath('.//m:r', namespaces=ns)
                  if '↔' in run.xpath('string(m:t)', namespaces=ns)]
        expected_count = 2 if index == 5 else 1
        check('formula text presentation: case %d native font slots' % index,
              len(arrows) == expected_count and all(
                  run.xpath('string(a:rPr/a:%s/@typeface)' % slot, namespaces=ns)
                  == 'Cambria Math' for run in arrows for slot in ('latin', 'ea', 'cs')))
        text = ''.join(node.xpath('.//m:t/text()', namespaces=ns))
        check('formula text presentation: case %d unchanged symbol without selectors' % index,
              text.count('↔') == expected_count and '\ufe0e' not in text and '\ufe0f' not in text,
              text.encode('unicode_escape').decode())

    controls = FM.omml(r'x\leftarrow y\rightarrow z+\alpha', 'T-Sans Medium',
                       34.0, False, (0, 0, 0, 1.0))
    props = controls.xpath('.//a:rPr', namespaces=ns)
    check('formula text presentation: other native runs keep prose EA/CS faces',
          bool(props) and all(p.xpath('string(a:%s/@typeface)' % slot, namespaces=ns)
                              == 'T-Sans Medium' for p in props for slot in ('ea', 'cs')))
    # Formula support does not relax the corporate ban on emoji/prose arrows.
    forbidden = Deck(skill_dir=SKILL)
    forbidden.title('Control')
    forbidden.cards('Control', [Card(title='Control', text='A ↔ B', icon='структура')])
    forbidden.final('Complete')
    issues = VD.check_deck(forbidden)
    check('formula text presentation: literal prose arrow is still rejected',
          any(issue.code == 'EMOJI' and issue.level == 'error' for issue in issues))


def test_formula_html_and_runs():
    """Formula markers survive HTML and become indivisible MathRun objects."""
    from lxml import html as lhtml
    from deckkit.html2pptx.layout import extract_segments

    el = lhtml.fragment_fromstring('<p>placeholder</p>')
    F.set_text_formula(el, 'до \\(x_i^2\\) после\nстрока')
    raw = etree.tostring(el, encoding='unicode')
    reparsed = lhtml.fragment_fromstring(raw)
    segments = extract_segments(reparsed)
    check('formula html: data-latex round trip',
          'data-latex="x_i^2"' in raw, raw)
    check('formula html: run order',
          len(segments) == 2 and isinstance(segments[0][1], MathRun)
          and segments[0][0].text == 'до '
          and segments[0][1].latex == 'x_i^2'
          and segments[0][2].text == ' после', repr(segments))

    bold = lhtml.fragment_fromstring(
        '<p><strong>до <span class="math" data-latex="x"></span>'
        ' после</strong></p>')
    bold_segments = extract_segments(bold)
    check('formula html: bold weight reaches MathRun',
          len(bold_segments[0]) == 3
          and isinstance(bold_segments[0][1], MathRun)
          and bold_segments[0][1].weight == 700,
          repr(bold_segments))


def test_formula_preview_continuation(out_dir):
    """A formula cannot interrupt subsequent prose, formulas or paragraphs."""
    import math
    from unittest.mock import patch
    from PIL import ImageChops, ImageDraw
    from deckkit import preview

    class StrictPreview(preview.Preview):
        def failed(self, box, exc):
            raise AssertionError('preview swallowed a paint failure: %s' % exc) from exc

    # No template CSS: the regression belongs to the Pillow adapter. The
    # narrow case wraps naturally; the paragraph case crosses text boxes.
    cases = [('single', 1500, False, False),
             ('wrapped', 240, False, False),
             ('paragraphs', 1500, True, False),
             ('gradient', 1500, False, True)]
    original_text = ImageDraw.ImageDraw.text
    original_metrics = preview.math_metrics
    for name, width, paragraphs, gradient in cases:
        markup = '<html><body><section class="slide" style="position:relative;width:1920px;height:1080px;">'
        for index in range(2 if paragraphs else 1):
            element = etree.Element('p')
            element.set('style', 'position:absolute;left:80px;top:%dpx;'
                        'width:%dpx;height:400px;margin:0;font-size:36px;'
                        'line-height:1.4;color:#222222;%s' % (
                            80 + index * 450, width,
                            'background:linear-gradient(90deg,#222222,#aa4400);'
                            'background-clip:text;' if gradient else ''))
            F.set_text_formula(element, r'Alpha \(x^2\) Bravo \(y_1\) Charlie')
            markup += etree.tostring(element, encoding='unicode')
        markup += '</section></body></html>'
        path = os.path.join(out_dir, 'formula-preview-%s.html' % name)
        with open(path, 'w', encoding='utf-8') as handle:
            handle.write(markup)
        document = Document.open(path, extra_dirs=[SKILL])
        root = document.box(1)
        boxes = [box for box in root.walk() if box.kind == 'text' and box.lines]
        check('formula preview %s: intended wrapping' % name,
              len(boxes) == (2 if paragraphs else 1)
              and (len(boxes[0].lines) > 1 if name == 'wrapped'
                   else all(len(box.lines) == 1 for box in boxes)))
        check('formula preview %s: intended letter gradient' % name,
              all((preview.TextStyle(box).gradient is not None) == gradient
                  for box in boxes))
        events, regions = [], []

        def draw_text(draw, xy, text, *args, **kwargs):
            if text.strip():
                events.append(text.strip())
                regions.append(draw.textbbox(xy, text, font=kwargs['font'],
                                             anchor=kwargs['anchor']))
            return original_text(draw, xy, text, *args, **kwargs)

        def draw_math(mathtext, size, weight):
            events.append('math:' + mathtext)
            return original_metrics(mathtext, size, weight)

        with tempfile.TemporaryDirectory(prefix='formula-preview-') as cache:
            target = StrictPreview(document.assets(cache), document.fonts)
            composite = target._composite

            def draw_layer(layer, x, y):
                # Formula paint follows its metrics call; gradient letters
                # are composited only after the last prose draw.
                if events and events[-1].startswith('math:'):
                    regions.append((x, y, x + layer.width, y + layer.height))
                return composite(layer, x, y)

            target._composite = draw_layer
            with patch.object(ImageDraw.ImageDraw, 'text', draw_text), \
                    patch.object(preview, 'math_metrics', draw_math):
                rendered = target.render(root)
        expected = ['Alpha', 'math:{x}^{2}', 'Bravo', 'math:{y}_{1}', 'Charlie']
        check('formula preview %s: ordered draw continues to final prose' % name,
              events == expected * (2 if paragraphs else 1), repr(events))
        check('formula preview %s: all text and math regions recorded' % name,
              len(regions) == 5 * (2 if paragraphs else 1), repr(regions))
        for index, rect in enumerate(regions):
            crop = rendered.crop(tuple(int(math.floor(v)) for v in rect))
            ink = ImageChops.difference(crop, Image.new('RGB', crop.size, 'white'))
            check('formula preview %s: visible run %d' % (name, index + 1),
                  ink.getbbox() is not None)


def test_preview_superscript_digits(out_dir):
    """Missing prose superscripts keep digit identity, ink band and advances."""
    from unittest.mock import patch
    from PIL import ImageChops, ImageDraw
    from deckkit import preview as PV
    from deckkit.html2pptx.textmeasure import FontBook

    fonts = FontBook(SKILL)
    # Keep the regression executable against the actual pre-fix adapter.
    draw_prose = getattr(PV, '_draw_prose',
                         lambda draw, xy, text, font, fill:
                         draw.text(xy, text, font=font.pil, fill=fill, anchor='ls'))
    # Independent literal pairs: do not read the fallback's mapping or regex.
    pairs = [('⁰', '0'), ('⁴', '4'), ('⁵', '5'), ('⁶', '6'),
             ('⁷', '7'), ('⁸', '8'), ('⁹', '9')]
    for weight, slot in [(400, 9), (500, 8), (700, 8)]:
        font = fonts.get('T-Sans', weight, 40)
        for char, digit in pairs:
            image = Image.new('L', (100, 100))
            draw_prose(ImageDraw.Draw(image), (20, 80), char, font, 255)
            ink = image.getbbox()
            check('superscript %s/%d: raised ink inside original slot' % (char, weight),
                  ink is not None and ink[0] >= 20 and ink[2] <= 20 + slot
                  and ink[1] == 54 and ink[3] == 69, repr(ink))
            # The independent reference is the ordinary digit in the same
            # shipped face at 120px, reduced to the literal 40px native³ band
            # (15px high) and measured missing-character slot (9 or 8px).
            raw = font.pil.font_variant(size=120).getmask(digit, mode='L')
            expected = Image.frombytes('L', raw.size, bytes(raw)).crop(raw.getbbox())
            expected = expected.resize((slot, 15), Image.LANCZOS)
            check('superscript %s/%d: correct digit and weight' % (char, weight),
                  image.crop((20, 54, 20 + slot, 69)).tobytes() == expected.tobytes())
        for text in ['¹²³', 'Обычный текст 10 2026', '']:
            actual = Image.new('L', (700, 100))
            expected = actual.copy()
            draw_prose(ImageDraw.Draw(actual), (20, 80), text, font, 255)
            ImageDraw.Draw(expected).text((20, 80), text, font=font.pil,
                                         fill=255, anchor='ls')
            check('superscript supported/control %r/%d unchanged' % (text, weight),
                  actual.tobytes() == expected.tobytes())
        calls = []
        original = ImageDraw.ImageDraw.text

        def record(draw, xy, text, *args, **kwargs):
            calls.append((xy, text))
            return original(draw, xy, text, *args, **kwargs)

        with patch.object(ImageDraw.ImageDraw, 'text', record):
            draw_prose(ImageDraw.Draw(Image.new('L', (700, 100))),
                           (20, 80), 'A⁵B⁰C', font, 255)
        check('superscript %d: following prose keeps exact original advances' % weight,
              calls == [((20, 80), 'A'),
                        ((20 + font.getlength('A⁵'), 80), 'B'),
                        ((20 + font.getlength('A⁵B⁰'), 80), 'C')], repr(calls))
    for size in [1, 8, 20, 34, 144]:
        image = Image.new('L', (300, 300))
        draw_prose(ImageDraw.Draw(image), (20, 200), '⁰⁴⁵⁶⁷⁸⁹',
                       fonts.get('T-Sans', 400, size), 255)
        check('superscript %dpx: visible without paint failure' % size,
              image.getbbox() is not None)

    original_draw = draw_prose
    for name, width, gradient in [('plain', 1500, False), ('wrapped', 240, False),
                                   ('gradient', 1500, True)]:
        element = etree.Element('p', style=(
            'position:absolute;left:80px;top:80px;width:%dpx;height:700px;'
            'font-family:T-Sans;font-size:36px;line-height:1.4;color:#222222;%s'
            % (width, 'background:linear-gradient(90deg,#222222,#aa4400);'
               'background-clip:text;' if gradient else '')))
        F.set_text_formula(element, r'10¹⁵⁵ \(x^2\) 10³⁰⁷ и −10³⁰⁸ Конец')
        path = os.path.join(out_dir, 'superscript-%s.html' % name)
        with open(path, 'w', encoding='utf-8') as handle:
            handle.write('<html><body><section class="slide" style="position:relative;'
                         'width:1920px;height:1080px;">' +
                         etree.tostring(element, encoding='unicode') +
                         '</section></body></html>')
        document = Document.open(path, extra_dirs=[SKILL])
        events, bitmaps = [], []
        bitmap = ImageDraw.ImageDraw.bitmap

        def prose(draw, xy, text, font, fill):
            events.append(text)
            return original_draw(draw, xy, text, font, fill)

        def record_bitmap(draw, xy, bitmap_image, fill=None):
            bitmaps.append((xy, bitmap_image.getbbox(), fill))
            return bitmap(draw, xy, bitmap_image, fill=fill)

        with tempfile.TemporaryDirectory(prefix='superscript-') as cache:
            with patch.object(PV, '_draw_prose', prose, create=True), \
                    patch.object(ImageDraw.ImageDraw, 'bitmap', record_bitmap):
                target = PV.Preview(document.assets(cache), document.fonts)
                result = target.render(document.box(1))
        check('superscript %s: all prose survives math/wrapping' % name,
              ''.join(events).replace(' ', '').replace('\u00a0', '') ==
              '10¹⁵⁵10³⁰⁷и−10³⁰⁸Конец', repr(events))
        check('superscript %s: all six missing digits painted' % name,
              len(bitmaps) == 6 and all(item[1] for item in bitmaps))
        check('superscript %s: visible final output' % name,
              ImageChops.difference(result, Image.new('RGB', result.size, 'white')).getbbox()
              is not None and not target.diagnostics)


# ------------------------------------------------------------------ media

def test_media_resolve_image(out_dir):
    """resolve_image accepts real PNG/JPEG, rejects everything else."""
    good_png = os.path.join(out_dir, 'good.png')
    Image.new('RGB', (4, 4), (200, 30, 30)).save(good_png, format='PNG')
    check('media: accepts png', MD.resolve_image(good_png) == good_png)

    good_jpg = os.path.join(out_dir, 'good.jpg')
    Image.new('RGB', (4, 4), (30, 200, 30)).save(good_jpg, format='JPEG')
    check('media: accepts jpeg', MD.resolve_image(good_jpg) == good_jpg)

    bad = [
        ('missing file', os.path.join(out_dir, 'nope.png'), None),
        ('corrupt file', os.path.join(out_dir, 'notes.png'), b'not an image'),
        ('unsupported format', os.path.join(out_dir, 'bad.bmp'), 'BMP'),
    ]
    for name, path, content in bad:
        if content == 'BMP':
            Image.new('RGB', (4, 4)).save(path, format='BMP')
        elif content is not None:
            with open(path, 'wb') as f:
                f.write(content)
        try:
            MD.resolve_image(path)
            check('media rejects: %s' % name, False, 'no error')
        except MediaError:
            check('media rejects: %s' % name, True)


def test_media_pixel_limit(out_dir):
    """Pillow limits reject resources with context without weakening the guard."""
    import warnings
    import importlib
    from contextlib import redirect_stdout, redirect_stderr
    from unittest.mock import patch
    from PIL import PngImagePlugin
    import build_deck as CLI
    C = importlib.import_module('deckkit.html2pptx.convert')
    work = os.path.join(out_dir, 'media-pixel-limit')
    os.makedirs(work, exist_ok=True)
    original_limit = Image.MAX_IMAGE_PIXELS
    files = []
    for fmt, suffix in [('PNG', 'png'), ('JPEG', 'jpg')]:
        path = os.path.join(work, 'tiny.' + suffix)
        Image.new('RGB', (4, 4), (40, 120, 180)).save(path, format=fmt)
        files.append(path)
        with open(path, 'rb') as stream:
            original = stream.read()
        # Sixteen pixels: at the limit accepts, at twice the limit warns,
        # strictly above twice the limit rejects. No large allocation needed.
        for limit, warning_count in [(16, 0), (8, 1), (None, 0)]:
            with patch.object(Image, 'MAX_IMAGE_PIXELS', limit), warnings.catch_warnings(record=True) as seen:
                warnings.simplefilter('always', Image.DecompressionBombWarning)
                try:
                    resolved = MD.resolve_image(path)
                except Exception:
                    resolved = None
            check('media pixels: %s limit=%s retains acceptance/warnings' % (fmt, limit),
                  resolved == path and len(seen) == warning_count
                  and all(issubclass(w.category, Image.DecompressionBombWarning) for w in seen))
        with patch.object(Image, 'MAX_IMAGE_PIXELS', 7):
            try:
                MD.resolve_image(path)
                message, error = '', None
            except Exception as exc:
                message, error = str(exc), exc
        check('media pixels: %s refuses with typed path/limit detail' % fmt,
              isinstance(error, MediaError) and message.startswith(path + ': image exceeds Pillow pixel limit (')
              and '16 pixels' in message and '14 pixels' in message, message)
        with open(path, 'rb') as stream:
            check('media pixels: %s preserves source bytes' % fmt, stream.read() == original)

    path = files[0]
    point = {'text': 'Контроль изображения', 'icon': 'данные'}
    cases = [
        ('image-points', {'title': 'Контроль', 'src': path, 'points': [point]}, 'image_points'),
        ('self-intro', {'name': 'Анна', 'role': 'Директор', 'src': path, 'items': ['Один', 'Два']}, 'self_intro'),
        ('image-gallery', {'title': 'Контроль', 'images': [dict(src=path, title='PNG', text='Контроль', icon='данные')] * 2}, 'image_gallery'),
        ('screenshot-phone', {'title': 'Контроль', 'text': 'Контроль', 'images': [{'src': path}]}, 'screenshot_phone'),
        ('screenshot-monitor', {'title': 'Контроль', 'src': path, 'points': [point]}, 'screenshot_monitor'),
    ]
    for layout, payload, method in cases:
        for route in ('spec', 'add', 'helper'):
            deck = Deck(skill_dir=SKILL)
            with patch.object(Image, 'MAX_IMAGE_PIXELS', 7):
                try:
                    if route == 'spec':
                        SP.deck_from_spec({'slides': [dict(payload, layout=layout)]}, SKILL)
                    elif route == 'add':
                        deck.add(layout, payload)
                    else:
                        getattr(deck, method)(**payload)
                    error = None
                except Exception as exc:
                    error = exc
            message = str(error)
            check('media pixels: %s %s refuses with resource context' % (layout, route),
                  isinstance(error, SpecError if route == 'spec' else MediaError)
                  and path + ': image exceeds Pillow pixel limit (' in message
                  and (route != 'spec' or 'slide 1 (%s)' % layout in message), message)
            check('media pixels: %s %s appends no failed slide' % (layout, route), len(deck) == 0)

    with patch.object(PngImagePlugin.PngImageFile, 'verify', side_effect=Image.DecompressionBombError('verify limit')):
        _raises('media pixels: verify failure is translated too', MediaError,
                path + ': image exceeds Pillow pixel limit (verify limit)', lambda: MD.resolve_image(path))
    for exception in (MemoryError('memory'), KeyboardInterrupt(), SystemExit(9), RuntimeError('unexpected')):
        with patch.object(Image, 'open', side_effect=exception):
            try:
                MD.resolve_image(path)
                caught = None
            except BaseException as exc:
                caught = exc
        check('media pixels: %s propagates unchanged' % type(exception).__name__, caught is exception)

    spec_path = os.path.join(work, 'rejected.json')
    with open(spec_path, 'w', encoding='utf-8') as stream:
        json.dump({'slides': [dict(cases[0][1], layout='image-points')]}, stream)
    output = os.path.join(work, 'retained.pptx')
    with open(output, 'wb') as stream:
        stream.write(b'previous complete deck')
    for flags in ([], ['--check']):
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(Image, 'MAX_IMAGE_PIXELS', 7), redirect_stdout(stdout), redirect_stderr(stderr):
            try:
                code = CLI.main([spec_path, '--out', output] + flags)
            except Exception as exc:
                code = None
                stderr.write('Unexpected exception: %s: %s' % (type(exc).__name__, exc))
        check('media pixels: CLI %s rejects without traceback' % flags,
              code == 1 and not stdout.getvalue() and 'Traceback' not in stderr.getvalue()
              and 'slide 1 (image-points)' in stderr.getvalue()
              and path + ': image exceeds Pillow pixel limit (' in stderr.getvalue(), stderr.getvalue())
        with open(output, 'rb') as stream:
            check('media pixels: CLI %s preserves previous output' % flags,
                  stream.read() == b'previous complete deck')
    check('media pixels: CLI creates no HTML or staging files',
          not any(n.endswith('.html') or n.startswith('.deck-build-') for n in os.listdir(work)))

    original_open, original_writer = Image.open, C.write_pptx
    def limited_open(source, *args, **kwargs):
        if isinstance(source, str) and os.path.realpath(source) == os.path.realpath(path):
            with patch.object(Image, 'MAX_IMAGE_PIXELS', 7):
                return original_open(source, *args, **kwargs)
        return original_open(source, *args, **kwargs)
    def late_limit(*args, **kwargs):
        with patch.object(Image, 'open', limited_open):
            return original_writer(*args, **kwargs)
    for strict in (True, False):
        with open(output, 'wb') as stream:
            stream.write(b'previous complete deck')
        deck = Deck(skill_dir=SKILL).image_points(**cases[0][1])
        with patch.object(C, 'write_pptx', late_limit):
            try:
                result = deck.build(output, strict=strict, keep_html=True)
                errors = result.errors
                check('media pixels: late non-strict failure returns no PPTX',
                      not strict and result.pptx_path is None)
            except BuildError as exc:
                errors = exc.issues
                check('media pixels: late strict failure raises BuildError', strict)
        check('media pixels: late strict=%s keeps P22.09 diagnostic' % strict,
              any(i.level == 'error' and i.slide == 1 and i.code == 'PAINT_FAILED'
                  and 'DecompressionBombError' in i.message and '16 pixels' in i.message for i in errors))
        with open(output, 'rb') as stream:
            check('media pixels: late strict=%s preserves previous output' % strict,
                  stream.read() == b'previous complete deck')
    check('media pixels: Pillow limit restored', Image.MAX_IMAGE_PIXELS == original_limit)


# -------------------------------------------------------------- object-fit

def test_cover_crop(out_dir):
    """cover_crop(): crop fractions for object-fit: cover, hand-derived."""
    from deckkit.html2pptx.assets import cover_crop

    wide = os.path.join(out_dir, 'cover-wide-src.png')
    Image.new('RGB', (200, 100), (200, 30, 30)).save(wide, format='PNG')
    left, top, right, bottom = cover_crop(wide, 300, 300)
    check('cover_crop: wide image in square box crops left/right',
          abs(left - 0.25) < 1e-6 and abs(right - 0.25) < 1e-6
          and top == 0.0 and bottom == 0.0,
          '%s' % ((left, top, right, bottom),))

    tall = os.path.join(out_dir, 'cover-tall-src.png')
    Image.new('RGB', (100, 200), (30, 200, 30)).save(tall, format='PNG')
    left, top, right, bottom = cover_crop(tall, 300, 300)
    check('cover_crop: tall image in square box crops top/bottom',
          abs(top - 0.25) < 1e-6 and abs(bottom - 0.25) < 1e-6
          and left == 0.0 and right == 0.0,
          '%s' % ((left, top, right, bottom),))

    square = os.path.join(out_dir, 'cover-square-src.png')
    Image.new('RGB', (150, 150), (30, 30, 200)).save(square, format='PNG')
    check('cover_crop: matching aspect ratio crops nothing',
          cover_crop(square, 300, 300) == (0.0, 0.0, 0.0, 0.0))

    check('cover_crop: zero-area box crops nothing',
          cover_crop(wide, 0, 300) == (0.0, 0.0, 0.0, 0.0))
    check('cover_crop: unreadable path crops nothing',
          cover_crop(os.path.join(out_dir, 'nope.png'), 300, 300)
          == (0.0, 0.0, 0.0, 0.0))


def test_object_fit_cover(out_dir):
    """object-fit: cover crops instead of stretching, in both PPTX and preview.

    The source image is black with a white band down the middle, sized so
    that the exact crop this fix removes is the black margins. A stretch
    (today's fallback for every other object-fit value) would leave black
    visible at the box edges; a correct crop leaves the box solid white —
    a marker a same-color test image could not show.
    """
    from deckkit.html2pptx.render import Renderer
    from deckkit.preview import Preview

    marker = Image.new('RGB', (200, 100), (0, 0, 0))
    marker.paste(Image.new('RGB', (100, 100), (255, 255, 255)), (50, 0))
    src = os.path.join(out_dir, 'cover-marker.png')
    marker.save(src, format='PNG')

    html_path = os.path.join(out_dir, 'cover-crop.html')
    with open(html_path, 'w', encoding='utf-8') as f:
        f.write(
            '<html><body>'
            '<section class="slide" style="position:relative;'
            'width:1920px;height:1080px;">'
            '<img src="cover-marker.png" style="position:absolute;'
            'left:0px;top:0px;width:300px;height:300px;'
            'object-fit:cover;">'
            '</section></body></html>')

    document = Document.open(html_path, extra_dirs=[SKILL])
    box = document.box(1)
    img_box = None
    for node in box.walk():
        if node.kind == 'image':
            img_box = node
            break
    check('object-fit: image box found in layout', img_box is not None)
    if img_box is None:
        return
    check('object-fit: style carries object-fit: cover',
          img_box.style.get('object-fit') == 'cover',
          repr(img_box.style.get('object-fit')))

    cache_dir = tempfile.mkdtemp(prefix='deckcovertest-')
    try:
        renderer = Renderer(document.assets(cache_dir), document.fonts)
        renderer.render_slide(box, 1)
        pptx_path = os.path.join(out_dir, 'cover-crop.pptx')
        renderer.save(pptx_path)
    finally:
        shutil.rmtree(cache_dir, ignore_errors=True)

    from pptx import Presentation

    slide = Presentation(pptx_path).slides[0]
    pictures = [s for s in slide.shapes
               if s.shape_type is not None and 'PICTURE' in str(s.shape_type)]
    check('object-fit: exactly one picture shape', len(pictures) == 1,
          '%d' % len(pictures))
    if pictures:
        shape = pictures[0]
        check('object-fit: crop_left/crop_right match cover_crop',
              abs(shape.crop_left - 0.25) < 0.01
              and abs(shape.crop_right - 0.25) < 0.01,
              'left=%.4f right=%.4f' % (shape.crop_left, shape.crop_right))
        check('object-fit: crop_top/crop_bottom stay zero (wide image, square box)',
              shape.crop_top == 0.0 and shape.crop_bottom == 0.0,
              'top=%.4f bottom=%.4f' % (shape.crop_top, shape.crop_bottom))

    cache_dir2 = tempfile.mkdtemp(prefix='deckcovertest2-')
    try:
        preview = Preview(document.assets(cache_dir2), document.fonts)
        image = preview.render(box)
    finally:
        shutil.rmtree(cache_dir2, ignore_errors=True)

    center = image.getpixel((150, 150))
    edge = image.getpixel((5, 150))
    check('object-fit: preview center is white (crop kept the marker)',
          min(center[:3]) > 200, '%s' % (center,))
    check('object-fit: preview left edge is white too (black margins cropped away)',
          min(edge[:3]) > 200, '%s' % (edge,))


# ------------------------------------------------------------------ chart

def _chart_slide(chart_type='bar'):
    """A container box with one chart child, built by hand — no HTML/CSS.

    Proves the paint.py dispatch and the two adapters directly, against a
    hand-built box rather than the real `chart` layout fragment — the same
    way step 1/2 proved `chartdata.py`/`media.py` without touching the render
    pipeline. `test_media_slides_through_spec` covers the fragment end to end.
    The chart is placed through `chartgeom.place`, the call the layout pass
    makes for a real slide.
    """
    data = CD.parse_csv('quarter,revenue\nQ1,10\nQ2,20\nQ3,30\n',
                        'quarter', 'revenue')
    return _chart_root(G.ChartBox(chart_type, data))


def _chart_root(chart):
    """A slide root holding one chart box at 100,100 800x500, placed."""
    from deckkit.html2pptx.layout import SLIDE_H, SLIDE_W, Box
    from deckkit.html2pptx.textmeasure import FontBook

    root = Box(None, {}, 'container')
    root.x, root.y, root.w, root.h = 0.0, 0.0, SLIDE_W, SLIDE_H
    chart_box = Box(None, {}, 'chart')
    chart_box.x, chart_box.y, chart_box.w, chart_box.h = 100.0, 100.0, 800.0, 500.0
    chart_box.chart = G.place(chart, G.Rect(100.0, 100.0, 800.0, 500.0),
                              FontBook(SKILL))
    root.children.append(chart_box)
    return root


def test_chart_native_render(out_dir):
    """render.py's chart() emits a real, editable a:chart — and does so
    deterministically: same input, byte-identical chart XML on a rebuild.
    """
    from pptx import Presentation
    from pptx.enum.chart import XL_CHART_TYPE

    from deckkit.html2pptx.render import Renderer
    from deckkit.html2pptx.textmeasure import FontBook

    root = _chart_slide('bar')
    paths = []
    for i in (1, 2):
        # A font book, not None: since v2.0 the chart's geometry measures its
        # tick labels, and its parts are set in named T-Sans faces.
        renderer = Renderer(None, FontBook(SKILL))
        renderer.render_slide(root, 1)
        path = os.path.join(out_dir, 'chart-native-%d.pptx' % i)
        renderer.save(path)
        paths.append(path)

    slide = Presentation(paths[0]).slides[0]
    charts = [s for s in slide.shapes if s.has_chart]
    check('chart: exactly one chart shape', len(charts) == 1, '%d' % len(charts))
    if not charts:
        return
    chart = charts[0].chart
    check('chart: type is clustered column for "bar"',
          chart.chart_type == XL_CHART_TYPE.COLUMN_CLUSTERED, str(chart.chart_type))
    check('chart: categories match input',
          list(chart.plots[0].categories) == ['Q1', 'Q2', 'Q3'],
          str(list(chart.plots[0].categories)))
    series = list(chart.series)
    check('chart: one series', len(series) == 1, '%d' % len(series))
    if series:
        check('chart: values match input',
              list(series[0].values) == [10.0, 20.0, 30.0], str(list(series[0].values)))

    def chart_xml_parts(names):
        return sorted(n for n in names
                      if n.startswith('ppt/charts/') and n.endswith('.xml'))

    with zipfile.ZipFile(paths[0]) as z1, zipfile.ZipFile(paths[1]) as z2:
        parts1, parts2 = chart_xml_parts(z1.namelist()), chart_xml_parts(z2.namelist())
        check('chart: same chart XML parts across two builds', parts1 == parts2,
              '%s vs %s' % (parts1, parts2))
        if parts1 == parts2 and parts1:
            same = all(z1.read(a) == z2.read(b) for a, b in zip(parts1, parts2))
            check('chart: chart XML is byte-identical across two builds', same)


def test_chart_preview(out_dir):
    """preview.py's chart() draws the shared chartgeom geometry without
    throwing, and something visibly non-blank lands in the chart's box. The
    agreement with the PPTX is tested on the geometry, not on pixels.
    """
    import numpy as np

    from deckkit.html2pptx.textmeasure import FontBook
    from deckkit.preview import Preview

    root = _chart_slide('line')
    preview = Preview(None, FontBook(SKILL))
    image = preview.render(root)
    region = np.asarray(image.crop((100, 100, 900, 600)))
    check('chart preview: something drawn in the chart box (not blank white)',
          region.min() < 250, 'min channel value in box: %d' % region.min())


def test_doughnut_zero_preview(out_dir):
    """Zero categories remain editable; only their empty paint is skipped."""
    from unittest.mock import patch
    import numpy as np
    from PIL import ImageDraw
    from pptx import Presentation
    from deckkit import preview as PV
    from deckkit.html2pptx.render import Renderer
    from deckkit.html2pptx.textmeasure import FontBook

    cases = [('first', [0, 100], 1), ('middle', [40, 0, 60], 2),
             ('last', [100, 0], 1), ('several', [0, 0, 100, 0], 1),
             ('tiny', [1e-20, 100], 2), ('positive', [40, 60], 2)]
    fonts = FontBook(SKILL)
    writer = Renderer(None, fonts)
    for index, (name, values, positive_count) in enumerate(cases, 1):
        categories = list('ABCD')[:len(values)]
        data = CD.from_inline({'categories': categories,
                              'series': [{'name': 'Share', 'values': values}]})
        root = _chart_root(G.ChartBox('doughnut', data))
        chart = root.children[0].chart
        geometry_before = copy.deepcopy(chart.geometry.sectors)
        writer.render_slide(root, index)
        for solid in (False, True):
            calls, empty_bounds = [], []
            pieslice = ImageDraw.ImageDraw.pieslice
            gradient_into = PV._gradient_into

            def trace_slice(draw, box, start, end, *args, **kwargs):
                calls.append((start, end))
                return pieslice(draw, box, start, end, *args, **kwargs)

            def trace_gradient(layer, mask, bounds, gradient):
                empty_bounds.append(bounds is None)
                return gradient_into(layer, mask, bounds, gradient)

            preview = PV.Preview(None, fonts)
            error, image = None, None
            # Palette instances are cached; patch temporarily, never mutate them.
            with patch.object(ImageDraw.ImageDraw, 'pieslice', trace_slice), \
                    patch.object(PV, '_gradient_into', trace_gradient), \
                    patch.object(chart.palette, 'gradient',
                                 (lambda *args: None) if solid else chart.palette.gradient):
                try:
                    image = preview.render(root, index=index)
                except Exception as exc:
                    error = exc
            label = 'doughnut zero: %s %s' % (name, 'solid' if solid else 'gradient')
            check(label + ' paints completely', error is None and not preview.diagnostics,
                  str(error))
            # Subtracting 90 degrees rounds the tiny positive sweep to zero
            # in Pillow's coordinates; its geometry still has positive area.
            check(label + ' skips zero categories',
                  len(calls) == positive_count
                  and all(end >= start if name == 'tiny' else end > start
                          for start, end in calls),
                  str(calls))
            check(label + ' never passes empty bounds', not any(empty_bounds))
            check(label + ' retains all geometry sectors',
                  chart.geometry.sectors == geometry_before and len(geometry_before) == len(values))
            if image is not None:
                reference = copy.deepcopy(chart.geometry)
                reference.sectors = [(a, b, c) for a, b, c in reference.sectors if b > a]
                clean = PV.Preview(None, fonts)
                clean.canvas = Image.new('RGBA', image.size, (255, 255, 255, 255))
                with patch.object(chart.palette, 'gradient',
                                  (lambda *args: None) if solid else chart.palette.gradient):
                    clean._chart_shapes(reference, chart.palette)
                    clean._chart_labels(reference, chart.palette)
                check(label + ' pixels match positive-sector rendering',
                      np.array_equal(np.asarray(image), np.asarray(clean.canvas.convert('RGB'))))
                check(label + ' visible ring and empty hole',
                      np.asarray(image.crop((250, 100, 750, 600))).min() < 200
                      and image.getpixel((500, 350)) == (255, 255, 255))
    path = os.path.join(out_dir, 'doughnut-zero-native.pptx')
    writer.save(path)
    for slide, (name, values, _) in zip(Presentation(path).slides, cases):
        native = next(shape.chart for shape in slide.shapes if shape.has_chart)
        check('doughnut zero: %s native categories and values retained' % name,
              list(native.plots[0].categories) == list('ABCD')[:len(values)]
              and list(native.series[0].values) == values)
        workbook = native.part.chart_workbook.xlsx_part.blob
        with zipfile.ZipFile(io.BytesIO(workbook)) as archive:
            sheet = etree.fromstring(archive.read('xl/worksheets/sheet1.xml'))
        ns = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
        stored = sheet.xpath('//s:c[starts-with(@r,"B") and @r!="B1"]/s:v/text()', namespaces=ns)
        check('doughnut zero: %s workbook values retained' % name,
              [float(value) for value in stored] == values)
    spec = {'slides': [dict(chart_type='doughnut', layout='chart', title='Zero sector',
            data={'categories': ['A', 'B'], 'series': [{'name': 'Share', 'values': [0, 100]}]},
            points=[{'text': 'All categories retained', 'icon': 'структура'}])]}
    source = os.path.join(out_dir, 'doughnut-zero-cli.json')
    with open(source, 'w', encoding='utf-8') as stream:
        json.dump(spec, stream)
    destination = os.path.join(out_dir, 'doughnut-zero-cli')
    result = subprocess.run([sys.executable, '-B', os.path.join(HERE, 'preview_deck.py'),
                             source, '--out', destination], capture_output=True, text=True)
    check('doughnut zero: public preview CLI writes complete PNG and exits zero',
          result.returncode == 0 and os.path.isfile(os.path.join(destination, 'doughnut-zero-cli-01.png')),
          result.stdout + result.stderr)


def _chart_render_xml(out_dir, chart_type, data_obj, mode=None):
    """Render one hand-built chart box and return its chart part XML string.

    Colours and geometry come from `chartgeom.place`, as on a real slide, so
    the assertions below test what actually ships in the chart part, not the
    data model. `data_obj` is a `chartdata.from_inline`-shaped dict.
    """
    from deckkit.html2pptx.render import Renderer
    from deckkit.html2pptx.textmeasure import FontBook

    root = _chart_root(G.ChartBox(chart_type, CD.from_inline(data_obj),
                                  mode=mode))

    renderer = Renderer(None, FontBook(SKILL))
    renderer.render_slide(root, 1)
    path = os.path.join(out_dir, 'chart-xml-%s.pptx' % chart_type)
    renderer.save(path)
    with zipfile.ZipFile(path) as archive:
        part = next(n for n in archive.namelist()
                    if n.startswith('ppt/charts/') and n.endswith('.xml'))
        return archive.read(part).decode('utf-8')


def test_chart_xml_patches(out_dir):
    """The chart part ships the design's patches (audit §6a / N5): pinned
    plot area, gap/overlap per variant, doughnut hole, line gridline alpha,
    dense 22px in-bar labels past 10 series. Each has a mutation twin — drop
    the patch in chartstyle.py and the matching check goes red.
    """
    from lxml import etree

    _NS = {'c': 'http://schemas.openxmlformats.org/drawingml/2006/chart',
           'a': 'http://schemas.openxmlformats.org/drawingml/2006/main'}

    def q(xml, path):
        return etree.fromstring(xml.encode('utf-8')).xpath(path,
                                                           namespaces=_NS)

    two = {'categories': ['A', 'B'],
           'series': [{'name': 's1', 'values': [1, 2]},
                      {'name': 's2', 'values': [3, 4]}]}
    one = {'categories': ['A', 'B'],
           'series': [{'name': 's', 'values': [1, 2]}]}

    stacked = _chart_render_xml(out_dir, 'stacked', two)
    check('chart xml: manualLayout layoutTarget inner',
          q(stacked, '//c:plotArea/c:layout/c:manualLayout/c:layoutTarget/@val')
          == ['inner'], str(q(stacked, '//c:manualLayout/c:layoutTarget/@val')))
    check('chart xml: manualLayout xMode/yMode edge',
          q(stacked, '//c:manualLayout/c:xMode/@val') == ['edge']
          and q(stacked, '//c:manualLayout/c:yMode/@val') == ['edge'],
          'x=%s y=%s' % (q(stacked, '//c:manualLayout/c:xMode/@val'),
                         q(stacked, '//c:manualLayout/c:yMode/@val')))
    # c:gapWidth itself is per chart since 2.3.0: test_bar_gap_2_3.
    check('chart xml: stacked overlap 100',
          q(stacked, '//c:overlap/@val') == ['100'],
          str(q(stacked, '//c:overlap/@val')))

    grouped = _chart_render_xml(out_dir, 'bar', two)
    check('chart xml: grouped bar overlap -5',
          q(grouped, '//c:overlap/@val') == ['-5'],
          str(q(grouped, '//c:overlap/@val')))

    single = _chart_render_xml(out_dir, 'bar', one)

    # Category names under the plot, not at the zero line across a negative
    # bar (iteration 2, slide 30, desktop export).
    check('chart xml: category labels sit low',
          q(single, '//c:catAx/c:tickLblPos/@val') == ['low'],
          str(q(single, '//c:catAx/c:tickLblPos/@val')))

    bar_h = _chart_render_xml(out_dir, 'bar_h', one)
    check('chart xml: bar_h first category on top',
          q(bar_h, '//c:catAx/c:scaling/c:orientation/@val') == ['maxMin'],
          str(q(bar_h, '//c:catAx/c:scaling/c:orientation/@val')))

    line = _chart_render_xml(out_dir, 'line', one)
    check('chart xml: line gridline alpha 10000',
          q(line, '//c:majorGridlines//a:alpha/@val') == ['10000'],
          str(q(line, '//c:majorGridlines//a:alpha/@val')))

    dough = _chart_render_xml(out_dir, 'doughnut',
                              {'categories': ['A', 'B', 'C', 'D'],
                               'series': [{'name': 's', 'values': [34, 32, 16, 18]}]})
    # A slice too narrow for its percentage ships without one, instead of
    # printing into its neighbour's (iteration 3, slide 41: "4%3%").
    thin = _chart_render_xml(out_dir, 'doughnut',
                             {'categories': ['A', 'B', 'C', 'D'],
                              'series': [{'name': 's', 'values': [90, 4, 3, 3]}]})
    check('chart xml: narrow doughnut slices drop their labels',
          q(thin, '//c:dLbl[c:delete/@val="1"]/c:idx/@val') == ['1', '2', '3'],
          str(q(thin, '//c:dLbl[c:delete/@val="1"]/c:idx/@val')))
    check('chart xml: doughnut holeSize 60',
          q(dough, '//c:holeSize/@val') == ['60'],
          str(q(dough, '//c:holeSize/@val')))

    # D12: past the threshold the in-bar labels use the dense 22px size
    # (16.5pt = sz 1650); an 8-series chart stays at chart_text, 22pt.
    dense = _chart_render_xml(out_dir, 'stacked',
                              {'categories': ['A'],
                               'series': [{'name': 's%d' % i, 'values': [1]}
                                          for i in range(10)]})
    sparse = _chart_render_xml(out_dir, 'stacked',
                               {'categories': ['A'],
                                'series': [{'name': 's%d' % i, 'values': [1]}
                                           for i in range(8)]})
    check('chart xml: 10-series in-bar labels are dense 16.5 pt (sz 1650)',
          'sz="1650"' in dense, 'sz not 1650 in 10-series chart')
    check('chart xml: 8-series in-bar labels stay 22 pt (sz 2200)',
          'sz="2200"' in sparse, 'sz not 2200 in 8-series chart')

    # 7a: past the dense threshold chartgeom uses the dense 22 px size in the
    # "is this segment tall enough for its label" gate, so a 22-32 px top
    # segment keeps its value instead of shipping without one. The top (last)
    # series is ~6 % of the stack — ≈27 px of a ~434 px plot — inside the band
    # the old 32 px gate rejected but the dense 22 px gate admits.
    dense_7a = _chart_render_xml(
        out_dir, 'stacked',
        {'categories': ['A'],
         'series': [{'name': 's%d' % i, 'values': [10]} for i in range(9)]
                   + [{'name': 's9', 'values': [6]}]})
    check('7a: a 22-32 px top segment keeps its value label',
          q(dense_7a, '//c:ser[10]//c:dLbls/c:dLbl/c:delete/@val') == [],
          'top segment label deleted: %s'
          % q(dense_7a, '//c:ser[10]//c:dLbls/c:dLbl/c:delete/@val'))

    # I5: value-mode bars carry a series-level solidFill (the positive hex) so
    # PowerPoint draws the negative points as well — the preview masked the
    # transparent-negative defect until the deck was opened in PowerPoint.
    value = _chart_render_xml(out_dir, 'bar',
                              {'categories': ['A', 'B'],
                               'series': [{'name': 's', 'values': [5, -3]}]},
                              mode='value')
    check('I5: value-mode series carries the positive base fill DAECBD',
          q(value, '//c:ser/c:spPr/a:solidFill/a:srgbClr/@val') == ['DAECBD'],
          str(q(value, '//c:ser/c:spPr/a:solidFill/a:srgbClr/@val')))
    neg = q(value, '//c:ser/c:dPt/c:spPr/a:solidFill/a:srgbClr/@val')
    check('I5: the negative point overrides with FFBFA3',
          'FFBFA3' in neg, 'negative point fills: %s' % neg)
    # The flag on every point, right after its idx - a point without one is
    # what PowerPoint drew transparent (schema order CT_DPt: idx first).
    flags = q(value, '//c:ser/c:dPt/*[2][self::c:invertIfNegative]/@val')
    check('I5: every value-mode point carries invertIfNegative 0 after idx',
          flags == ['0', '0'], 'point flags: %s' % flags)

    # I5 widened to bar_h: a value-mode horizontal bar shares _style_bars.
    value_h = _chart_render_xml(out_dir, 'bar_h',
                                {'categories': ['A', 'B'],
                                 'series': [{'name': 's', 'values': [5, -3]}]},
                                mode='value')
    check('I5: value-mode bar_h series also carries the DAECBD base fill',
          q(value_h, '//c:ser/c:spPr/a:solidFill/a:srgbClr/@val')
          == ['DAECBD'],
          str(q(value_h, '//c:ser/c:spPr/a:solidFill/a:srgbClr/@val')))


def _chart_legend_html(out_dir, name, chart_type, series, **fields):
    """Build one chart slide and return its serialized HTML (keep_html).
    `fields` go onto the chart slide as they are."""
    chart = {'layout': 'chart', 'title': 'Диаграмма', 'chart_type': chart_type,
             'data': {'categories': ['A', 'B'],
                      'series': [{'name': 'Ряд %d' % i, 'values': [1, 2]}
                                 for i in range(series)]},
             'points': [{'text': 'Вывод', 'icon': 'рост'}]}
    chart.update(fields)
    spec = {'slides': [{'layout': 'title', 'text': 'T'}, chart,
                       {'layout': 'final'}]}
    deck = SP.deck_from_spec(spec, skill_dir=SKILL)
    built = deck.build(os.path.join(out_dir, name), strict=True,
                       pptx=False, keep_html=True)
    with open(built.html_path, 'r', encoding='utf-8') as f:
        return f.read()


def test_chart_legend_density_and_swatch(out_dir):
    """A dense legend (>= threshold entries) ships compact and as a column
    (I4/I7); a line chart's legend swatch is a pill, not a square (I9).
    """
    # I4/I7: a 10-series stacked chart (the only chart that reaches the dense
    # threshold) gets a compact legend column.
    dense = _chart_legend_html(out_dir, 'legend-dense', 'stacked', 10)
    check('I4: a 10-series legend ships compact',
          'legend-column compact' in dense,
          'no compact legend column in %r' % dense[:200])

    # A 3-series stacked legend stays a plain column, not compact.
    sparse = _chart_legend_html(out_dir, 'legend-sparse', 'stacked', 3)
    check('I4: a 3-series legend is not compact',
          'legend-column compact' not in sparse,
          '3-series legend went compact')

    # I9: a line chart's legend swatch carries the `line` pill class.
    line = _chart_legend_html(out_dir, 'legend-line', 'line', 3)
    check('I9: a line chart legend swatch is a line pill',
          'legend-swatch line' in line, 'no line swatch in %r' % line[:200])

    # One series has no legend at all (slide 65): the chart title names it.
    lone = _chart_legend_html(out_dir, 'legend-lone', 'bar', 1)
    check('a single-series chart carries no legend',
          'legend-item' not in lone, 'legend kept for one series')

    # A bar chart's swatch stays a square (no `line` class).
    bar = _chart_legend_html(out_dir, 'legend-bar', 'bar', 3)
    check('I9: a bar chart legend swatch stays a square',
          'legend-swatch line' not in bar and 'legend-swatch"' in bar,
          'bar swatch wrongly became a line')


def test_chart_palette_by_kind(out_dir):
    """Accepted palettes follow type and series count, never axis categories."""
    from deckkit.html2pptx import chartstyle
    from lxml import etree
    from lxml import html as lhtml

    palette = G.load_palette()
    three = {'categories': ['A', 'B'],
             'series': [{'name': 'Ряд %d' % i, 'values': [1, 2]}
                        for i in range(3)]}
    ns = {'c': 'http://schemas.openxmlformats.org/drawingml/2006/chart',
          'a': 'http://schemas.openxmlformats.org/drawingml/2006/main'}

    def fills(kind, path, data=three):
        root = etree.fromstring(
            _chart_render_xml(out_dir, kind, data).encode('utf-8'))
        return [v.upper() for v in root.xpath(path, namespaces=ns)]

    # 2.4.0: the first yellow is a gradient on bars and the doughnut; its
    # first stop stands for it here (test_charts_new_2_4 reads the stops).
    yellow = ['FFDD2C', 'FFEE96', 'E1E1E1']
    grey = ['FFDD2D', '898989', 'E1E1E1']
    for kind in ('bar', 'bar_h', 'stacked'):
        got = fills(kind, '//c:barChart/c:ser/c:spPr/a:solidFill/a:srgbClr/@val'
                          ' | //c:barChart/c:ser/c:spPr/a:gradFill/a:gsLst'
                          '/a:gs[1]/a:srgbClr/@val')
        expected = ['FFDD2C', 'E1E1E1', 'C4C4C4'] if kind == 'bar_h' else yellow
        check('palette: %s uses its accepted series order' % kind,
              got == expected, str(got))
    got = fills('line', '//c:lineChart/c:ser/c:spPr/a:ln/a:solidFill'
                        '/a:srgbClr/@val')
    check('2.3.0 palette: line keeps yellow, then greys', got == grey,
          str(got))
    ring = {'categories': ['A', 'B', 'C'],
            'series': [{'name': 'Доля', 'values': [1, 2, 3]}]}
    got = fills('doughnut', '//c:dPt/c:spPr/a:solidFill/a:srgbClr/@val'
                            ' | //c:dPt/c:spPr/a:gradFill/a:gsLst/a:gs[1]'
                            '/a:srgbClr/@val', ring)
    check('2.3.0 palette: doughnut keeps yellow, then greys',
          got == ['FFDD2C'] + grey[1:],
          str(got))

    # Horizontal exceptions are by series count. Keep vertical/stacked and 5+.
    for count in range(2, 9):
        data = CD.from_inline({'categories': ['A'], 'series': [
            {'name': 's%d' % i, 'values': [1]} for i in range(count)]})
        for kind in ('bar', 'bar_h', 'stacked'):
            row = G.assign_colors(palette, kind, data)['series']
            expected = (['FFDD2D', 'E1E1E1'] if kind == 'bar_h' and count <= 4
                        else ['FFDD2D', 'FFEE96'])
            check('palette: %s of %d keeps the accepted first two colours'
                  % (kind, count), row[:2] == expected, str(row))

    horizontal = ['FFDD2D', 'E1E1E1', 'C4C4C4', '898989']
    for count in range(1, 6):
        for categories in (1, 2, 4, 6):
            data = CD.from_inline({'categories': ['Q%d' % i for i in range(categories)],
                                   'series': [{'name': 's%d' % i,
                                               'values': [i + 1] * categories}
                                              for i in range(count)]})
            row = G.assign_colors(palette, 'bar_h', data)
            expected = (horizontal[:count] if count <= 4 else
                        ['FFDD2D', 'FFEE96', 'E1E1E1', 'C4C4C4', '898989'])
            check('palette: horizontal %d series / %d categories' % (count, categories),
                  row == {'series': expected}, str(row))
            accents = chartstyle._next_colors(palette, 'bar_h', data, row)
            expected_accents = (horizontal + ['898989', '333333'] if count <= 4 else
                                ['FFDD2D', 'FFEE96', 'E1E1E1', 'C4C4C4', '898989', '333333'])
            check('palette: horizontal %d-series Excel accents' % count,
                  accents == expected_accents, str(accents))

    value_data = CD.from_inline({'categories': ['A', 'B'],
                                'series': [{'name': 's', 'values': [1, -1]}]})
    value_colors = G.assign_colors(palette, 'bar_h', value_data, 'value')
    check('palette: horizontal value mode keeps sign colours and no override',
          value_colors == {'points': ['DAECBD', 'FFBFA3']}
          and chartstyle._next_colors(palette, 'bar_h', value_data, value_colors) is None,
          str(value_colors))

    for count in (2, 4):
        sample = {'categories': ['A', 'B'], 'series': [
            {'name': 's%d' % i, 'values': [10 + i, 20 + i]} for i in range(count)]}
        got = fills('bar_h', '//c:barChart/c:ser/c:spPr/a:solidFill/a:srgbClr/@val'
                             ' | //c:barChart/c:ser/c:spPr/a:gradFill/a:gsLst'
                             '/a:gs[1]/a:srgbClr/@val', sample)
        check('palette: native horizontal %d-series fills' % count,
              got == ['FFDD2C'] + horizontal[1:count], str(got))

    # Grouped bars keep their 8-series ceiling.
    nine = CD.from_inline({'categories': ['A'], 'series': [
        {'name': 's%d' % i, 'values': [1]} for i in range(9)]})
    for kind in ('bar', 'bar_h'):
        try:
            G.assign_colors(palette, kind, nine)
            refused = False
        except G.ChartDataError:
            refused = True
        check('2.3.0 palette: %s of 9 series is refused' % kind, refused)

    # The legend paints its swatches with the chart's colours, in order.
    page = lhtml.fromstring(_chart_legend_html(out_dir, 'legend-colours',
                                               'bar', 3))
    swatches = [s.split('#')[1][:6].upper() for s in page.xpath(
        '//*[contains(concat(" ", @class, " "), " legend-swatch ")]/@style')]
    check('2.3.0 palette: the bar legend repeats the chart colours',
          swatches == ['FFDD2D', 'FFEE96', 'E1E1E1'], str(swatches))
    page = lhtml.fromstring(_chart_legend_html(out_dir, 'legend-horizontal-colours',
                                              'bar_h', 4))
    swatches = [s.split('#')[1][:6].upper() for s in page.xpath(
        '//*[contains(concat(" ", @class, " "), " legend-swatch ")]/@style')]
    check('palette: horizontal legend follows all four series colours',
          swatches == horizontal, str(swatches))


# A slide to put between two statements, which may not stand side by side
# (STATEMENT_RUN, 2.4.0).
_BETWEEN = {'layout': 'cards', 'title': 'Слайд', 'cards': [
    {'title': 'Карточка', 'icon': 'данные', 'text': 'Текст'}]}


def _codes_of(out_dir, name, slides):
    """Error codes (with messages) of a deck of `slides` between title/final."""
    spec = {'slides': [{'layout': 'title', 'text': 'T'}] + slides
            + [{'layout': 'final'}]}
    deck = SP.deck_from_spec(spec, skill_dir=SKILL)
    built = deck.build(os.path.join(out_dir, name), strict=False, pptx=False)
    return [(i.code, i.message) for i in built.issues if i.level == 'error']


def test_stress_test_2_1_1(out_dir):
    """What the v2.1.0 stress test (skill-test/v2.1.0, feedback PNGs) found.

    Each check names the slide of that deck it reproduces. The chart ones read
    the geometry `chartgeom` hands both adapters, or the chart part; the
    PowerPoint side of the label fixes can only be confirmed in PowerPoint.
    """
    from deckkit.html2pptx.textmeasure import FontBook

    _NS = {'c': 'http://schemas.openxmlformats.org/drawingml/2006/chart',
           'a': 'http://schemas.openxmlformats.org/drawingml/2006/main'}

    def q(xml, path):
        return etree.fromstring(xml.encode('utf-8')).xpath(path,
                                                           namespaces=_NS)

    # Slides 55/74/77: «13» over «%», «27» without its «%». Every label body,
    # series level and per point (the dark slice carries its own), no wrap.
    dough = _chart_render_xml(out_dir, 'doughnut',
                              {'categories': ['A', 'B', 'C', 'D'],
                               'series': [{'name': 's',
                                           'values': [38, 27, 22, 13]}]})
    wraps = q(dough, '//c:dLbls/c:txPr/a:bodyPr/@wrap'
                     ' | //c:dLbl/c:txPr/a:bodyPr/@wrap')
    check('2.1.1 slide 55: doughnut labels are wrap="none", point ones too',
          len(wraps) >= 2 and set(wraps) == {'none'}, str(wraps))
    # v2.2.0 stress test: `dLblPos val="ctr"` (2.1.1) left 8 ring slides
    # blank in PowerPoint. A doughnut has no label positions at all.
    check('2.2.0 gate: a doughnut label carries no dLblPos',
          q(dough, '//c:dLblPos') == [],
          str(q(dough, '//c:dLblPos/@val')))

    # Slides 43/79: names turned 45° and cut to «Д…». rot 0 = level, not auto.
    bars = _chart_render_xml(out_dir, 'bar',
                             {'categories': ['Увидели', 'Кликнули'],
                              'series': [{'name': 's', 'values': [3, 4]}]})
    check('2.1.1 slide 43: category names are pinned level (rot 0)',
          q(bars, '//c:catAx/c:txPr/a:bodyPr/@rot') == ['0'],
          str(q(bars, '//c:catAx/c:txPr/a:bodyPr/@rot')))
    check('2.1.1 slide 76: bar value labels are wrap="none"',
          q(bars, '//c:ser/c:dLbls/c:txPr/a:bodyPr/@wrap') == ['none'],
          str(q(bars, '//c:ser/c:dLbls/c:txPr/a:bodyPr/@wrap')))

    fonts = FontBook(SKILL)
    palette = G.load_palette()

    def measure(text, size, weight):
        return fonts.get('T-Sans', weight, size).getlength(text)

    def geometry(kind, categories, series, w, h):
        data = CD.from_inline({'categories': categories, 'series': [
            {'name': 's%d' % i, 'values': v} for i, v in enumerate(series)]})
        colors = G.assign_colors(palette, kind, data)
        return G.layout(kind, data, colors, G.Rect(0, 0, w, h), palette,
                        measure)

    def roles(g):
        return set(l.role for l in g.labels if l.index is not None)

    # Slide 76, right: twelve four-digit bars on a chart-two half (768 px).
    cac = [2900, 3000, 3050, 3100, 2950, 2800, 2650, 2500, 2450, 2420, 2410,
           2400]
    quarters = ['Q%d %d' % (i % 4 + 1, 24 + i // 4) for i in range(12)]
    g = geometry('bar', quarters, [cac], 768, 530)
    # At 28 px (2.3.0, chart_text) the four-digit labels fit; five digits
    # still step the whole chart down, axis names with them.
    check('2.3.0 slide 76: 12 four-digit bars keep chart_text',
          roles(g) == {'data_label'} and not g.dense and not g.problems,
          '%s %s' % (roles(g), g.problems))
    wide = geometry('bar', quarters, [[v * 10 for v in cac]], 768, 530)
    check('2.1.1 slide 76: 12 five-digit bars step to the dense labels',
          roles(wide) == {'data_label_dense'} and wide.dense
          and not wide.problems, '%s %s' % (roles(wide), wide.problems))
    check('2.1.1 slide 76: «Q1 24» wraps to two lines, as PowerPoint did',
          [l.text for l in g.labels if l.role == 'axis_tick'][:2]
          == ['Q1', '24'], str([l.text for l in g.labels][:4]))
    g = geometry('bar', quarters + quarters, [cac + cac], 768, 530)
    check('2.1.1: 24 four-digit bars clash even dense - a problem',
          len(g.problems) == 1 and 'value labels' in g.problems[0],
          str(g.problems))
    # Slide 53: two series of very different heights keep the full size -
    # their labels never meet, however narrow the bars.
    g = geometry('bar', quarters, [[0.84] * 12, [0.09] * 12], 1032, 750)
    check('2.1.1 slide 53: neighbours at different heights stay 32 px',
          roles(g) == {'data_label'} and not g.problems,
          '%s %s' % (roles(g), g.problems))
    # Slide 88: eight bar_h series over four quarters - 23 px bars. They
    # fitted the old 22 px dense labels; with 22 pt text the dense step is
    # 18 pt = 24 px (2026-10-01), so seven series is the most that fit.
    eight = [[220 + i] * 4 for i in range(8)]
    g = geometry('bar_h', ['Q1', 'Q2', 'Q3', 'Q4'], eight[:7], 779, 750)
    check('2.1.1 slide 88: 7x4 bar_h labels are dense',
          roles(g) == {'data_label_dense'} and not g.problems,
          '%s %s' % (roles(g), g.problems))
    g = geometry('bar_h', ['Q1', 'Q2', 'Q3', 'Q4'], eight, 779, 750)
    check('2.3.0 slide 88: 8x4 bar_h bars are thinner than an 18 pt label',
          len(g.problems) == 1 and 'do not fit' in g.problems[0],
          str(g.problems))
    g = geometry('bar_h', ['Q%d' % i for i in range(1, 9)],
                 [v * 2 for v in eight], 779, 750)
    check('2.1.1: 8x8 bar_h bars are thinner than an 18 pt label - a problem',
          len(g.problems) == 1, str(g.problems))

    # Slide 43: «Эксперименты» on five columns of a chart-two half.
    epics = ['Данные и хранилище', 'Метрики и дашборды', 'Эксперименты и A/B',
             'Модели и скоринг', 'Алерты и мониторинг']
    chart = {'chart_type': 'bar', 'chart_title': 'Эпики',
             'data': {'categories': epics,
                      'series': [{'name': 'a', 'values': [48, 37, 0, 0, 19]},
                                 {'name': 'b', 'values': [0, 0, 52, 41, 0]}]}}
    codes = _codes_of(out_dir, 'stress-43', [
        {'layout': 'chart-two', 'title': 'Эпики',
         'charts': [chart, dict(chart, chart_type='bar_h')]}])
    labels = [m for c, m in codes if c == 'CHART_LABELS']
    check('2.1.1 slide 43: a word wider than its column is CHART_LABELS',
          len(labels) == 1 and '"Эксперименты"' in labels[0], str(codes))

    # Slides 46/47/66/67: eight series in a line legend ran 680 px off the
    # slide. Five or more go to the column; four keep the head row.
    many = _chart_legend_html(out_dir, 'legend-line-8', 'line', 8)
    four = _chart_legend_html(out_dir, 'legend-line-4', 'line', 4)
    check('2.1.1 slide 46: an 8-series line legend is a column',
          'legend-column' in many and 'legend-row' not in many,
          'row kept for 8 series')
    check('2.1.1: a 4-series line legend stays a row',
          'legend-row' in four and 'legend-column' not in four,
          'column for 4 series')

    # Slides 4/106: a paragraph parked on a statement.
    long_text = ('Проблема 2024-го была не в объёме данных и не в числе '
                 'аналитиков, а в отсутствии причинной рамки: мы измеряли '
                 'корреляции и принимали решения вслепую')
    codes = _codes_of(out_dir, 'stress-4', [
        {'layout': 'statement', 'text': long_text}, _BETWEEN,
        {'layout': 'statement',
         'text': 'Каждый третий бросал анкету на середине'}])
    check('2.1.1 slide 4: a nine-line statement is STATEMENT_TOO_LONG, once',
          [c for c, _ in codes] == ['STATEMENT_TOO_LONG'], str(codes))

    # The designers' statements (tmp_files/statement_new_feedback): their
    # longest accepted one sets on three lines and passes; «Экосистемный
    # тест…» (96 chars, five lines) is refused.
    codes = _codes_of(out_dir, 'stress-statement-3', [
        {'layout': 'statement',
         'text': 'Меньше рекламы на главной — и меня ещё не уволили'},
        _BETWEEN,
        {'layout': 'statement',
         'text': 'Экосистемный тест: где ломаются клиентские пути, где '
                 'проседает техника, где реагирует маркетинг.'}])
    check('2.1.1 designers: three lines pass, five are STATEMENT_TOO_LONG',
          [c for c, _ in codes] == ['STATEMENT_TOO_LONG'], str(codes))

    # «решения не / всегда», «рекламы на / главной»: a short word travels
    # with the next one - on a statement since 2.1.1, everywhere since 2.3.0.
    deck = SP.deck_from_spec({'slides': [
        {'layout': 'statement', 'text': 'Хорошие решения не всегда по правилам'},
        {'layout': 'cards', 'title': 'Решения не всегда по правилам',
         'cards': [{'title': 'Карта', 'text': 'Текст', 'icon': 'рост'}]}]},
        skill_dir=SKILL)
    built = deck.build(os.path.join(out_dir, 'stress-glue'), strict=False,
                       pptx=False, keep_html=True)
    with open(built.html_path, 'r', encoding='utf-8') as f:
        html = f.read()
    check('2.1.1 designers: statement glues «не всегда», «по правилам»',
          'решения не всегда по правилам' in html,
          'glued statement text not found')
    check('2.3.0: a slide title glues its short words too',
          'Решения не\xa0всегда по\xa0правилам' in html,
          'title not glued')

    # Slide 18: «3100 ₽» fills its 553 px column (534 px at 192) and its ₽
    # reads as the start of «1,9 %». The same value last in the row is fine.
    def metrics(values):
        return {'layout': 'metrics', 'title': 'Три провала',
                'metrics': [{'value': v, 'text': 'Подпись'} for v in values]}
    codes = _codes_of(out_dir, 'stress-18', [
        metrics(['3100 ₽', '1,9 %', '0,79']),
        metrics(['0,79', '1,9 %', '3100 ₽'])])
    check('2.1.1 slide 18: a value crowding the next metric is METRIC_WRAP',
          [c for c, _ in codes] == ['METRIC_WRAP'] and '3100' in codes[0][1],
          str(codes))

    # ISSUE-10: «база данных» and «сервер» on one slide both meant
    # database.png, a hard DUPLICATE_ICON. «сервер» is a concept now, and the
    # allocator takes its next choice.
    library = Deck(skill_dir=SKILL).icons
    first = library.resolve('база данных')
    second = library.resolve('сервер', exclude_files={first})
    check('2.1.1 ISSUE-10: «сервер» next to «база данных» gets its own icon',
          first == 'database.png' and second not in (None, first),
          '%s %s' % (first, second))


def test_line_chart_options(out_dir):
    """2.2.0: value labels, markers with a halo, areas on a line chart.

    The look is the linear-graphs guide's (tmp_files/plots_new/linear/7.
    Linear graphs.png): chart 1 labels each series' peak, chart 2 every
    point with no value axis, chart 3 fills areas edge to edge. The chart
    part is read as XML; how PowerPoint draws it is confirmed in PowerPoint.
    """
    import numpy as np

    from deckkit.html2pptx.render import Renderer
    from deckkit.html2pptx.textmeasure import FontBook
    from deckkit.preview import Preview

    ns = {'c': 'http://schemas.openxmlformats.org/drawingml/2006/chart',
          'a': 'http://schemas.openxmlformats.org/drawingml/2006/main'}

    def box(series, categories=None, **options):
        data = CD.from_inline({
            'categories': categories or ['2022', '2023', '2024', '2025'][
                :len(series[0][1])],
            'series': [{'name': n, 'values': v} for n, v in series]})
        return G.ChartBox('line', data, **options)

    def xml(name, chart):
        renderer = Renderer(None, FontBook(SKILL))
        renderer.render_slide(_chart_root(chart), 1)
        path = os.path.join(out_dir, 'line-%s.pptx' % name)
        renderer.save(path)
        with zipfile.ZipFile(path) as archive:
            part = next(n for n in archive.namelist()
                        if n.startswith('ppt/charts/') and n.endswith('.xml'))
            root = etree.fromstring(archive.read(part))
        return lambda path: root.xpath(path, namespaces=ns)

    # Chart 2: every point labelled, dot and halo on each, no value axis,
    # a thin vertical from each point to the axis.
    two = box([('Выручка', [100, 400, 350, 450])], value_labels=True)
    q = xml('all', two)
    sers = q('//c:lineChart/c:ser')
    check('2.2.0 chart 2: a halo series ahead of the real one',
          len(sers) == 2 and q('//c:lineChart/c:ser[1]/c:dLbls') == []
          and q('//c:lineChart/c:ser[2]/c:dLbls/c:showVal/@val') == ['1'],
          '%d series' % len(sers))
    check('2.2.0 chart 2: halo 27 pt at 30 %, no line of its own',
          q('//c:lineChart/c:ser[1]/c:marker/c:size/@val') == ['27']
          and q('//c:lineChart/c:ser[1]/c:marker/c:spPr//a:alpha/@val')
          == ['30000']
          and q('//c:lineChart/c:ser[1]/c:spPr/a:ln/a:noFill') != [],
          str(q('//c:lineChart/c:ser[1]/c:marker/c:size/@val')))
    check('2.2.0 chart 2: the dot is an 11 pt circle in the line colour',
          q('//c:lineChart/c:ser[2]/c:marker/c:symbol/@val') == ['circle']
          and q('//c:lineChart/c:ser[2]/c:marker/c:size/@val') == ['11']
          and q('//c:lineChart/c:ser[2]/c:marker/c:spPr/a:solidFill/'
                'a:srgbClr/@val') == ['FFDD2D'],
          str(q('//c:lineChart/c:ser[2]/c:marker//@val')))
    check('2.2.0 chart 2: labels above the point, as written, none hidden',
          q('//c:dLbls/c:dLblPos/@val') == ['t']
          and q('//c:dLbls/c:numFmt/@formatCode') == ['General']
          and q('//c:dLbls/c:numFmt/@sourceLinked') == ['0']
          and q('//c:dLbl') == [], str(q('//c:dLbls/c:dLblPos/@val')))
    # A bare c:delete means true.
    check('2.2.0 chart 2: no value axis, drop lines instead',
          q('//c:valAx/c:delete[not(@val) or @val="1"]') != []
          and q('//c:dropLines') != []
          and q('//c:valAx/c:majorGridlines') == [],
          str(q('//c:valAx/c:delete/@val')))
    check('2.2.0 chart 2: the preview labels what the file labels',
          [l.text for l in two.geometry.labels if l.index is not None]
          == ['100', '400', '350', '450'],
          str([l.text for l in two.geometry.labels]))

    # Chart 3: areas, the largest behind; no outline, no line parts.
    three = box([('Малая', [1, 2, 2]), ('Большая', [3, 4, 5])], fill=True)
    q = xml('fill', three)
    check('2.2.0 chart 3: every series filled - an area chart, no lines',
          len(q('//c:areaChart/c:ser')) == 2 and q('//c:lineChart') == [],
          str(len(q('//c:areaChart/c:ser'))))
    check('2.2.0 chart 3: the larger area is drawn first (behind)',
          q('//c:areaChart/c:ser/c:spPr/a:solidFill/a:srgbClr/@val')
          == ['898989', 'FFDD2D'],
          str(q('//c:areaChart/c:ser/c:spPr/a:solidFill/a:srgbClr/@val')))
    check('2.2.0 chart 3: areas have no outline',
          len(q('//c:areaChart/c:ser/c:spPr/a:ln/a:noFill')) == 2,
          str(len(q('//c:areaChart/c:ser/c:spPr/a:ln/a:noFill'))))
    check('2.2.0 chart 3: area series carry no marker or smooth (schema)',
          q('//c:areaChart/c:ser/c:marker | //c:areaChart/c:ser/c:smooth')
          == [], 'line-only children left in c:areaChart')
    geo = three.geometry
    check('2.2.0 chart 3: areas run edge to edge (midCat)',
          q('//c:valAx/c:crossBetween/@val') == ['midCat']
          and abs(geo.areas[0][1][0][0] - geo.plot.x) < 0.01
          and abs(geo.areas[0][1][2][0] - geo.plot.right) < 0.01,
          str(q('//c:valAx/c:crossBetween/@val')))

    # Without the options, the line chart is what it was.
    plain = box([('A', [1, 3, 2]), ('B', [2, 1, 3])])
    q = xml('plain', plain)
    check('2.2.0: no options - no labels, dots, areas or midCat',
          q('//c:dLbls | //c:dPt | //c:areaChart | //c:crossBetween'
            ' | //c:dropLines') == []
          and q('//c:marker/c:symbol/@val') == ['none', 'none'],
          str(q('//c:marker/c:symbol/@val')))

    # The preview draws the areas and the halo from the same geometry.
    image = Preview(None, FontBook(SKILL)).render(_chart_root(
        box([('A', [5, 5, 5])], fill=True)))
    area = image.convert('RGB').getpixel((500, 500))
    check('2.2.0 preview: the area is filled in its series colour',
          area == (0xFF, 0xDD, 0x2D), str(area))
    halo_box = box([('A', [1, 3, 2])], value_labels=True)
    image = Preview(None, FontBook(SKILL)).render(_chart_root(halo_box))
    x, y = halo_box.geometry.lines[0][1][0]
    # Down and left of the first point: away from its line and drop line.
    pixel = np.asarray(image.convert('RGB'))[int(round(y)) + 9,
                                              int(round(x)) - 9]
    # FFDD2D at 30 % over the white plate: 255, 245, 192.
    check('2.2.0 preview: the halo is the line colour at 30 %',
          abs(int(pixel[1]) - 245) <= 4 and abs(int(pixel[2]) - 192) <= 6,
          str(pixel))

    # 2.3.0 hides "fill" behind features.line_fill; the code is still checked.
    features = G.load_palette().features
    was = features.get('line_fill')
    features['line_fill'] = True
    # A filled chart's series are patches of colour: square swatches.
    html = _chart_legend_html(out_dir, 'legend-fill', 'line', 2, fill=True)
    check('2.2.0: a fill chart keeps square legend swatches',
          html.count('legend-swatch line') == 0
          and html.count('class="legend-swatch"') == 2,
          '%d line swatches' % html.count('legend-swatch line'))

    # Neighbouring labels run into each other: a problem, as for bars.
    fonts = FontBook(SKILL)
    data = CD.from_inline({'categories': list('abcdefgh'), 'series': [
        {'name': 'A', 'values': [1000001 + i for i in range(8)]}]})
    palette = G.load_palette()
    g = G.layout('line', data, G.assign_colors(palette, 'line', data),
                 G.Rect(0, 0, 400, 530), palette,
                 lambda t, s, w: fonts.get('T-Sans', w, s).getlength(t),
                 G.line_options(True, None, data))
    check('2.2.0: labels of neighbouring points clash - a problem',
          len(g.problems) == 1 and 'run into each other' in g.problems[0],
          str(g.problems))
    # Every pair, not only neighbours in reading order: «0000» and «00» share
    # a point, «000» between them by x sits far below both.
    g = G.Geometry('line', G.Rect(0, 0, 800, 500), G.Rect(0, 0, 800, 500))
    for text, y in (('0000', 100), ('000', 400), ('00', 110)):
        g.labels.append(G.Label(text, 300, y, 'data_label', '333333', 'cb',
                                (0, 0)))
    check('2.2.0: a clash is found between labels that are not neighbours',
          G._label_clash(g, palette.type['data_label'],
                         lambda t, s, w: fonts.get('T-Sans', w, s).getlength(t))
          == ('0000', '00'), 'missed')

    # What the spec refuses, with the field in the message.
    def refused(fields):
        slide = {'layout': 'chart', 'title': 'T', 'chart_type': 'line',
                 'data': {'categories': ['Q1', 'Q2'], 'series': [
                     {'name': 'A', 'values': [5, 3]},
                     {'name': 'B', 'values': [3, 2]}]},
                 'points': [{'text': 'x', 'icon': 'рост'}]}
        slide.update(fields)
        try:
            SP.deck_from_spec({'slides': [{'layout': 'title', 'text': 'x'},
                                          slide, {'layout': 'final'}]},
                              skill_dir=SKILL)
        except SP.SpecError as exc:
            return ' '.join(exc.problems)
        return ''
    for fields, words in (
            ({'chart_type': 'bar', 'fill': True}, 'belongs to a line chart'),
            ({'value_labels': 'top'}, 'true (every point) or false'),
            ({'markers': True}, 'unknown field "markers"'),
            ({'fill': ['A']}, 'every series drawn as an area'),
            ({'fill': True, 'data': {'categories': ['Q1', 'Q2'], 'series': [
                {'name': 'A', 'values': [5, 3]}]}}, 'one series is a line'),
            ({'fill': True, 'value_labels': True}, 'has none'),
            ({'fill': True, 'data': {'categories': ['Q1', 'Q2'], 'series': [
                {'name': 'A', 'values': [5, 3]},
                {'name': 'B', 'values': [3, 5]}]}}, 'cross at "Q2"')):
        message = refused(fields)
        check('2.2.0 spec refuses %s' % sorted(fields), words in message,
              message or 'accepted')
    # Stress test slide 61: PowerPoint cut bar_h names past ~43 % of the chart
    # width to «…». On its 1032 px chart: 444 px printed whole, 473 px was cut.
    def bar_h(names):
        data = CD.from_inline({'categories': names, 'series': [
            {'name': 's', 'values': list(range(len(names), 0, -1))}]})
        return G.layout('bar_h', data, G.assign_colors(palette, 'bar_h', data),
                        G.Rect(0, 0, 1032, 750), palette,
                        lambda t, s, w: fonts.get('T-Sans', w, s).getlength(t))
    cut = bar_h(['Рекомендации действующих',
                 'Офлайн-отделения и банкоматные точки']).problems
    check('2.2.0 gate: a bar_h name PowerPoint would cut is a problem',
          len(cut) == 1 and 'Офлайн-отделения' in cut[0], str(cut))

    check('2.2.0 spec: "fill": true on its own is fine',
          refused({'fill': True, 'data': {'categories': ['Q1', 'Q2'],
                   'series': [{'name': 'A', 'values': [5, 3]},
                              {'name': 'B', 'values': [3, 2]}]}}) == '',
          'refused')
    features['line_fill'] = was


def test_number_format_2_3(out_dir):
    """2.3.0, the designers' review: a chart prints its numbers as Excel does.

    `number_format` is the code of the source cells. The workbook's cells
    carry it and the labels link to them (`sourceLinked`), so PowerPoint
    prints "27%" for 0.27 and keeps it after an edit in Excel; the preview
    and the measure print the same text, rounded half up as PowerPoint
    rounds. A code the labels cannot print as PowerPoint does is refused, as
    is a percentage written in points.
    """
    for code, value, text in (
            ('0%', 0.275, '28%'), ('0.0', 3.05, '3,1'), ('0.00', 2.675, '2,68'),
            ('#,##0', 1234567.5, '1\u00a0234\u00a0568'),
            ('0.0" млн"', 12.25, '12,3 млн'), ('#,##0,"K"', 1234567, '1\u00a0235K'),
            ('0"%"', 27, '27%'), ('0.0%', -0.031, '\u22123,1%'), ('0', -0.4, '0')):
        got = G.NumberFormat(code).render(value)
        check('number format: %s prints %r as %r' % (code, value, text),
              got == text, repr(got))
    check('number format: a quoted "%" does not scale the value',
          not G.NumberFormat('0"%"').percent and G.NumberFormat('0%').percent)
    check('half up: an unformatted label and a ring share round as PowerPoint',
          (G.format_number(2.5), G.format_number(2.675, 2), G._percent(1, 8))
          == ('3', '2,68', '13%'),
          str((G.format_number(2.5), G.format_number(2.675, 2),
               G._percent(1, 8))))
    check('number format: the axis step is one the code prints',
          (G.nice_scale(0, 0.04, resolution=0.01).step,
           G.nice_scale(0, 1.8, resolution=1).step,
           G.nice_scale(0, 1.8).step) == (0.01, 1, 0.5),
          str((G.nice_scale(0, 0.04, resolution=0.01),
               G.nice_scale(0, 1.8, resolution=1), G.nice_scale(0, 1.8))))

    def refused(code, values=(1, 2)):
        slide = {'layout': 'chart', 'title': 'T', 'chart_type': 'bar',
                 'number_format': code,
                 'data': {'categories': ['A', 'B'], 'series': [
                     {'name': 'S', 'values': list(values)}]},
                 'points': [{'text': 'x', 'icon': 'рост'}]}
        try:
            SP.deck_from_spec({'slides': [{'layout': 'title', 'text': 'x'},
                                          slide, {'layout': 'final'}]},
                              skill_dir=SKILL)
        except SP.SpecError as exc:
            return 'spec: ' + ' '.join(exc.problems)
        except (ValueError, ChartDataError) as exc:
            return str(exc)
        return ''
    # A bad code is a spec problem, listed with the others by --check, not
    # the first error of the build.
    for code, words in (('0;-0', 'sections'), ('[Red]0', '[colours]'),
                        ('# ##0', 'Russian'), ('0.0E+00', '"E"'),
                        ('0.#', 'number part')):
        message = refused(code)
        check('number format: %r is refused' % code,
              message.startswith('spec: ') and words in message
              and 'number_format' in message, message or 'accepted')
    try:
        SP.deck_from_spec({'slides': [
            {'layout': 'title', 'text': 'x', 'stray': 1},
            {'layout': 'chart', 'title': 'T', 'chart_type': 'bar',
             'number_format': '0;-0',
             'data': {'categories': ['A'], 'series': [
                 {'name': 'S', 'values': [1]}]},
             'points': [{'text': 'x', 'icon': 'рост'}]}]}, skill_dir=SKILL)
        listed = []
    except SP.SpecError as exc:
        listed = exc.problems
    check('number format: a bad code is listed with the other spec problems',
          any('stray' in p for p in listed)
          and any('number_format' in p for p in listed), str(listed))
    message = refused('0%', (27, 31))
    check('number format: a percentage in points is refused',
          'fraction' in message and '3100%' in message, message or 'accepted')
    check('number format: General and the supported codes are accepted',
          refused('General') == refused('0.0" млн"') == '' ,
          refused('General') + refused('0.0" млн"'))

    deck = SP.deck_from_spec(json.loads(json.dumps(_STAGE4_SPEC)),
                             skill_dir=SKILL)
    result = deck.build(os.path.join(out_dir, 'format23'), strict=False,
                        pptx=True, keep_html=True)
    document = Document.open(result.html_path, extra_dirs=[SKILL])
    texts, ticks, codes = [], [], []
    for root in document.boxes():
        for box in root.walk():
            if box.kind == 'chart' and box.chart.geometry is not None:
                g = box.chart.geometry
                texts.append([l.text for l in sorted(
                    (l for l in g.labels if l.index), key=lambda l: l.index)])
                ticks.append([l.text for l in g.labels
                              if l.index is None and l.anchor == 'rm'
                              and g.chart_type == 'line'])
                codes.append(g.tick_code)
    check('number format: labels as PowerPoint prints them',
          texts[0] == ['27%', '32%', '43%']
          and texts[2] == ['12,3 млн', '8,4 млн', '3,1 млн']
          and texts[3] == ['61%', '55%', '40%', '45%'], str(texts))
    check('number format: the axis drops the zeros its ticks share',
          ticks[1] == ['0', '1\u00a0000', '2\u00a0000', '3\u00a0000']
          and ticks[4] == ['0%', '2%', '4%', '6%']
          and (codes[1], codes[4]) == ('#,##0', '0%'),
          '%s %s' % (ticks, codes))

    with zipfile.ZipFile(result.pptx_path) as archive:
        parts = sorted(n for n in archive.namelist()
                       if re.match(r'ppt/charts/chart\d+\.xml$', n))
        roots = [etree.fromstring(archive.read(n)) for n in parts]
    ns = {'c': 'http://schemas.openxmlformats.org/drawingml/2006/chart'}
    cells = [r.xpath('string(//c:val//c:formatCode)', namespaces=ns)
             for r in roots]
    check('number format: the workbook cells carry the source code',
          cells == ['0%', '#,##0', '0.0" млн"', '0%', '0.0%'], str(cells))
    linked = [(r.xpath('//c:dLbls/c:numFmt/@formatCode', namespaces=ns),
               r.xpath('//c:dLbls/c:numFmt/@sourceLinked', namespaces=ns))
              for r in roots]
    check('number format: value labels link to the cells',
          all(set(s) == {'1'} and set(f) == {cells[i]}
              for i, (f, s) in enumerate(linked) if f)
          and len([l for l in linked if l[0]]) == 3, str(linked))
    axis = [r.xpath('//c:valAx/c:numFmt/@formatCode', namespaces=ns)
            for r in (roots[1], roots[4])]
    check('number format: the line axis takes the code at its own decimals',
          axis == [['#,##0'], ['0%']], str(axis))

    plain = SP.deck_from_spec({'slides': [
        {'layout': 'title', 'text': 'x'},
        {'layout': 'chart', 'title': 'T', 'chart_type': 'bar',
         'data': {'categories': ['A', 'B'], 'series': [
             {'name': 'S', 'values': [2, 2.4]}]},
         'points': [{'text': 'x', 'icon': 'рост'}]},
        {'layout': 'final'}]}, skill_dir=SKILL)
    built = plain.build(os.path.join(out_dir, 'format23-plain'), strict=False,
                        pptx=True)
    with zipfile.ZipFile(built.pptx_path) as archive:
        part = next(n for n in archive.namelist()
                    if re.match(r'ppt/charts/chart\d+\.xml$', n))
        root = etree.fromstring(archive.read(part))
    check('number format: without one a chart keeps General labels',
          root.xpath('//c:ser/c:dLbls/c:numFmt/@formatCode', namespaces=ns)
          == ['General']
          and root.xpath('//c:ser/c:dLbls/c:numFmt/@sourceLinked',
                         namespaces=ns) == ['0'])


def test_number_format_large_values(out_dir):
    """Large finite labels keep literal rounding and caller-context contracts."""
    import decimal

    def formatted(label, call, expected):
        try:
            actual = call()
        except Exception as error:
            check('large number format: ' + label, False,
                  '%s: %s' % (type(error).__name__, error))
        else:
            check('large number format: ' + label, actual == expected, repr(actual))

    # Repeated digits are literal decimal expectations, not formatter output.
    for value, places, trim, expected in [
            (1e27, 0, False, '1' + '0' * 27),
            (1e28, 0, False, '1' + '0' * 28),
            (1e30, 2, False, '1' + '0' * 30 + ',00'),
            (-1e30, 2, True, '−1' + '0' * 30),
            (1e300, 0, False, '1' + '0' * 300),
            (-1e300, 2, False, '−1' + '0' * 300 + ',00'),
            (1.23456789012345e30, 2, False,
             '123456789012345' + '0' * 16 + ',00'),
            (1.7976931348623157e308, 0, False,
             '179769313486232' + '0' * 294),
            (1e-300, 2, False, '0,00'),
            (-1e-300, 2, True, '0'),
            (5e-324, 0, False, '0'),
            (5e-324, 324, False, '0,' + '0' * 323 + '5'),
            (-5e-324, 323, False, '0,' + '0' * 323),
            (1e-300, 300, False, '0,' + '0' * 299 + '1'),
            (-0.0, 2, False, '0,00'),
            (2.5, 0, False, '3'), (-2.5, 0, False, '−3'),
            (2.675, 2, False, '2,68'), (-2.675, 2, False, '−2,68'),
            (9.999, 2, False, '10,00'),
            (1.2345678901234567, 16, False, '1,2345678901234600'),
            (1e28, 30, False, '1' + '0' * 28 + ',' + '0' * 30)]:
        formatted('plain %r/%d/%s' % (value, places, trim),
                  lambda: G.format_number(value, places, trim), expected)

    for code, value, expected in [
            ('0.00', 1e30, '1' + '0' * 30 + ',00'),
            ('#,##0', 1e30, '1' + '\xa0000' * 10),
            ('#,##0.00" units"', -1e30,
             '−1' + '\xa0000' * 10 + ',00 units'),
            ('0.0,', 1e30, '1' + '0' * 27 + ',0'),
            ('0.0"%"', 1e30, '1' + '0' * 30 + ',0%'),
            ('0.0%', 1e28, '1' + '0' * 30 + ',0%')]:
        formatted('code %r/%r' % (code, value),
                  lambda: G.NumberFormat(code).render(value), expected)

    data = G.ChartData(['A', 'B'], [G.Series('S', [1e30, -1e30])])
    values = G.ValueFormat(data)
    formatted('ValueFormat label', lambda: values.label(-1e30),
              '−1' + '0' * 30)
    formatted('ValueFormat ticks', lambda: values.ticks(G.Scale(0, 1e30, 5e29)),
              (['0', '5' + '0' * 29, '1' + '0' * 30], '0'))

    with decimal.localcontext() as context:
        context.prec = 3
        context.rounding = decimal.ROUND_DOWN
        context.Emax, context.Emin = 5, -5
        context.traps[decimal.Inexact] = True
        context.traps[decimal.Rounded] = True
        context.clear_flags()
        before = (context.prec, context.rounding, context.Emax, context.Emin,
                  dict(context.traps), dict(context.flags))
        formatted('private context large', lambda: G.format_number(1e300, 2),
                  '1' + '0' * 300 + ',00')
        formatted('private context rounding', lambda: G.format_number(2.675, 2),
                  '2,68')
        check('large number format: caller context unchanged',
              before == (context.prec, context.rounding, context.Emax,
                         context.Emin, dict(context.traps), dict(context.flags)))

    for value in (1e30, 1e300):
        spec = {'slides': [{'layout': 'chart-wide', 'title': 'Large values',
                           'chart_type': 'bar', 'data': {
                               'categories': ['A', 'B', 'C'], 'series': [
                                   {'name': 'S', 'values': [value, 2 * value,
                                                           3 * value]}]}}]}
        try:
            built = SP.deck_from_spec(spec, skill_dir=SKILL).build(
                os.path.join(out_dir, 'large-label-%s' % value),
                strict=False, pptx=False, keep_html=True)
            document = Document.open(built.html_path, extra_dirs=[SKILL])
            labels = [[label.text for label in box.chart.geometry.labels
                       if label.index is not None]
                      for slide in document.boxes() for box in slide.walk()
                      if box.kind == 'chart']
            zeros = 30 if value == 1e30 else 300
            check('large number format: build retains labels %r' % value,
                  not built.errors and labels == [[
                      '1' + '0' * zeros, '2' + '0' * zeros,
                      '3' + '0' * zeros]], repr(labels))
        except Exception as error:
            check('large number format: build retains labels %r' % value,
                  False, '%s: %s' % (type(error).__name__, error))


def _book(archive, chart_part):
    """(cells {ref: text}, [table refs]) of the workbook behind a chart part."""
    rels = archive.read(chart_part.replace('charts/', 'charts/_rels/')
                        + '.rels').decode('utf-8')
    target = re.search(r'Target="\.\./(embeddings/[^"]+)"', rels).group(1)
    book = zipfile.ZipFile(io.BytesIO(archive.read('ppt/' + target)))
    strings = re.findall(r'<t[^>]*>([^<]*)</t>',
                         book.read('xl/sharedStrings.xml').decode('utf-8'))
    cells = {}
    sheet = book.read('xl/worksheets/sheet1.xml').decode('utf-8')
    for ref, kind, value in re.findall(
            r'<c r="([A-Z]+\d+)"(?: s="\d+")?( t="s")?(?: s="\d+")?><v>([^<]*)</v>',
            sheet):
        cells[ref] = strings[int(value)] if kind else value
    tables = [re.search(r'ref="([^"]+)"', book.read(n).decode('utf-8')).group(1)
              for n in book.namelist() if n.startswith('xl/tables/')]
    return cells, tables


def test_excel_edit_2_3(out_dir):
    """2.3.0, the designers' review: an edit in Excel keeps the chart whole.

    A doughnut's centre figure is the chart title linked to a workbook cell
    (D2), not a layout box Excel cannot reach. The data is an Excel table, so
    a row or column typed next to it joins the chart. A chart carries a theme
    override whose accents are its palette, so a series added in Excel takes
    the next palette colour; and plot-level labels, so it is labelled like
    the rest. A centre figure too wide for the hole is refused.
    """
    ns = {'c': 'http://schemas.openxmlformats.org/drawingml/2006/chart',
          'a': 'http://schemas.openxmlformats.org/drawingml/2006/main'}
    point = [{'text': 'x', 'icon': 'рост'}]

    def chart(kind, series, **extra):
        slide = {'layout': 'chart', 'title': 'T', 'chart_type': kind,
                 'data': {'categories': ['A', 'B', 'C'], 'series': [
                     {'name': name, 'values': values}
                     for name, values in series]},
                 'points': point}
        slide.update(extra)
        return slide

    deck = SP.deck_from_spec({'slides': [
        {'layout': 'title', 'text': 'x'},
        chart('doughnut', [('База', [62, 24, 14])], center='4,2 млн'),
        chart('bar', [('Онлайн', [0.27, 0.31, 0.42]),
                      ('Офлайн', [0.21, 0.19, 0.16])], number_format='0%'),
        chart('line', [('План', [120, 145, 180]), ('Факт', [125, 138, 191])]),
        chart('line', [('План', [120, 145, 180])], value_labels=True),
        chart('bar_h', [('Онлайн', [27, 31, 42]), ('Офлайн', [21, 19, 16])]),
        {'layout': 'final'}]}, skill_dir=SKILL)
    built = deck.build(os.path.join(out_dir, 'excel23'), strict=False,
                       pptx=True, keep_html=True)
    html = open(built.html_path, encoding='utf-8').read()
    check('excel edit: the centre is not a layout box any more',
          'chart-center-value' not in html, 'chart-center-value in html')
    with zipfile.ZipFile(built.pptx_path) as archive:
        parts = sorted((n for n in archive.namelist()
                        if re.match(r'ppt/charts/chart\d+\.xml$', n)),
                       key=lambda n: int(re.search(r'(\d+)', n).group(1)))
        roots = [etree.fromstring(archive.read(n)) for n in parts]
        books = [_book(archive, n) for n in parts]
        overrides = []
        for name in parts:
            rels = archive.read(name.replace('charts/', 'charts/_rels/')
                                + '.rels').decode('utf-8')
            target = re.search(r'Target="\.\./(theme/themeOverride\d+\.xml)"',
                               rels)
            overrides.append(re.findall(
                r'<a:accent\d><a:srgbClr val="([0-9A-F]{6})"',
                archive.read('ppt/' + target.group(1)).decode('utf-8'))
                if target else None)
        theme = re.findall(r'<a:accent\d><a:srgbClr val="([0-9A-F]{6})"',
                           archive.read('ppt/theme/theme1.xml').decode('utf-8'))
    dough, bar, line, labelled = roots[:4]

    title = dough.xpath('//c:title', namespaces=ns)
    ref = dough.xpath('//c:title/c:tx/c:strRef/c:f/text()', namespaces=ns)
    cells, tables = books[0]
    check('excel edit: the centre is the chart title, linked to cell D2',
          len(title) == 1 and ref == ['Sheet1!$D$2']
          and dough.xpath('//c:autoTitleDeleted/@val', namespaces=ns) == ['0']
          and dough.xpath('//c:title/c:overlay/@val', namespaces=ns) == ['1'],
          '%s %s' % (len(title), ref))
    check('excel edit: D2 holds the centre figure, under a header',
          cells.get('D2') == '4,2 млн' and cells.get('D1') == 'Центр'
          and dough.xpath('//c:title//c:v/text()', namespaces=ns)
          == ['4,2 млн'], str(cells))
    size = dough.xpath('//c:title/c:txPr//a:defRPr/@sz', namespaces=ns)
    x = dough.xpath('//c:title//c:manualLayout/c:x/@val', namespaces=ns)
    y = dough.xpath('//c:title//c:manualLayout/c:y/@val', namespaces=ns)
    check('excel edit: the title is 54 pt, bold, at the ring\'s centre',
          size == ['5400'] and x and y and 0.25 < float(x[0]) < 0.5
          and 0.35 < float(y[0]) < 0.5
          and dough.xpath('//c:title/c:txPr//a:defRPr/@b',
                          namespaces=ns) == ['1'],
          '%s %s %s' % (size, x, y))

    # 2.3.0 gate: a white percentage (its own c:dLbl) printed «24», not
    # «24%» - the point label kept python-pptx's template flags.
    points = dough.xpath('//c:ser/c:dLbls/c:dLbl[not(c:delete)]',
                         namespaces=ns)
    check('doughnut: a white percentage is a percentage too',
          points and all(
              p.xpath('c:showPercent/@val', namespaces=ns) == ['1']
              and p.xpath('c:showVal/@val', namespaces=ns) == ['0']
              and p.xpath('c:numFmt/@formatCode', namespaces=ns) == ['0%']
              for p in points), str(len(points)))
    stray = [r for r in roots for p in r.xpath(
        '//c:ser/c:dLbls/c:dLbl[not(c:delete)]', namespaces=ns)
        if p.xpath('c:numFmt/@formatCode', namespaces=ns)
        != p.xpath('../c:numFmt/@formatCode', namespaces=ns)]
    check('every point label takes its series\' number format', not stray,
          str(len(stray)))

    check('excel edit: the data is an Excel table, category column included',
          books[1][1] == ['A1:C4'] and books[0][1] == ['A1:B4']
          and books[1][0].get('A1') == 'Категория', str([b[1] for b in books]))

    palette = G.load_palette()
    check('excel edit: a bar chart\'s accents are its palette, one series on',
          overrides[1] is not None
          and overrides[1][:3] == palette.table('stacked', 3),
          str(overrides[1]))
    check('excel edit: native horizontal accents include the accepted next series',
          overrides[4] == ['FFDD2D', 'E1E1E1', 'C4C4C4', '898989', '898989', '333333'],
          str(overrides[4]))
    check('excel edit: a doughnut\'s accents run on its slices\' table',
          overrides[0] is not None
          and overrides[0][:4] == palette.table('categorical', 4),
          str(overrides[0]))
    check('excel edit: every chart has its override, the deck theme stays',
          all(o is not None and len(o) == 6 for o in overrides)
          and theme[:2] == ['FFDD2D', '333333'], str(theme))

    group = bar.xpath('//c:barChart/c:dLbls', namespaces=ns)
    check('excel edit: a labelled bar chart labels a new series as the rest',
          len(group) == 1
          and group[0].xpath('c:showVal/@val', namespaces=ns) == ['1']
          and group[0].xpath('c:numFmt/@sourceLinked', namespaces=ns) == ['1']
          and group[0].xpath('c:txPr//a:defRPr/@sz', namespaces=ns)
          == ['2200'], str(len(group)))
    check('excel edit: an unlabelled line chart gets no plot labels',
          line.xpath('//c:lineChart/c:dLbls', namespaces=ns) == [])
    check('excel edit: a labelled line chart gets none: its halos stay bare',
          labelled.xpath('//c:lineChart/c:dLbls', namespaces=ns) == []
          and len(labelled.xpath('//c:ser', namespaces=ns)) == 2)

    # Too wide for the hole: refused, with the room it had.
    wide = SP.deck_from_spec({'slides': [
        {'layout': 'title', 'text': 'x'},
        chart('doughnut', [('База', [62, 24, 14])],
              center='4,2 млн активных клиентов'),
        {'layout': 'final'}]}, skill_dir=SKILL)
    issues = [str(i) for i in wide.build(os.path.join(out_dir, 'excel23-wide'),
                                         strict=False, pptx=False).issues]
    check('excel edit: a centre wider than the hole is refused',
          any('error' in i.lower() and 'the hole holds' in i for i in issues),
          str(issues))

    # features.native_center off: the layout box again, no title.
    features = palette.features
    was = features.get('native_center')
    features['native_center'] = False
    try:
        boxed = SP.deck_from_spec({'slides': [
            {'layout': 'title', 'text': 'x'},
            chart('doughnut', [('База', [62, 24, 14])], center='4,2 млн'),
            {'layout': 'final'}]}, skill_dir=SKILL)
        built = boxed.build(os.path.join(out_dir, 'excel23-boxed'),
                            strict=False, pptx=True, keep_html=True)
        html = open(built.html_path, encoding='utf-8').read()
        with zipfile.ZipFile(built.pptx_path) as archive:
            part = next(n for n in archive.namelist()
                        if re.match(r'ppt/charts/chart\d+\.xml$', n))
            root = etree.fromstring(archive.read(part))
        check('excel edit: native_center false draws the box, not a title',
              'chart-center-value' in html
              and root.xpath('//c:title', namespaces=ns) == [])
    finally:
        if was is None:
            features.pop('native_center', None)
        else:
            features['native_center'] = was


def test_bar_gap_2_3(out_dir):
    """2.3.0, the designers' review: one gap between columns on every column
    chart, whatever its kind or frame (`axes.bar_gap_px`), the columns
    taking the rest; and a line at zero under every column chart with a
    negative value (slide 40 of the 2.2.0 gate: negative stacks, no line).
    """
    from deckkit.html2pptx.textmeasure import FontBook
    palette = G.load_palette()
    fonts = FontBook(SKILL)
    want = palette.axes['bar_gap_px']

    def measure(text, size, weight):
        return fonts.get('T-Sans', weight, size).getlength(text)

    def geometry(kind, series, frame, count=4):
        data = CD.from_inline({
            'categories': ['К%d' % i for i in range(count)],
            'series': [{'name': 's%d' % i, 'values': values}
                       for i, values in enumerate(series)]})
        return G.layout(kind, data, G.assign_colors(palette, kind, data),
                        frame, palette, measure)

    def gaps(g):
        across = g.chart_type != 'bar_h'
        spans = {}
        for _, c_index, rect, _ in g.bars:
            lo, hi = (rect.x, rect.right) if across else (rect.y, rect.bottom)
            old = spans.get(c_index, (lo, hi))
            spans[c_index] = (min(old[0], lo), max(old[1], hi))
        ordered = [spans[c] for c in sorted(spans)]
        return [b[0] - a[1] for a, b in zip(ordered, ordered[1:])]

    wide, half = G.Rect(0, 0, 1100, 640), G.Rect(0, 0, 760, 420)
    cases = [('bar', [[3, 5, 4, 6]], wide), ('bar', [[3, 5, 4, 6]], half),
             ('bar', [[3, 5, 4, 6], [2, 4, 5, 3]], wide),
             ('bar', [[3, 5, 4, 6]] * 4, half),
             ('stacked', [[3, 5, 4, 6], [2, 4, 5, 3]], wide),
             ('stacked', [[3, 5, 4, 6], [2, 4, 5, 3]], half),
             ('bar_h', [[3, 5, 4, 6]], wide),
             ('bar_h', [[3, 5, 4, 6], [2, 4, 5, 3]], half)]
    measured = []
    for kind, series, frame in cases:
        g = geometry(kind, series, frame)
        measured.append((kind, len(series), frame.w,
                         [round(x, 1) for x in gaps(g)]))
    # c:gapWidth is a whole percentage of a bar: on a 270 px column that is
    # 1.35 px a step, so the gap lands within 1.5 px of the one asked for.
    # Clusters (2.4.0) take the designers' c:gapWidth instead.
    single = [m for m, (k, s, f) in zip(measured, cases)
              if k == 'stacked' or len(s) == 1]
    check('bar gap: one gap in px on every column chart and frame',
          all(abs(x - want) <= 1.5 for _, _, _, row in single
              for x in row), str(measured))
    check('bar gap: clusters take the designers\' gapWidth',
          all(geometry(k, s, f).gap_width
              == palette.axes['cluster_gap_width']
              for k, s, f in cases if k != 'stacked' and len(s) > 1))
    # The layout draws what PowerPoint does with the whole percentage: a
    # band of n bars, n - 1 gaps of c:overlap and one of c:gapWidth.
    inner = -palette.axes['overlap']['bar'] / 100.0
    drawn = []
    for kind, series, frame in cases:
        g = geometry(kind, series, frame)
        n = 1 if kind == 'stacked' else len(series)
        within = (inner if kind in ('bar', 'bar_h') and n > 1
                  and g.overlap != 0 else 0.0)
        side = g.plot.h if kind == 'bar_h' else g.plot.w
        rect = g.bars[0][2]
        drawn.append((kind, round(rect.h if kind == 'bar_h' else rect.w, 2),
                      round(side / 4.0 / (n + (n - 1) * within
                                          + g.gap_width / 100.0), 2)))
    check('bar gap: columns are drawn at the shipped whole percentage',
          all(abs(a - b) < 0.01 for _, a, b in drawn), str(drawn))
    narrow = geometry('bar', [[3, 5, 4, 6]], half).bars[0][2].w
    broad = geometry('bar', [[3, 5, 4, 6]], wide).bars[0][2].w
    check('bar gap: a wider frame gives wider columns, not a wider gap',
          broad > narrow + 50, '%.1f %.1f' % (narrow, broad))
    tight = geometry('bar', [[3] * 30], G.Rect(0, 0, 600, 400), count=30)
    check('bar gap: never more than half a band',
          all(0 < x <= 600 / 30.0 / 2 + 0.5 for x in gaps(tight)),
          str(gaps(tight)[:3]))

    # The writer ships the layout's own percentage.
    ns = {'c': 'http://schemas.openxmlformats.org/drawingml/2006/chart',
          'a': 'http://schemas.openxmlformats.org/drawingml/2006/main'}
    one = {'categories': ['A', 'B', 'C'],
           'series': [{'name': 's', 'values': [3, -2, 4]}]}
    up = {'categories': ['A', 'B', 'C'],
          'series': [{'name': 's1', 'values': [3, 2, 4]},
                     {'name': 's2', 'values': [1, 2, 2]}]}
    down = {'categories': ['A', 'B', 'C'],
            'series': [{'name': 's1', 'values': [3, 2, 4]},
                       {'name': 's2', 'values': [1, -2, 2]}]}
    shipped = []
    for kind, data in (('bar', one), ('stacked', up), ('bar_h', one)):
        root = etree.fromstring(
            _chart_render_xml(out_dir, kind, data).encode('utf-8'))
        placed = G.place(G.ChartBox(kind, CD.from_inline(data)),
                         G.Rect(100.0, 100.0, 800.0, 500.0), fonts)
        shipped.append((root.xpath('//c:gapWidth/@val', namespaces=ns),
                        str(placed.geometry.gap_width)))
    check('bar gap: c:gapWidth is the layout\'s percentage',
          all(got == [mine] for got, mine in shipped), str(shipped))

    def zero_line(kind, data):
        root = etree.fromstring(
            _chart_render_xml(out_dir, kind, data).encode('utf-8'))
        return bool(root.xpath('//c:catAx/c:spPr/a:ln/a:solidFill',
                               namespaces=ns))

    lines = dict((name, zero_line(kind, data)) for name, kind, data in (
        ('stacked up', 'stacked', up), ('stacked down', 'stacked', down),
        ('bar_h up', 'bar_h', up), ('bar_h down', 'bar_h', down),
        ('bar down', 'bar', one), ('bar up', 'bar', up)))
    check('zero line: every column chart with a negative value has one',
          lines['stacked down'] and lines['bar_h down'] and lines['bar down'],
          str(lines))
    check('zero line: stacks and bar_h above zero keep none, bars keep '
          'their baseline',
          not lines['stacked up'] and not lines['bar_h up']
          and lines['bar up'], str(lines))
    g = geometry('bar_h', [[3, -2, 4, 1]], wide)
    g_up = geometry('bar_h', [[3, 2, 4, 1]], wide)
    lefts = [rect.x for _, _, rect, _ in g.bars]
    check('zero line: bar_h\'s runs down the plot at zero',
          g.zero_x is not None and g_up.zero_x is None
          and g.plot.x < g.zero_x < g.plot.right
          and abs(g.zero_x - sorted(lefts)[-1]) < 0.5,
          '%s %s' % (g.zero_x, lefts))
    g = geometry('stacked', [[3, 5, 4, 6], [2, -4, 5, 3]], wide)
    base = [y for y, is_base in g.gridlines if is_base]
    tops = [rect.y for _, c, rect, _ in g.bars if c == 1]
    check('zero line: a stack\'s sits where its negative segment starts',
          len(base) == 1 and min(abs(base[0] - y) for y in tops) < 0.5,
          '%s %s' % (base, tops))


def test_chart_two_2_3(out_dir):
    """2.3.0, the designers' review of chart-two: the note beside the title
    keeps its icon, turns grey and holds exactly two lines; each chart
    carries its title;
    a legend row that crowds that title goes under it, at full size; the two
    halves keep the 60 px margin on both sides."""
    two = 'Рост во втором полугодии дал партнёрский канал, план выполнен в ноябре'

    def chart(title='Выручка', names=('План', 'Факт')):
        return {'chart_type': 'bar', 'chart_title': title,
                'data': {'categories': ['2024', '2025'],
                         'series': [{'name': n, 'values': [3 + i, 4 + i]}
                                    for i, n in enumerate(names)]}}

    def slide(**fields):
        data = {'layout': 'chart-two', 'title': 'Два графика',
                'charts': [chart(), chart('Клиенты')]}
        data.update(fields)
        return data

    def spec(*slides):
        return {'slides': [{'layout': 'title', 'text': 'x'}] + list(slides)
                + [{'layout': 'final'}]}

    def problems(data):
        try:
            SP.deck_from_spec(spec(data), skill_dir=SKILL)
        except SP.SpecError as exc:
            return ' '.join(exc.problems)
        return ''

    def build(name, *slides):
        deck = SP.deck_from_spec(spec(*slides), skill_dir=SKILL)
        result = deck.build(os.path.join(out_dir, name), strict=False,
                            pptx=False, keep_html=True)
        return result, Document.open(result.html_path, extra_dirs=[SKILL])

    # By slug, not by number: the numbers follow the registry's order and
    # moved when 2.4.0 retired the yellow-pattern statements.
    layouts_dir = os.path.join(SKILL, 'assets', 'layouts')
    fragment = open(os.path.join(layouts_dir, [
        name for name in os.listdir(layouts_dir)
        if name.endswith('-chart-two.html')][0]), encoding='utf-8').read()
    check('chart two: the note keeps its icon',
          'class="chart-note-icon"' in fragment
          and 'class="chart-note-text"' in fragment)
    css = open(os.path.join(SKILL, 'assets', 'base.css'),
               encoding='utf-8').read()
    rule = css[css.index('.chart-note-text {'):]
    check('chart two: the note is grey #676767, as on the long slide',
          'color: #676767;' in rule[:rule.index('}')])
    check('chart two: a note without its icon is refused',
          'go together' in problems(slide(note=two)), problems(slide(note=two)))
    untitled = slide()
    del untitled['charts'][1]['chart_title']
    untitled['charts'][0]['legend'] = 'right'
    # With the other problems of the spec, not one at a time.
    check('chart two: a chart without its title is refused',
          'chart 2 has no "chart_title"' in problems(untitled)
          and 'unknown field "legend"' in problems(untitled),
          problems(untitled))
    api = slide()
    del api['charts'][0]['chart_title']
    try:
        Deck(SKILL).add('chart-two', {k: v for k, v in api.items() if k != 'layout'})
        refused = ''
    except ValueError as exc:
        refused = str(exc)
    check('chart two: so does the Deck API', 'chart_title' in refused, refused)

    def codes(note):
        result, _ = build('two23-note', slide(note=note, note_icon='идея'))
        return [(i.code, i.level) for i in result.issues
                if 'note beside the title' in i.message]
    check('chart two: a one-line note is NOTE_SHORT',
          codes('Рост во втором полугодии') == [('NOTE_SHORT', 'error')],
          str(codes('Рост во втором полугодии')))
    check('chart two: a two-line note is fine', codes(two) == [],
          str(codes(two)))
    check('chart two: a three-line note is OVERFLOW',
          codes(two + ', ' + two) == [('OVERFLOW', 'error')],
          str(codes(two + ', ' + two)))

    long_names = ('Розничные клиенты', 'Корпоративные')
    result, document = build('two23-legend', slide(charts=[
        chart('Выручка, млрд ₽', long_names), chart('Клиенты')]))
    root = list(document.boxes())[1]
    heads, titles, rows, plates, dense = [], [], [], [], []
    for box in root.walk():
        classes = box.classes()
        if 'chart-head' in classes:
            heads.append('stacked' in classes)
        if 'chart-title' in classes:
            titles.append(box)
        if 'legend-row' in classes:
            rows.append(box)
        if 'chart-plate' in classes:
            plates.append((round(box.x), round(box.x + box.w)))
        if box.kind == 'chart' and box.chart.geometry is not None:
            dense.append(box.chart.geometry.dense)
    check('chart two: a legend that crowds its title goes under it',
          heads == [True, False], str(heads))
    check('chart two: from the title\'s left edge, below it',
          abs(rows[0].x - titles[0].x) < 1
          and rows[0].y >= titles[0].y + titles[0].h,
          '%s %s' % ((rows[0].x, rows[0].y), (titles[0].x, titles[0].y)))
    check('chart two: a short one stays beside its title, level with it',
          rows[1].x > titles[1].x + titles[1].w
          and abs((rows[1].y + rows[1].h / 2)
                  - (titles[1].y + titles[1].h / 2)) < 2,
          '%s %s' % ((rows[1].x, rows[1].y), (titles[1].x, titles[1].y)))
    check('chart two: neither chart steps down for it', dense == [False, False],
          str(dense))
    check('chart two: nothing to report', not [
        i for i in result.issues if i.slide == 2],
          str([str(i) for i in result.issues]))
    check('chart two: two halves, 60 px margins, equal gap',
          plates == [(60, 948), (972, 1860)], str(plates))


def test_chart_wide_2_3(out_dir):
    """2.3.0, the designers' review: `chart-wide`, one chart across the
    slide under the title row of chart-two. More than 8 categories beside
    the points of `chart` point here, fewer than 6 here point back; a
    doughnut is refused; the note beside the title holds exactly two
    lines; the slide takes the designers' long slide's geometry."""
    months = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен',
              'Окт', 'Ноя', 'Дек']

    def data(count, kind='bar'):
        return {'categories': months[:count],
                'series': [{'name': 'Выручка',
                            'values': [10 + i for i in range(count)]}]}

    def wide(count=12, kind='bar', **fields):
        slide = {'layout': 'chart-wide', 'title': 'Выручка по месяцам',
                 'chart_type': kind, 'data': data(count)}
        slide.update(fields)
        return slide

    def narrow(count, kind='bar'):
        return {'layout': 'chart', 'title': 'Выручка', 'chart_type': kind,
                'data': data(count),
                'points': [{'text': 'Рост', 'icon': 'рост'}]}

    def spec(*slides):
        return {'slides': [{'layout': 'title', 'text': 'x'}] + list(slides)
                + [{'layout': 'final'}]}

    def problems(slide):
        try:
            SP.deck_from_spec(spec(slide), skill_dir=SKILL)
        except SP.SpecError as exc:
            return ' '.join(exc.problems)
        return ''

    lead = 'Рост во втором полугодии дал партнёрский канал, план выполнен'
    deck = SP.deck_from_spec(spec(wide(note=lead, note_icon='рост',
                                       chart_title='Выручка'),
                                  wide(), narrow(4)), skill_dir=SKILL)
    result = deck.build(os.path.join(out_dir, 'wide23'), strict=False,
                        pptx=True, keep_html=True)
    check('chart wide: builds on its own layout',
          [s.layout for s in deck.slides][1:3] == ['chart-wide'] * 2,
          str([s.layout for s in deck.slides]))
    document = Document.open(result.html_path, extra_dirs=[SKILL])
    plates, frames, leads = {}, {}, {}
    for index, root in enumerate(document.boxes(), 1):
        for box in root.walk():
            if 'chart-plate' in box.classes():
                plates[index] = (round(box.x), round(box.w))
            if 'chart-note-text' in box.classes() and box.kind == 'text':
                leads[index] = len(box.lines)
            if box.kind == 'chart' and box.chart.geometry is not None:
                frames[index] = box.chart.geometry.frame.w
    check('chart wide: the plate of the long slide, 38..1882',
          plates.get(2) == (38, 1844) and plates.get(3) == (38, 1844),
          str(plates))
    sizes = [round(b.font_size) for root in list(document.boxes())[1:2]
             for b in root.walk() if 'title-chart-large' in b.classes()]
    check('chart wide: the title is 96 px, as large as the long slide\'s',
          sizes == [96], str(sizes))
    check('chart wide: its chart is wider than the one beside the points',
          frames.get(2, 0) > frames.get(4, 0) + 500, str(frames))
    check('chart wide: the note beside the title, dropped when not given',
          leads.get(2) == 2 and 3 not in leads, str(leads))
    check('chart wide: nothing to report on a full one',
          not [i for i in result.issues if i.slide in (2, 3)],
          str([str(i) for i in result.issues]))

    def widths(*slides):
        deck = SP.deck_from_spec(spec(*slides), skill_dir=SKILL)
        return [(i.slide, i.message) for i in VD.check_deck(deck)
                if i.code == 'CHART_WIDTH']
    check('chart wide: more than 8 categories beside the points point here',
          [n for n, m in widths(narrow(9), narrow(8))] == [2]
          and '"chart-wide"' in widths(narrow(9))[0][1],
          str(widths(narrow(9), narrow(8))))
    check('chart wide: bar_h keeps its long list beside the points',
          widths(narrow(12, 'bar_h')) == [], str(widths(narrow(12, 'bar_h'))))
    check('chart wide: fewer than 6 point back to "chart"',
          [n for n, m in widths(wide(5), wide(6))] == [2]
          and '"chart"' in widths(wide(5))[0][1],
          str(widths(wide(5), wide(6))))

    refused = problems(wide(kind='doughnut'))
    check('chart wide: a doughnut is refused, "chart" offered',
          'not "doughnut"' in refused and 'take "chart"' in refused, refused)
    check('chart wide: so is its centre figure',
          'unknown field "center"' in problems(wide(center='62%')),
          problems(wide(center='62%')))
    check('chart wide: every other chart type is drawn',
          all(problems(wide(kind=k)) == ''
              for k in ('bar', 'grouped', 'stacked', 'bar_h', 'line')),
          str([problems(wide(kind=k)) for k in ('stacked', 'bar_h', 'line')]))
    try:
        Deck(SKILL).add('chart-wide', {k: v for k, v in wide(kind='doughnut').items()
                                       if k != 'layout'})
        api = ''
    except ValueError as exc:
        api = str(exc)
    check('chart wide: the Deck API refuses the doughnut too',
          'not "doughnut"' in api, api)

    def note_codes(note):
        deck = SP.deck_from_spec(spec(wide(note=note, note_icon='рост')),
                                 skill_dir=SKILL)
        issues = deck.build(os.path.join(out_dir, 'wide23-note'),
                            strict=False, pptx=False).issues
        return [(i.code, i.level) for i in issues
                if 'beside the title' in i.message]
    check('chart wide: a note past two lines is an error',
          note_codes(lead + ', ' + lead) == [('OVERFLOW', 'error')],
          str(note_codes(lead + ', ' + lead)))
    check('chart wide: a one-line note is NOTE_SHORT',
          note_codes('Рост') == [('NOTE_SHORT', 'error')],
          str(note_codes('Рост')))
    check('chart wide: a note needs its icon',
          '"note" and "note_icon" go together' in problems(wide(note=lead)),
          problems(wide(note=lead)))


_STAGE4_SPEC = {
 "slides": [
  {
   "layout": "title",
   "text": "Формат чисел 2.3"
  },
  {
   "layout": "chart",
   "title": "Доля онлайн-заявок",
   "chart_type": "bar",
   "number_format": "0%",
   "data": {
    "categories": [
     "2023",
     "2024",
     "2025"
    ],
    "series": [
     {
      "name": "Онлайн",
      "values": [
       0.27,
       0.315,
       0.425
      ]
     }
    ]
   },
   "points": [
    {
     "text": "Онлайн растёт третий год",
     "icon": "рост"
    }
   ]
  },
  {
   "layout": "chart",
   "title": "Клиенты, тыс.",
   "chart_type": "line",
   "number_format": "#,##0",
   "data": {
    "categories": [
     "Q1",
     "Q2",
     "Q3",
     "Q4"
    ],
    "series": [
     {
      "name": "План",
      "values": [
       1200,
       1450,
       1800,
       2250
      ]
     },
     {
      "name": "Факт",
      "values": [
       1250,
       1380,
       1910,
       2120
      ]
     }
    ]
   },
   "points": [
    {
     "text": "Факт около плана",
     "icon": "рост"
    }
   ]
  },
  {
   "layout": "chart-two",
   "title": "Выручка и доля",
   "charts": [
    {
     "chart_type": "bar_h",
     "chart_title": "Выручка",
     "number_format": "0.0\" млн\"",
     "data": {
      "categories": [
       "Москва",
       "Регионы",
       "СНГ"
      ],
      "series": [
       {
        "name": "Выручка",
        "values": [
         12.25,
         8.4,
         3.05
        ]
       }
      ]
     }
    },
    {
     "chart_type": "stacked",
     "chart_title": "Структура",
     "number_format": "0%",
     "data": {
      "categories": [
       "2024",
       "2025"
      ],
      "series": [
       {
        "name": "Карты",
        "values": [
         0.605,
         0.55
        ]
       },
       {
        "name": "Кредиты",
        "values": [
         0.395,
         0.45
        ]
       }
      ]
     }
    }
   ]
  },
  {
   "layout": "chart",
   "title": "Ставка, ось в процентах",
   "chart_type": "line",
   "number_format": "0.0%",
   "data": {
    "categories": [
     "Янв",
     "Фев",
     "Мар",
     "Апр",
     "Май"
    ],
    "series": [
     {
      "name": "Ставка",
      "values": [
       0.021,
       0.034,
       0.028,
       0.045,
       0.052
      ]
     }
    ]
   },
   "points": [
    {
     "text": "Ставка растёт",
     "icon": "рост"
    }
   ]
  },
  {
   "layout": "final"
  }
 ]
}


def test_chart_text_2_5(out_dir):
    """The P08 gate: one size per chart, with a measured dense step.

    Axis names, value labels and the legend are chart_text (22 pt = 29.33 px)
    on a full chart, in chart-two and in chart-cards alike; a chart that
    does not fit steps down to chart_text_dense as a whole - its legend with
    it, and a legend that does not fit takes its chart down too. The
    doughnut uses fixed P10 typography, with a warning for omitted percentages.
    """
    from deckkit.html2pptx.render import Renderer
    from deckkit.html2pptx.textmeasure import FontBook

    palette = G.load_palette()
    size = palette.type['chart_text']['size']
    dense = palette.type['chart_text_dense']['size']
    check('chart text: 22 pt, dense 16.5 pt',
          (round(size * 0.75, 6), round(dense * 0.75, 6)) == (22, 16.5),
          str((size, dense)))
    check('chart text: every role takes the one size',
          all(palette.type[r]['size'] == size
              and palette.type[r + '_dense']['size'] == dense
              for r in G.CHART_TEXT_ROLES),
          str([(r, palette.type[r]['size']) for r in G.CHART_TEXT_ROLES]))
    rogue = json.loads(json.dumps(palette.data['typography']))
    rogue['data_label']['size'] = 32
    try:
        G._chart_text(rogue)
        refused = False
    except ValueError as exc:
        refused = 'data_label' in str(exc)
    check('chart text: a role with its own size is refused', refused)

    ns = {'c': 'http://schemas.openxmlformats.org/drawingml/2006/chart',
          'a': 'http://schemas.openxmlformats.org/drawingml/2006/main'}

    def xml(name, chart):
        renderer = Renderer(None, FontBook(SKILL))
        renderer.render_slide(_chart_root(chart), 1)
        path = os.path.join(out_dir, 'text23-%s.pptx' % name)
        renderer.save(path)
        with zipfile.ZipFile(path) as archive:
            part = next(n for n in archive.namelist()
                        if n.startswith('ppt/charts/') and n.endswith('.xml'))
            root = etree.fromstring(archive.read(part))
        return lambda path: root.xpath(path, namespaces=ns)

    def sizes(x):
        return (set(x('//c:catAx/c:txPr//a:defRPr/@sz')),
                set(x('//c:ser/c:dLbls/c:txPr//a:defRPr/@sz')))

    bars = CD.from_inline({'categories': ['A', 'B', 'C'], 'series': [
        {'name': 's', 'values': [10, 20, 30]}]})
    x = xml('plain', G.ChartBox('bar', bars))
    check('chart text xml: axis names and labels at 22 pt',
          sizes(x) == ({'2200'}, {'2200'}), str(sizes(x)))
    x = xml('dense', G.ChartBox('bar', bars, dense=True))
    check('chart text xml: a dense chart sets both at 16.5 pt',
          sizes(x) == ({'1650'}, {'1650'}), str(sizes(x)))

    fonts = FontBook(SKILL)

    def measure(text, size, weight):
        return fonts.get('T-Sans', weight, size).getlength(text)

    def ring(values):
        data = CD.from_inline({'categories': list('ABCD')[:len(values)],
                               'series': [{'name': 's', 'values': values}]})
        return G.layout('doughnut', data, G.assign_colors(
            palette, 'doughnut', data), G.Rect(0, 0, 520, 520), palette,
            measure)

    g = ring([70, 12, 10, 8])
    check('doughnut: every fitting percentage keeps the fixed size',
          not g.dense and len(g.labels) == 4 and not g.warnings
          and set(l.role for l in g.labels) == {'doughnut_percent'},
          '%s %s' % (g.dense, [l.text for l in g.labels]))
    g = ring([60, 20, 15, 5])
    check('doughnut: small percentages are omitted without shrinking',
          not g.dense and len(g.labels) == 3 and len(g.warnings) == 1
          and set(l.role for l in g.labels) == {'doughnut_percent'},
          '%s %s' % (g.dense, [l.text for l in g.labels]))
    g = ring([90, 4, 3, 3])
    check('doughnut: tiny slices keep the fixed ring size',
          not g.dense and [l.text for l in g.labels] == ['90%'],
          str([l.text for l in g.labels]))
    check('doughnut: a slice left unlabelled is a warning',
          len(g.warnings) == 3 and '"B" (4%)' in g.warnings[0],
          str(g.warnings))

    deck = SP.deck_from_spec(json.loads(json.dumps(_STAGE3_SPEC)),
                             skill_dir=SKILL)
    result = deck.build(os.path.join(out_dir, 'text23'), strict=False,
                        pptx=False, keep_html=True)
    document = Document.open(result.html_path, extra_dirs=[SKILL])
    legend, charts = {}, {}
    for index, root in enumerate(document.boxes(), 1):
        for box in root.walk():
            if box.kind == 'text' and 'legend-label' in box.classes():
                legend.setdefault(index, set()).add(round(box.font_size))
            if box.kind == 'chart' and box.chart.geometry is not None:
                charts.setdefault(index, []).append(box.chart.geometry)
    check('chart text: the legend is 22 pt on chart, chart-two, chart-cards',
          all(legend.get(i) == {29} for i in (2, 3, 4)), str(legend))
    check('chart text: those charts are not dense',
          not any(g.dense for i in (2, 3, 4) for g in charts.get(i, [])),
          str([(i, [g.dense for g in charts.get(i, [])]) for i in (2, 3, 4)]))
    five = charts.get(5, [])
    check('chart text: a dense chart takes its slide pair and legends along',
          legend.get(5) == {22} and len(five) == 2 and all(g.dense for g in five),
          '%s %s' % (legend.get(5), [g.dense for g in five]))
    six = charts.get(6, [])
    check('chart text: crowded bar steps down, doughnut legend stays large',
          legend.get(6) == {29, 22} and six and six[0].dense
          and set(l.role for l in six[0].labels)
          == {'axis_tick_dense', 'data_label_dense'},
          '%s %s' % (legend.get(6), [g.dense for g in six]))
    check('chart text: doughnut percentages keep their separate rule',
          len(six) == 2 and not six[1].dense, str([g.dense for g in six]))
    check('chart text: the unlabelled slice reaches validate as a warning',
          any(i.code == 'CHART_LABELS' and i.level == 'warning'
              and '"Прочее"' in i.message for i in result.issues),
          str([str(i) for i in result.issues]))


_STAGE3_SPEC = {'slides': [
    {'layout': 'title', 'text': 'Кегль 2.3'},
    {'layout': 'chart', 'title': 'Три ряда', 'chart_type': 'bar',
     'data': {'categories': ['2023', '2024', '2025'], 'series': [
         {'name': 'Москва', 'values': [12, 15, 14]},
         {'name': 'Регионы', 'values': [10, 11, 15]},
         {'name': 'СНГ', 'values': [4, 6, 7]}]},
     'points': [{'text': 'Регионы догоняют Москву', 'icon': 'рост'}]},
    {'layout': 'chart-two', 'title': 'Два графика', 'charts': [
        {'chart_type': 'bar', 'chart_title': 'Выручка',
         'data': {'categories': ['2023', '2024', '2025'], 'series': [
             {'name': 'Москва', 'values': [12, 15, 14]},
             {'name': 'Регионы', 'values': [10, 11, 15]}]}},
        {'chart_type': 'line', 'chart_title': 'Клиенты',
         'data': {'categories': ['Q1', 'Q2', 'Q3', 'Q4'], 'series': [
             {'name': 'План', 'values': [10, 14, 18, 22]},
             {'name': 'Факт', 'values': [12, 13, 19, 21]}]}}]},
    {'layout': 'chart-cards', 'title': 'Карточки', 'chart_type': 'line',
     'data': {'categories': ['Q1', 'Q2', 'Q3', 'Q4'], 'series': [
         {'name': 'План', 'values': [10, 14, 18, 22]},
         {'name': 'Факт', 'values': [12, 13, 19, 21]}]},
     'cards': [{'title': 'Рост', 'text': 'Факт идёт вровень с планом'},
               {'value': '22', 'text': 'клиента в четвёртом квартале'},
               {'title': 'Риск', 'text': 'Второй квартал ниже плана'}]},
    {'layout': 'chart-two', 'title': 'Плотные подписи', 'charts': [
        {'chart_type': 'bar', 'chart_title': 'Выручка',
         'data': {'categories': ['Q1', 'Q2', 'Q3', 'Q4'],
                  'series': [{'name': 'План', 'values': [1290000, 1300000,
                                                         1305000, 1310000]},
                             {'name': 'Факт', 'values': [1280000, 1310000,
                                                         1300000, 1305000]}]}},
        {'chart_type': 'bar', 'chart_title': 'Клиенты',
         'data': {'categories': ['A', 'B'], 'series': [
             {'name': 'План', 'values': [3, 4]},
             {'name': 'Факт', 'values': [2, 5]}]}}]},
    {'layout': 'chart-two', 'title': 'Длинная легенда', 'charts': [
        {'chart_type': 'bar', 'chart_title': 'Клиенты',
         'data': {'categories': ['2024', '2025'], 'series': [
             {'name': 'Розничные клиенты', 'values': [12, 15]},
             {'name': 'Корпоративные', 'values': [10, 11]},
             {'name': 'Малый бизнес', 'values': [4, 6]}]}},
        {'chart_type': 'doughnut', 'chart_title': 'Доля',
         'data': {'categories': ['Карты', 'Кредиты', 'Вклады', 'Прочее'],
                  'series': [{'name': 'Доля', 'values': [55, 30, 13, 2]}]}}]},
    {'layout': 'final'},
]}


def test_chart_text_auto_2_5(out_dir):
    """P08: measured density changes only the crowded chart and warns."""
    months = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт']
    values = [12345, 13900, 14500, 16780, 17920,
              18320, 19400, 20530, 21320, 22210]
    dense_data = {'categories': months,
                  'series': [{'name': 'Операции', 'values': values}]}
    long_data = {'categories': ['Янв', 'Фев', 'Мар', 'Апр'],
                 'series': [{'name': name, 'values': values}
                            for name, values in (
                                ('Мобильное приложение', [20, 24, 28, 31]),
                                ('Интернет-банк', [15, 17, 18, 20]),
                                ('Партнёрская сеть', [10, 12, 11, 14]),
                                ('Офисы обслуживания', [8, 9, 10, 10]),
                                ('Контактный центр', [5, 6, 7, 8]))]}
    spec = {'slides': [
        {'layout': 'title', 'text': 'Chart text auto'},
        json.loads(json.dumps(_STAGE3_SPEC['slides'][1])),
        {'layout': 'chart-two', 'title': 'Плотность', 'charts': [
            {'chart_type': 'bar', 'chart_title': 'Короткий ряд',
             'data': {'categories': ['A', 'B'], 'series': [
                 {'name': 'Ряд', 'values': [3, 4]}]}},
            {'chart_type': 'bar', 'chart_title': 'Десять значений',
             'number_format': '#,##0', 'data': dense_data}]},
        {'layout': 'chart', 'title': 'Длинные названия',
         'chart_type': 'bar', 'chart_title': 'Операции, тыс.',
         'data': long_data,
         'points': [{'text': 'Легенда использует плотный кегль',
                     'icon': 'структура'}]},
        {'layout': 'chart-wide', 'title': 'Широкий график',
         'chart_type': 'bar', 'chart_title': 'Операции, тыс.',
         'number_format': '#,##0', 'data': dense_data},
        {'layout': 'final'}]}
    deck = SP.deck_from_spec(spec, skill_dir=SKILL)
    result = deck.build(os.path.join(out_dir, 'chart-text-auto'),
                        strict=True, keep_html=True)
    reduced = [(i.slide, i.message) for i in result.issues
               if i.code == 'CHART_TEXT_REDUCED']
    check('chart text auto: only dense values and long legend warn',
          [s for s, _ in reduced] == [3, 4]
          and all('22 pt to 16.5 pt' in message for _, message in reduced)
          and '(2 charts)' in reduced[0][1]
          and '(1 chart)' in reduced[1][1],
          str(reduced))
    doc = Document.open(result.html_path, extra_dirs=[SKILL])
    charts = [[box.chart.geometry.dense for box in root.walk()
               if box.kind == 'chart' and box.chart.geometry is not None]
              for root in doc.boxes()]
    check('chart text auto: the pair steps together, ordinary/wide stay large',
          charts[1:5] == [[False], [True, True], [True], [False]],
          str(charts[1:5]))
    with zipfile.ZipFile(result.pptx_path) as archive:
        ns = {'c': 'http://schemas.openxmlformats.org/drawingml/2006/chart',
              'a': 'http://schemas.openxmlformats.org/drawingml/2006/main'}
        parts = sorted(n for n in archive.namelist()
                       if re.match(r'ppt/charts/chart\d+\.xml$', n))
        sizes = [set(etree.fromstring(archive.read(n)).xpath(
            '//c:catAx/c:txPr//a:defRPr/@sz | '
            '//c:dLbls/c:txPr//a:defRPr/@sz', namespaces=ns))
            for n in parts]
    check('chart text auto: native chart sizes follow each chosen step',
          sizes == [{'2200'}, {'1650'}, {'1650'}, {'1650'},
                    {'2200'}], str(sizes))


def test_doughnut_typography_2_5(out_dir):
    """P10: slide ring count selects fixed fonts; small labels never shrink."""
    from deckkit.html2pptx.values import length
    def ring(values=(55, 30, 15)):
        return {'chart_type': 'doughnut', 'chart_title': 'Операции',
                'center': '100 тыс', 'data': {
                    'categories': list('ABCDEFGH')[:len(values)],
                    'series': [{'name': 'Операции', 'values': list(values)}]}}

    small = (40, 25, 15, 10, 5, 4, 1, 0)
    spec = {'slides': [
        {'layout': 'title', 'text': 'Doughnut typography'},
        dict(ring(), layout='chart', title='Одно кольцо',
             points=[{'text': 'Распределение', 'icon': 'структура'}]),
        {'layout': 'chart-two', 'title': 'Два кольца',
         'charts': [ring(), ring()]},
        {'layout': 'chart-two', 'title': 'Малые доли',
         'charts': [ring(small), ring(small)]},
        {'layout': 'chart-two', 'title': 'Кольцо и плотный график',
         'charts': [ring(small), {'chart_type': 'bar', 'chart_title': 'Динамика',
             'number_format': '#,##0', 'data': {
                 'categories': list('ABCDEFGHIJ'), 'series': [
                     {'name': 'Операции', 'values': [12345, 13900, 14500, 16780,
                         17920, 18320, 19400, 20530, 21320, 22210]}]}}]},
        {'layout': 'final'}]}
    result = SP.deck_from_spec(spec, skill_dir=SKILL).build(
        os.path.join(out_dir, 'doughnut-typography'), strict=True, keep_html=True)
    doc = Document.open(result.html_path, extra_dirs=[SKILL])
    roots = doc.boxes()
    actual, hidden = [], []
    for index, root in enumerate(roots, 1):
        for box in root.walk():
            if box.kind != 'chart' or box.chart.chart_type != 'doughnut':
                continue
            chart = box.chart
            actual.append((index,
                round(chart.palette.type['doughnut_percent']['size'] * .75, 6),
                chart.palette.type['doughnut_percent']['weight'],
                round(chart.palette.type['doughnut_center']['size'] * .75, 6)))
            if index in (4, 5):
                hidden.append((index, [l.index[1] for l in chart.geometry.labels],
                               len(chart.geometry.sectors)))
            check('doughnut P10: no ring shrink on slide %d' % index,
                  not chart.geometry.dense)
    check('doughnut P10: ring count, not total chart count, selects typography',
          actual == [(2, 40, 700, 54), (3, 28, 500, 44), (3, 28, 500, 44),
                     (4, 28, 500, 44), (4, 28, 500, 44), (5, 40, 700, 54)],
          str(actual))
    check('doughnut P10: small/zero labels hidden, all sectors retained',
          len(hidden) == 3 and all(6 not in indices and 7 not in indices
                                  and sectors == 8 for _, indices, sectors in hidden),
          str(hidden))
    check('doughnut P10: legend stays 22 pt beside a dense bar',
          all(abs(length(box.style.get('font-size')) * .75 - 22) < .01
              for root in roots[1:5] for box in root.walk()
              if 'legend-label' in box.classes()),
          str([box.style.get('font-size') for box in roots[4].walk()
               if 'legend-label' in box.classes()]))
    check('doughnut P10: omissions warn without errors or zero warnings',
          any(i.code == 'CHART_LABELS' and 'percentage is hidden' in i.message
              for i in result.warnings)
          and not result.errors
          and not any('(0%)' in i.message for i in result.issues))
    with zipfile.ZipFile(result.pptx_path) as archive:
        ns = {'c': 'http://schemas.openxmlformats.org/drawingml/2006/chart',
              'a': 'http://schemas.openxmlformats.org/drawingml/2006/main'}
        native = []
        for name in sorted(archive.namelist()):
            if not re.match(r'ppt/charts/chart\d+\.xml$', name):
                continue
            root = etree.fromstring(archive.read(name))
            if not root.xpath('//c:doughnutChart', namespaces=ns):
                continue
            native.append((
                root.xpath('//c:ser/c:dLbls/c:txPr//a:defRPr/@sz', namespaces=ns),
                root.xpath('//c:title//a:defRPr/@sz', namespaces=ns),
                root.xpath('//c:ser/c:dLbls/c:txPr//a:latin/@typeface', namespaces=ns),
                root.xpath('//c:ser/c:dLbls/c:txPr//a:defRPr/@b', namespaces=ns)))
            check('doughnut P10: linked center and native percent without position',
                  root.xpath('//c:title/c:tx/c:strRef/c:f/text()', namespaces=ns)
                  == ['Sheet1!$D$2']
                  and not root.xpath('//c:dLblPos', namespaces=ns)
                  and root.xpath('//c:ser/c:dLbls/c:showPercent/@val', namespaces=ns)
                  == ['1'])
    check('doughnut P10: writer follows shared per-slide fonts',
          native == [(['4000'], ['5400'], ['T-Sans'], ['1']),
                     (['2800'], ['4400'], ['T-Sans Medium'], ['0']),
                     (['2800'], ['4400'], ['T-Sans Medium'], ['0']),
                     (['2800'], ['4400'], ['T-Sans Medium'], ['0']),
                     (['2800'], ['4400'], ['T-Sans Medium'], ['0']),
                     (['4000'], ['5400'], ['T-Sans'], ['1'])], str(native))


def test_line_chart_2_3(out_dir):
    """2.3.0, the designers' review of line charts.

    A 4 pt line; labels on every point or none ("max"/"last" withdrawn), on
    at most 2 lines of at most 8 points; of two lines the higher point of a
    category is labelled above, the lower below, and no drop lines cross
    them; "fill" is switched off by features.line_fill.
    """
    from deckkit.html2pptx.render import Renderer
    from deckkit.html2pptx.textmeasure import FontBook

    ns = {'c': 'http://schemas.openxmlformats.org/drawingml/2006/chart',
          'a': 'http://schemas.openxmlformats.org/drawingml/2006/main'}

    def box(series, **options):
        data = CD.from_inline({
            'categories': ['2023', '2024', '2025'][:len(series[0][1])],
            'series': [{'name': n, 'values': v} for n, v in series]})
        return G.ChartBox('line', data, **options)

    def xml(name, chart):
        renderer = Renderer(None, FontBook(SKILL))
        renderer.render_slide(_chart_root(chart), 1)
        path = os.path.join(out_dir, 'line23-%s.pptx' % name)
        renderer.save(path)
        with zipfile.ZipFile(path) as archive:
            part = next(n for n in archive.namelist()
                        if n.startswith('ppt/charts/') and n.endswith('.xml'))
            root = etree.fromstring(archive.read(part))
        return lambda path: root.xpath(path, namespaces=ns)

    # 4 pt = 50800 EMU, set outright rather than grid x 3 (2.8 pt).
    q = xml('plain', box([('A', [1, 3, 2]), ('B', [2, 1, 3])]))
    check('2.3.0: a series line is 4 pt',
          q('//c:lineChart/c:ser/c:spPr/a:ln/@w') == ['50800', '50800'],
          str(q('//c:lineChart/c:ser/c:spPr/a:ln/@w')))
    check('2.3.0: the preview draws the same width',
          abs(G.load_palette().line_px - 16 / 3.0) < 1e-6,
          str(G.load_palette().line_px))

    # Two lines: A is lower at 2023 and 2025, B at 2024.
    two = box([('A', [1, 5, 2]), ('B', [4, 2, 3])], value_labels=True)
    q = xml('two', two)
    anchors = dict((l.index, l.anchor) for l in two.geometry.labels
                   if l.index is not None)
    check('2.3.0: the lower point of a category is labelled below',
          anchors == {(0, 0): 'ct', (0, 1): 'cb', (0, 2): 'ct',
                      (1, 0): 'cb', (1, 1): 'ct', (1, 2): 'cb'},
          str(anchors))
    # Halos first: the real series are c:ser 3 and 4.
    a_pos = (q('//c:lineChart/c:ser[3]/c:dLbls/c:dLblPos/@val'),
             q('//c:lineChart/c:ser[3]/c:dLbls/c:dLbl/c:idx/@val'),
             q('//c:lineChart/c:ser[3]/c:dLbls/c:dLbl/c:dLblPos/@val'))
    b_pos = (q('//c:lineChart/c:ser[4]/c:dLbls/c:dLblPos/@val'),
             q('//c:lineChart/c:ser[4]/c:dLbls/c:dLbl/c:idx/@val'),
             q('//c:lineChart/c:ser[4]/c:dLbls/c:dLbl/c:dLblPos/@val'))
    check('2.3.0: the file puts each label on the side the layout chose',
          a_pos == (['b'], ['1'], ['t']) and b_pos == (['t'], ['1'], ['b']),
          '%s %s' % (a_pos, b_pos))
    check('2.3.0: two labelled lines - no drop lines, no value axis',
          q('//c:dropLines') == []
          and q('//c:valAx/c:delete[not(@val) or @val="1"]') != [],
          str(q('//c:dropLines')))
    one = box([('A', [1, 5, 2])], value_labels=True)
    q = xml('one', one)
    check('2.3.0: one labelled line keeps its drop lines, labels above',
          q('//c:dropLines') != [] and q('//c:dLblPos/@val') == ['t'],
          str(q('//c:dLblPos/@val')))
    # A point at the bottom of the scale: its label stays off the names.
    low = box([('A', [0, 5, 2]), ('B', [4, 6, 3])], value_labels=True)
    xml('low', low)
    size = G.load_palette().type['data_label']['size']
    hanging = max(l.y + size for l in low.geometry.labels
                  if l.index is not None and l.anchor == 'ct')
    names = min(l.y for l in low.geometry.labels
                if l.index is None and l.anchor == 'ct')
    check('2.3.0: a label under the lowest point clears the category names',
          hanging <= names, '%.1f > %.1f' % (hanging, names))

    def refused(fields, categories=('Q1', 'Q2'), series=2):
        slide = {'layout': 'chart', 'title': 'T', 'chart_type': 'line',
                 'data': {'categories': list(categories), 'series': [
                     {'name': 'S%d' % i, 'values': [i + 1] * len(categories)}
                     for i in range(series)]},
                 'points': [{'text': 'x', 'icon': 'рост'}]}
        slide.update(fields)
        try:
            SP.deck_from_spec({'slides': [{'layout': 'title', 'text': 'x'},
                                          slide, {'layout': 'final'}]},
                              skill_dir=SKILL)
        except SP.SpecError as exc:
            return ' '.join(exc.problems)
        return ''
    eight = ['Q%d' % i for i in range(1, 9)]
    for name, message, words in (
            ('"max"', refused({'value_labels': 'max'}), 'withdrawn in 2.3.0'),
            ('"last"', refused({'value_labels': 'last'}), 'withdrawn in 2.3.0'),
            ('labels on 3 lines', refused({'value_labels': True}, series=3),
             'at most 2 lines'),
            ('labels on 9 points', refused({'value_labels': True},
                                           eight + ['Q9']), 'at most 8 points'),
            ('fill', refused({'fill': True}), 'switched off')):
        check('2.3.0 spec refuses %s' % name, words in message,
              message or 'accepted')
    check('2.3.0 spec: labels on 2 lines of 8 points are fine',
          refused({'value_labels': True}, eight) == '',
          refused({'value_labels': True}, eight))
    check('2.3.0 spec: 3 lines without labels are fine',
          refused({}, series=3) == '', refused({}, series=3))


def test_chart_title_fit(out_dir):
    """The chart title rides its ladder inside the fit-box the design gives
    it - three lines on the single chart (slides 67-69): the designers' own
    three-line placeholder stays at 72px, a longer title steps down, and one
    that fits at no step is a build OVERFLOW, never a silent spill.
    """
    from deckkit.build import BuildError

    def build(name, title):
        spec = {'slides': [
            {'layout': 'chart', 'title': title,
             'data': {'categories': ['A', 'B'],
                      'series': [{'name': 's', 'values': [1, 2]}]},
             'chart_type': 'line',
             'points': [{'text': 'Пункт', 'icon': 'рост'}]}]}
        deck = SP.deck_from_spec(spec, skill_dir=SKILL)
        return deck.build(os.path.join(out_dir, name), strict=True, pptx=False)

    placeholder = build('chart-title-3', 'Заголовок слайда вашей презентации')
    check('chart title: the three-line design placeholder stays at 72px',
          placeholder.sizes[0].headline == 72, repr(placeholder.sizes[0]))
    # "Горизонтальные" does not fit 554px at 72px: the ladder has to step.
    stepped = build('chart-title-word', 'Горизонтальные столбцы')
    check('chart title: a word too wide at 72px steps down the ladder',
          stepped.sizes[0].headline < 72, repr(stepped.sizes[0]))
    try:
        build('chart-title-long', 'Очень длинный заголовок ' * 40)
        codes = []
    except BuildError as exc:
        codes = [i.code for i in exc.issues]
    check('chart title: one that fits at no step is an OVERFLOW error',
          'OVERFLOW' in codes, '%s' % codes)


def test_chart_groups(out_dir):
    """A point of the single chart and the note beside the chart-two title
    are one object each in PowerPoint - icon and text move together - and
    the single chart takes up to five points.
    """
    from pptx import Presentation

    one = {'categories': ['A', 'B'], 'series': [{'name': 's', 'values': [1, 2]}]}
    icons = ['рост', 'цель', 'щит', 'команда', 'флаг']
    spec = {'slides': [
        {'layout': 'chart', 'title': 'Пять пунктов', 'chart_type': 'bar',
         'data': one, 'points': [{'text': 'Пункт %d' % n, 'icon': icon}
                                 for n, icon in enumerate(icons, 1)]},
        {'layout': 'chart-two', 'title': 'Два графика',
         'note_icon': 'внимание',
         'note': 'Заметка к двум графикам: оба ряда растут, но второй '
                 'догоняет его к концу года',
         'charts': [{'chart_type': 'bar', 'chart_title': 'Выручка',
                     'data': one},
                    {'chart_type': 'line', 'chart_title': 'Клиенты',
                     'data': one}]}]}
    deck = SP.deck_from_spec(spec, skill_dir=SKILL)
    result = deck.build(os.path.join(out_dir, 'chart-groups'), strict=True)
    slides = list(Presentation(result.pptx_path).slides)

    def pairs(slide):
        return [len(s.shapes) for s in slide.shapes
                if getattr(s, 'shapes', None) is not None]

    check('chart: five points are five icon+text groups',
          pairs(slides[0]) == [2] * 5, 'groups: %s' % pairs(slides[0]))
    check('chart-two: the note and its icon are one group',
          pairs(slides[1]) == [2], 'groups: %s' % pairs(slides[1]))


def test_card_value_options():
    """Values replace heads across ordinary and numbered card schemas."""
    variants = [('cards', 1, False), ('cards', 2, True),
                ('grid', 4, False), ('grid', 4, True),
                ('complex', 5, False), ('pyramid', 5, False)]
    for layout, count, numbered in variants:
        def spec(card):
            others = [{'title': 'Команда', 'text': 'Рост команды'}
                      for _ in range(count - 1)]
            if not numbered:
                for other in others:
                    other['icon'] = 'команда'
            slide = {'layout': layout, 'title': 'Итоги',
                     'cards': [dict(card)] + others}
            if numbered:
                slide['numbered'] = True
            return {'slides': [slide]}

        good = {'value': '62%', 'text': 'Доля клиентов',
                'items': ['Рост за квартал']}
        if not numbered:
            good['icon'] = 'рост'
        deck = SP.deck_from_spec(spec(good), skill_dir=SKILL)
        check('card value: %s numbered=%s survives normalisation'
              % (layout, numbered),
              deck.slides[0].data['cards'][0].value == '62%'
              and not deck.slides[0].data['cards'][0].title)
        bad = [({'title': 'Рост'}, 'exactly one'),
               ({'value': ''}, 'exactly one'),
               ({'value': 62}, 'must be a string'),
               ({'value': '\\(x\\)'}, 'formula')]
        for changes, message in bad:
            card = dict(good)
            card.update(changes)
            try:
                SP.deck_from_spec(spec(card), skill_dir=SKILL)
                caught = ''
            except SpecError as exc:
                caught = str(exc)
            check('card value: %s rejects %r' % (layout, changes),
                  message in caught, caught)
        card = dict(good)
        if numbered:
            card['icon'] = 'рост'
        else:
            card.pop('icon')
        try:
            SP.deck_from_spec(spec(card), skill_dir=SKILL)
            caught = ''
        except SpecError as exc:
            caught = str(exc)
        check('card value: %s keeps icon contract numbered=%s'
              % (layout, numbered), 'icon' in caught, caught)

    # Literal blank heads must fail before allocating icons, including a
    # blank explicit field alongside an otherwise valid alternative head.
    for head in ('title', 'value'):
        other = 'value' if head == 'title' else 'title'
        for blank in ('', '   ', '\t\n'):
            for companion in ({}, {other: 'Рост'}):
                card = dict(companion, icon='рост', **{head: blank})
                for route in ('spec', 'api'):
                    try:
                        if route == 'spec':
                            SP.deck_from_spec({'slides': [{'layout': 'cards',
                                'title': 'Итоги', 'cards': [card]}]}, skill_dir=SKILL)
                        else:
                            Deck(skill_dir=SKILL).cards('Итоги', [card])
                        caught = ''
                    except (SpecError, ValueError) as exc:
                        caught = str(exc)
                    check('card value: %s rejects explicit blank %s=%r with %r' %
                          (route, head, blank, companion),
                          '"%s" field must be a non-empty string' % head in caught,
                          caught)
    for card in (Card('   ', icon='рост'), Card(value='   ', icon='рост'),
                 ('   ', 'Описание', 'рост'),
                 ('', 'Описание', 'рост', None, '   ')):
        _raises('card value: object/tuple rejects whitespace head %r' % (card,),
                ValueError, 'non-empty string',
                lambda: Deck(skill_dir=SKILL).cards('Итоги', [card]))

    old = Card('Рост', 'Описание', 'рост', ['Первый пункт'])
    new = Card(value='62%', text='Доля клиентов', icon='команда')
    deck = Deck(skill_dir=SKILL).cards('Итоги', [old, new])
    check('card value: positional Card API and keyword value coexist',
          old.title == 'Рост' and old.value is None
          and old.items == ['Первый пункт'] and new.value == '62%'
          and len(deck.slides[0].data['cards']) == 2)
    for card in (Card('Рост', value='62%', icon='рост'),
                 {'value': 62, 'icon': 'рост'}, {'icon': 'рост'}):
        try:
            Deck(skill_dir=SKILL).cards('Итоги', [card])
            caught = ''
        except ValueError as exc:
            caught = str(exc)
        check('card value: API rejects conflicting, typed or missing head',
              bool(caught), caught)


def test_card_api_matches_spec():
    """P22.03: a card slide is refused or accepted alike through the spec,
    `Deck.add` and the helpers. Before, the card and chart layouts skipped
    the shared schema on the API path: a card without an icon, an unknown
    card field, a non-bool or off-count "numbered" and an icon on a
    numbered card all built through `Deck.cards`/`Deck.add`."""
    chart = {'categories': ['A', 'B'],
             'series': [{'name': 'Клиенты', 'values': [1, 2]}]}

    def cards(count, **extra):
        return [dict({'title': 'Этап %d' % n, 'text': 'Описание',
                      'icon': ICONS4[n % 4]}, **extra)
                for n in range(count)]

    def plain(count, **extra):
        return [dict({'title': 'Этап %d' % n, 'text': 'Описание'}, **extra)
                for n in range(count)]

    # (label, layout, data, expected fragment or None for accepted)
    cases = [
        ('cards ok', 'cards', {'title': 'Т', 'cards': cards(2)}, None),
        ('grid ok', 'grid', {'title': 'Т', 'cards': cards(4)}, None),
        ('complex ok', 'complex', {'title': 'Т', 'cards': cards(5)}, None),
        ('pyramid ok', 'pyramid', {'title': 'Т', 'cards': cards(5)}, None),
        ('numbered row ok', 'cards',
         {'title': 'Т', 'numbered': True, 'cards': plain(3)}, None),
        ('numbered grid ok', 'grid',
         {'title': 'Т', 'numbered': True, 'cards': plain(6)}, None),
        ('numbered false ok', 'cards',
         {'title': 'Т', 'numbered': False, 'cards': cards(2)}, None),
        ('metrics ok', 'metrics',
         {'title': 'Т', 'metrics': [{'value': '1', 'text': 'а'},
                                    {'value': '2', 'text': 'б'}]}, None),
        ('chart ok', 'chart',
         {'title': 'Т', 'data': chart, 'chart_type': 'bar',
          'points': [{'text': 'Вывод', 'icon': 'рост'}]}, None),
        ('card without icon', 'cards',
         {'title': 'Т', 'cards': plain(2)}, 'the "icon" field is required'),
        ('grid card without icon', 'grid',
         {'title': 'Т', 'cards': plain(4)}, 'the "icon" field is required'),
        ('complex card without icon', 'complex',
         {'title': 'Т', 'cards': plain(5)}, 'the "icon" field is required'),
        ('pyramid card without icon', 'pyramid',
         {'title': 'Т', 'cards': plain(5)}, 'the "icon" field is required'),
        ('unknown card field', 'cards',
         {'title': 'Т', 'cards': cards(2, colour='red')},
         'unknown field "colour"'),
        ('non-string card text', 'cards',
         {'title': 'Т', 'cards': cards(2, text=5)},
         'the "text" field must be a string'),
        ('numbered string', 'cards',
         {'title': 'Т', 'numbered': 'yes', 'cards': plain(2)},
         '"numbered" is true or false'),
        ('numbered int', 'grid',
         {'title': 'Т', 'numbered': 1, 'cards': plain(4)},
         '"numbered" is true or false'),
        ('numbered one card', 'cards',
         {'title': 'Т', 'numbered': True, 'cards': plain(1)},
         'a numbered row takes 2 to 4 cards'),
        ('numbered with icon', 'cards',
         {'title': 'Т', 'numbered': True, 'cards': cards(2)},
         'a numbered card carries its number'),
        ('numbered grid with icon', 'grid',
         {'title': 'Т', 'numbered': True, 'cards': cards(4)},
         'a numbered card carries its number'),
        ('numbered complex', 'complex',
         {'title': 'Т', 'numbered': True, 'cards': plain(5)},
         'unknown field "numbered"'),
        ('unknown slide field', 'cards',
         {'title': 'Т', 'cards': cards(2), 'colour': 'red'},
         'unknown field "colour"'),
        ('unknown metric field', 'metrics',
         {'title': 'Т', 'metrics': [{'value': '1', 'unit': '%'},
                                    {'value': '2'}]},
         'unknown field "unit"'),
        ('chart point without icon', 'chart',
         {'title': 'Т', 'data': chart, 'chart_type': 'bar',
          'points': [{'text': 'Вывод'}]}, 'the "icon" field is required'),
    ]
    for label, layout, data, wanted in cases:
        outcomes = {}
        try:
            SP.deck_from_spec({'slides': [dict(data, layout=layout)]},
                              skill_dir=SKILL)
            outcomes['spec'] = ''
        except SpecError as exc:
            outcomes['spec'] = str(exc)
        try:
            Deck(skill_dir=SKILL).add(layout, json.loads(json.dumps(data)))
            outcomes['add'] = ''
        except ValueError as exc:
            outcomes['add'] = str(exc)
        if layout in ('cards', 'grid'):
            helper = getattr(Deck(skill_dir=SKILL), layout)
            extra = {k: v for k, v in data.items() if k not in ('title', 'cards')}
            try:
                if extra:
                    Deck(skill_dir=SKILL).add(layout, dict(data))
                else:
                    helper(data['title'], data['cards'])
                outcomes['helper'] = ''
            except ValueError as exc:
                outcomes['helper'] = str(exc)
        for route, error in sorted(outcomes.items()):
            if wanted is None:
                check('card API: %s accepted via %s' % (label, route),
                      error == '', error)
            else:
                check('card API: %s refused via %s' % (label, route),
                      wanted in error, error or 'accepted')

    # Card objects and tuples keep working and are held to the same rules.
    def built(call):
        try:
            return call(), ''
        except Exception as exc:                # noqa: BLE001
            return None, '%s: %s' % (type(exc).__name__, exc)

    deck, error = built(lambda: Deck(skill_dir=SKILL).cards('Т', [
        Card('Раз', 'Текст', 'рост'),
        ('Два', 'Текст', 'цель', iter(['Пункт']))]))
    made = deck.slides[0].data['cards'] if deck else []
    check('card API: Card and tuple conveniences still build',
          len(made) == 2 and all(isinstance(c, Card) for c in made)
          and made[1].items == ['Пункт'] and made[0].icon.endswith('.png'),
          error or repr(made))
    deck, error = built(lambda: Deck(skill_dir=SKILL).metrics(
        'Т', None, [Metric('1', 'а'), ('2', 'б')]))
    check('card API: Metric and tuple conveniences still build',
          deck is not None
          and [m.value for m in deck.slides[0].data['metrics']] == ['1', '2'],
          error)
    deck, error = built(lambda: Deck(skill_dir=SKILL).add('cards', {
        'title': 'Т', 'numbered': True,
        'cards': [Card('Раз', 'Текст'), ('Два', 'Текст')]}))
    check('card API: icon-free Card/tuple on a numbered row builds',
          deck is not None and deck.slides[0].data['numbered'] is True, error)
    for label, items, wanted in (
            ('Card without icon', [Card('Раз', 'Текст'), Card('Два', 'Текст')],
             'the "icon" field is required'),
            ('tuple without icon', [('Раз', 'Текст'), ('Два', 'Текст')],
             'the "icon" field is required'),
            ('Card on a numbered row with icon',
             [Card('Раз', 'Текст', 'рост'), Card('Два', 'Текст')],
             'a numbered card carries its number')):
        numbered = 'numbered' in label
        _raises('card API: %s refused' % label, ValueError, wanted,
                lambda: Deck(skill_dir=SKILL).add('cards', dict(
                    {'title': 'Т', 'cards': items},
                    **({'numbered': True} if numbered else {}))))
    _raises('card API: Metric with a non-string value refused', ValueError,
            'the "value" field must be a string',
            lambda: Deck(skill_dir=SKILL).metrics('Т', None,
                                                  [Metric(1, 'а'), Metric('2')]))

    # The checks come before any icon is looked up: an unknown query on an
    # otherwise refused slide reports the schema problem, not IconNotFound.
    deck = Deck(skill_dir=SKILL)
    allocated = []
    original = deck.allocator.allocate
    deck.allocator.allocate = lambda q: allocated.append(q) or original(q)
    _raises('card API: refused before icon allocation', ValueError,
            'unknown field "colour"',
            lambda: deck.add('cards', {'title': 'Т', 'cards': [
                {'title': 'Раз', 'icon': 'missing-icon-query-zz',
                 'colour': 'red'}, {'title': 'Два', 'icon': 'рост'}]}))
    check('card API: no icon was looked up for a refused slide',
          allocated == [] and len(deck.slides) == 0, str(allocated))


def test_card_value_focus_limit():
    """Zero/one value is legal; two or more must fail on both entry paths."""
    variants = [('cards', n, False) for n in (1, 2, 3, 4)]
    variants += [('grid', n, False) for n in (4, 6, 8)]
    variants += [('complex', 5, False), ('pyramid', 5, False)]
    variants += [('cards', n, True) for n in (2, 3, 4)]
    variants += [('grid', n, True) for n in (4, 6, 8)]
    variants += [('chart-cards', 3, False)]
    chart = {'categories': ['A', 'B'],
             'series': [{'name': 'Клиенты', 'values': [1, 2]}]}
    for layout, count, numbered in variants:
        for number in range(count + 1):
            cards = []
            for index in range(count):
                card = {'value': '62%'} if index < number else {'title': 'Рост'}
                card['text'] = 'Клиентская база'
                if layout != 'chart-cards' and not numbered:
                    card['icon'] = 'рост'
                cards.append(card)
            slide = {'layout': layout, 'title': 'Итоги', 'cards': cards}
            if numbered:
                slide['numbered'] = True
            if layout == 'chart-cards':
                slide.update(data=chart, chart_type='line')
            for api in (False, True):
                try:
                    if api:
                        Deck(skill_dir=SKILL).add(layout, {
                            k: v for k, v in slide.items() if k != 'layout'})
                    else:
                        SP.deck_from_spec({'slides': [slide]}, skill_dir=SKILL)
                    error = ''
                except (SpecError, ValueError) as exc:
                    error = str(exc)
                label = 'card focus: %s/%d numbered=%s values=%d API=%s' % (
                    layout, count, numbered, number, api)
                check(label, bool(error) == (number > 1), error)
                if number > 1:
                    check(label + ' names focus limit and remedy',
                          'at most one card per slide' in error
                          and '"title" for the others' in error, error)

    # Check all supported Card representations, and that the cross-card rule
    # runs before icon lookup can mask it with an unrelated missing-icon error.
    for cards in ([Card(value='62%', icon='missing-icon-query-zz'),
                   Card(value='24', icon='рост')],
                  [('', '', 'missing-icon-query-zz', None, '62%'),
                   ('', '', 'рост', None, '24')]):
        try:
            Deck(skill_dir=SKILL).cards('Итоги', cards)
            error = ''
        except ValueError as exc:
            error = str(exc)
        check('card focus: Card/tuple API refuses before resolving icons',
              'at most one card per slide' in error, error)

    # The limit is per slide, not per deck; the last card may hold the value.
    deck = Deck(skill_dir=SKILL)
    for _ in range(2):
        deck.cards('Итоги', [{'title': 'Рост', 'icon': 'рост'},
                            {'value': '62%', 'icon': 'команда'}])
    check('card focus: one last-position value on each slide is legal',
          len(deck.slides) == 2
          and all(s.data['cards'][-1].value == '62%' for s in deck.slides))
    deck = Deck(skill_dir=SKILL).cards('Итоги', [
        ('Рост', '', 'рост', iter(['Первый пункт', 'Второй пункт']))])
    check('card focus: tuple head check preserves an items iterator',
          deck.slides[0].data['cards'][0].items
          == ['Первый пункт', 'Второй пункт'])


def test_card_value_output(out_dir):
    """Literal ceiling expectations, shared fit and native editable figures."""
    cases = [('cards', 1, False, 96), ('cards', 2, False, 96),
             ('cards', 3, False, 88), ('cards', 4, False, 88),
             ('grid', 4, False, 88), ('grid', 6, False, 80),
             ('grid', 8, False, 72), ('complex', 5, False, 88),
             ('pyramid', 5, False, 88), ('cards', 3, True, 88),
             ('grid', 6, True, 80)]
    for layout, count, numbered, expected in cases:
        cards = [{'value': '62%', 'text': 'Доля клиентов'}]
        cards += [{'title': 'Команда', 'text': 'Рост команды'}
                  for _ in range(count - 1)]
        if not numbered:
            for card in cards:
                card['icon'] = 'рост'
        slide = {'layout': layout, 'title': 'Итоги', 'cards': cards}
        if numbered:
            slide['numbered'] = True
        deck = SP.deck_from_spec({'slides': [slide]}, skill_dir=SKILL)
        built = deck.build(os.path.join(out_dir, 'value-%s-%d-%s'
                           % (layout, count, numbered)),
                           strict=True, pptx=False, keep_html=True)
        root = Document.open(built.html_path, extra_dirs=[SKILL]).box(1)
        figures = [b for b in root.walk()
                   if 'chart-card-value' in b.classes()]
        check('card value: %s/%d numbered=%s literal ceiling %d'
              % (layout, count, numbered, expected),
              len(figures) == 1
              and all(b.style.get('font-size') == '%dpx' % expected
                      for b in figures),
              repr(built.sizes))
        check('card value: %s/%d valid fit' % (layout, count),
              built.sizes[0].fits
              and not any(i.level == 'error' for i in built.issues),
              repr(built.issues))

    spec = {'slides': [{'layout': 'grid', 'title': 'Итоги', 'cards': [
        {'value': '62%', 'items': ['Доля клиентов', 'Рост за квартал'],
         'icon': 'рост'},
        {'title': 'Команда', 'text': 'Развитие продукта', 'icon': 'команда'},
        {'title': 'Продукты', 'text': 'Новых продукта', 'icon': 'документ'},
        {'title': 'Качество', 'text': 'Стабильный сервис', 'icon': 'качество'}]}]}
    deck = SP.deck_from_spec(spec, skill_dir=SKILL)
    built = deck.build(os.path.join(out_dir, 'value-native'), strict=True,
                       keep_html=True)
    with zipfile.ZipFile(built.pptx_path) as z:
        xml = etree.fromstring(z.read('ppt/slides/slide1.xml'))
    ns = {'a': 'http://schemas.openxmlformats.org/drawingml/2006/main',
          'p': 'http://schemas.openxmlformats.org/presentationml/2006/main'}
    values = []
    for shape in xml.findall('.//p:sp', ns):
        text = ''.join(shape.xpath('.//a:t/text()', namespaces=ns))
        if text == '62%':
            values.append(shape)
    # Two bullet rows in a half-height card bring the shared title to 32px,
    # so the focus figure is 64px = 48pt, with adjacent titles at 32px.
    check('card value: one editable native focus figure at 48pt Medium',
          len(values) == 1
          and built.sizes[0].pair == (32, 20)
          and all(s.xpath('.//a:rPr/@sz', namespaces=ns) == ['4800']
                  and s.xpath('.//a:latin/@typeface', namespaces=ns)
                  == ['T-Sans Medium'] for s in values), repr(values))
    check('card value: lists still contain triangle markers',
          'class="bullet"' in read_text(built.html_path))

    # A literal unbreakable value forces the 8-card figure from 72 to 64px;
    # a longer one must be refused at that floor, never silently shrink more.
    for value, size, fits in [('12 345 678 ₽', 64, True),
                              ('111111111111111111111111', 64, False)]:
        slide = {'layout': 'grid', 'title': 'Итоги', 'cards': [
            {'value': value, 'text': 'Рост', 'icon': 'рост'},
            {'title': 'Команда', 'text': 'Развитие', 'icon': 'команда'}]
            + [{'title': 'Качество', 'text': 'Доля', 'icon': 'рост'}
               for _ in range(6)]}
        built = SP.deck_from_spec({'slides': [slide]}, skill_dir=SKILL).build(
            os.path.join(out_dir, 'value-width-%d' % len(value)),
            strict=False, pptx=False, keep_html=True)
        root = Document.open(built.html_path, extra_dirs=[SKILL]).box(1)
        figures = [b for b in root.walk() if 'chart-card-value' in b.classes()]
        check('card value: shared width search for %d digits' % len(value),
              all(b.style.get('font-size') == '%dpx' % size for b in figures)
              and built.sizes[0].fits == fits, repr(built.sizes))
        check('card value: floor overflow is actionable',
              (any(i.code == 'OVERFLOW' for i in built.issues)) == (not fits),
              repr(built.issues))


def test_chart_cards_ladder(out_dir):
    """chart-cards ride the card ladder from 40/28 down, and the figure of a
    value card follows the title step at twice its size - short commentary
    grows, a long one steps all three cards down together.
    """
    line = {'categories': ['A', 'B'], 'series': [{'name': 's', 'values': [1, 2]}]}
    long_text = ('Значимость этих проблем настолько очевидна, что начало '
                 'повседневной работы по формированию позиции требует от нас '
                 'анализа систем массового участия и новых предложений')

    def build(name, third):
        # A two-line title on purpose: its fit-box used to be measured as a
        # card and dropped every chart-cards slide to the floor.
        spec = {'slides': [{'layout': 'chart-cards',
                            'title': 'Заголовок слайда вашей презентации',
                            'chart_type': 'line', 'data': line, 'cards': [
                                {'title': 'Выручка', 'text': 'Рост за полугодие'},
                                {'title': 'Прогноз', 'text': 'Динамика сохраняется'},
                                third]}]}
        deck = SP.deck_from_spec(spec, skill_dir=SKILL)
        built = deck.build(os.path.join(out_dir, name), strict=True,
                           pptx=False, keep_html=True)
        with open(built.html_path, 'r', encoding='utf-8') as f:
            html = f.read()
        figure = re.findall(r'class="chart-card-value" style="[^"]*font-size: '
                            r'(\d+)px', html)
        return built.sizes[0].pair, [int(f) for f in figure]

    pair, figure = build('chart-cards-short', {'value': '+64%', 'text': 'Драйвер'})
    check('chart-cards: short cards take the ceiling 40/28, figure 80',
          pair == (40, 28) and figure == [80], '%s %s' % (pair, figure))
    pair, figure = build('chart-cards-long', {'value': '1 250 млн ₽',
                                              'text': long_text})
    check('chart-cards: a long value card steps the slide down, figure = 2 x title',
          pair[1] < 28 and figure == [2 * pair[0]], '%s %s' % (pair, figure))


def test_chart_placed_in_layout_pass(out_dir):
    """A chart's geometry is part of the layout, read from `Document.box()`.

    Until 2.1 the layout only decoded the chart's data and each paint adapter
    computed the geometry for itself, so nothing that read box trees - the
    validator, a test - could see where the plot or its labels sat.
    """
    deck = Deck(skill_dir=SKILL)
    deck.chart('Выручка', chart_type='bar', points=[{'text': 'Вывод', 'icon': 'рост'}],
               data={'categories': ['A', 'B', 'C'],
                     'series': [{'name': 's', 'values': [1, 2, 3]}]})
    result = deck.build(os.path.join(out_dir, 'chart-placed'), strict=False,
                        pptx=False, keep_html=True)
    document = Document.open(result.html_path, extra_dirs=[SKILL])
    boxes = [b for b in document.box(1).walk() if b.kind == 'chart']
    check('chart placed: the slide has one chart box', len(boxes) == 1,
          '%d' % len(boxes))
    if not boxes:
        return
    box = boxes[0]
    geometry = box.chart.geometry if box.chart is not None else None
    check('chart placed: geometry is on the box after layout',
          geometry is not None, repr(box.chart))
    if geometry is None:
        return
    frame = geometry.frame
    check('chart placed: the frame is the box',
          (frame.x, frame.y, frame.w, frame.h) == (box.x, box.y, box.w, box.h),
          '%r vs %r' % (frame, box))
    check('chart placed: one bar per value, inside the frame',
          len(geometry.bars) == 3 and all(
              frame.x <= r.x and r.x + r.w <= frame.right + 0.5
              for _, _, r, _ in geometry.bars),
          str(geometry.bars))


def test_deck_chart_api(out_dir):
    """The programmatic Deck.chart() matches the points-only single-chart
    contract — a stale signature (no points) silently breaks this entry point,
    which the spec path never exercises.
    """
    from deckkit.deck import Deck

    deck = Deck(skill_dir=SKILL)
    deck.chart('Выручка', chart_type='line', points=[{'text': 'Вывод', 'icon': 'рост'}],
               data={'categories': ['A', 'B'],
                     'series': [{'name': 's', 'values': [1, 2]}]})
    check('deck.chart(): a single chart slide with one point is added',
          len(deck.slides) == 1, '%d slides' % len(deck.slides))
    result = deck.build(os.path.join(out_dir, 'chart-api'), strict=True)
    check('deck.chart(): builds a file', bool(result.pptx_path))


def test_picture_clipping(out_dir):
    """Pictures retain source bytes and crop while their own geometry clips."""
    import hashlib
    from deckkit.html2pptx.convert import write_pptx
    from deckkit.preview import render_file
    sources = []
    for name, size, color in [('wide', (400, 200), (220, 30, 40, 255)),
                               ('tall', (200, 400), (10, 120, 220, 255)),
                               ('alpha', (200, 200), (200, 20, 40, 128))]:
        path = os.path.join(out_dir, 'clip-%s.png' % name)
        Image.new('RGBA', size, color).save(path)
        sources.append(path)
    # Literal 200px notch, curved rather than a white overlay. Its last
    # quarter is absent, letting the slide background show through.
    notch = 'M 20 0 L 180 0 C 191 0 200 9 200 20 L 200 130 C 200 147 187 160 170 160 C 153 160 140 173 140 190 L 140 200 L 20 200 C 9 200 0 191 0 180 L 0 20 C 0 9 9 0 20 0 Z'
    markup = '<html><head><link rel="stylesheet" href="%s"></head><body><div class="slide" style="background: #FFFFFF;">' % os.path.join(SKILL, 'assets/base.css')
    for i, src in enumerate(sources + sources[:1]):
        clipping = ('clip-path: path(\'%s\');' % notch if i == 2
                    else 'border-radius: 40px;' if i < 2 else '')
        markup += '<img src="%s" style="position: absolute; left: %dpx; top: 100px; width: 200px; height: 200px; object-fit: cover; %s">' % (src, 100+i*250, clipping)
    markup += '</div></body></html>'
    path = os.path.join(out_dir, 'picture-clipping.html')
    with open(path, 'w', encoding='utf-8') as handle:
        handle.write(markup)
    pptx_path = write_pptx(Document.open(path, extra_dirs=[SKILL]),
                           os.path.join(out_dir, 'picture-clipping.pptx'))
    ns = {'a': 'http://schemas.openxmlformats.org/drawingml/2006/main',
          'p': 'http://schemas.openxmlformats.org/presentationml/2006/main'}
    with zipfile.ZipFile(pptx_path) as archive:
        xml = etree.fromstring(archive.read('ppt/slides/slide1.xml'))
        pics = xml.findall('.//p:pic', ns)
        media = [hashlib.sha256(archive.read(n)).hexdigest()
                 for n in archive.namelist() if n.startswith('ppt/media/')]
    check('picture clip: all four pictures stay native', len(pics) == 4)
    check('picture clip: original media bytes retained',
          all(hashlib.sha256(open(p, 'rb').read()).hexdigest() in media
              for p in sources))
    check('picture clip: roundRect has a literal 40px corner',
          all(p.xpath('./p:spPr/a:prstGeom/@prst', namespaces=ns) == ['roundRect']
              and p.xpath('./p:spPr/a:prstGeom/a:avLst/a:gd/@fmla', namespaces=ns)
              == ['val 20000'] for p in pics[:2]))
    check('picture clip: horizontal cover crop is preserved',
          pics[0].xpath('./p:blipFill/a:srcRect/@l | ./p:blipFill/a:srcRect/@r', namespaces=ns)
          == ['25000', '25000'])
    check('picture clip: vertical cover crop is preserved',
          pics[1].xpath('./p:blipFill/a:srcRect/@t | ./p:blipFill/a:srcRect/@b', namespaces=ns)
          == ['25000', '25000'])
    check('picture clip: native notch uses five cubic curves',
          len(pics[2].xpath('./p:spPr/a:custGeom/a:pathLst/a:path/a:cubicBezTo', namespaces=ns)) == 5
          and not pics[2].xpath('./p:spPr/a:prstGeom', namespaces=ns))
    check('picture clip: ordinary picture remains rectangular',
          pics[3].xpath('./p:spPr/a:prstGeom/@prst', namespaces=ns) == ['rect'])
    for scale in (1.0, 0.5):
        png = render_file(path, os.path.join(out_dir, 'clip-preview-%s' % scale),
                          SKILL, scale=scale)[0]
        im = Image.open(png).convert('RGB')
        pixel = lambda x, y: im.getpixel((round(x*scale), round(y*scale)))
        check('picture clip: rounded corner clears at scale %s' % scale,
              pixel(102, 102) == (255, 255, 255)
              and pixel(150, 150) == (220, 30, 40))
        check('picture clip: notch clears without replacing source alpha at scale %s' % scale,
              pixel(780, 280) == (255, 255, 255)
              and all(abs(a-b) <= 1 for a, b in zip(pixel(650, 150), (227, 137, 147))))


def test_image_fit(out_dir):
    """Public fit parity, mask-safe whole images, native fill and diagnostics."""
    from types import SimpleNamespace
    from deckkit.html2pptx.assets import (safe_contain_rect, picture_mask_area)
    from deckkit.html2pptx import values as PV
    from deckkit.html2pptx.convert import write_pptx
    from deckkit.preview import render_file
    src = os.path.join(out_dir, 'fit-square.png')
    Image.new('RGBA', (200, 200), (200, 20, 40, 128)).save(src)
    point = {'text': 'Вывод', 'icon': 'shield'}
    items = [{'src': src, 'title': 'Итог', 'text': 'Подпись', 'icon': icon}
             for icon in ('shield', 'rocket', 'users')]

    def route(label, name, data):
        if label == 'spec':
            return SP.deck_from_spec({'slides': [dict(data, layout=name,
                notes='Заметка')]}, skill_dir=SKILL)
        if label == 'add':
            return Deck(skill_dir=SKILL).add(name, data, notes='Заметка')
        if name == 'image-points':
            return Deck(skill_dir=SKILL).image_points(data['title'], data['src'],
                data['points'], look=data.get('look'), notes='Заметка',
                fit=data.get('fit'))
        return Deck(skill_dir=SKILL).image_gallery(data['title'], data['images'],
                                                  notes='Заметка')

    for look in ('plate', 'plates'):
        default = None
        for fit in (None, 'cover', 'contain'):
            data = {'title': 'Итоги', 'src': src, 'points': [point], 'look': look}
            if fit is not None:
                data['fit'] = fit
            markups = []
            for label in ('spec', 'add', 'method'):
                deck = route(label, 'image-points', data)
                slide = deck.slides[0]
                element = S.render(deck.fragments, slide.layout, slide.data,
                                   deck.icons, '')
                markups.append(etree.tostring(element))
                pic = F.first(element, 'media-image')
                check('image fit: %s %s %s opts into safe contain only' %
                      (label, look, fit),
                      (pic.get('data-contain-safe') == 'true') == (fit == 'contain')
                      and ('object-fit: contain' in (pic.get('style') or ''))
                      == (fit == 'contain') and slide.notes == 'Заметка')
            check('image fit: %s %s spec/add/helper markup parity' % (look, fit),
                  markups[0] == markups[1] == markups[2])
            if fit is None:
                default = markups[0]
            elif fit == 'cover':
                check('image fit: %s explicit cover retains default markup' % look,
                      markups[0] == default)
    old = Deck(skill_dir=SKILL).image_points('Итоги', src, [point], 'plate', 'Заметка')
    check('image fit: old positional look and notes stay compatible',
          old.slides[0].notes == 'Заметка' and old.slides[0].layout == 'image-points-plate')

    for count in (2, 3):
        data = {'title': 'Итоги', 'images': items[:count]}
        markups = []
        for label in ('spec', 'add', 'method'):
            deck = route(label, 'image-gallery', data)
            slide = deck.slides[0]
            element = S.render(deck.fragments, slide.layout, slide.data, deck.icons, '')
            markups.append(etree.tostring(element))
            pics = F.by_class(element, 'media-image')
            check('image fit: %s gallery %d always uses template cover' % (label, count),
                  len(pics) == count and all(p.get('data-contain-safe') is None
                      and not p.get('style') for p in pics))
        check('image fit: gallery %d spec/add/helper markup parity' % count,
              markups[0] == markups[1] == markups[2])
    for value in ('stretch', '', 'CONTAIN', True, 12, [], {}):
        data = {'title': 'Итоги', 'src': src, 'points': [point], 'fit': value}
        for label in ('spec', 'add', 'method'):
            try:
                route(label, 'image-points', data)
                message = ''
            except (SpecError, ValueError) as exc:
                message = str(exc)
            check('image fit: %s image-points rejects %r' % (label, value),
                  'fit' in message, message or 'accepted invalid fit')
    # Galleries have no authoring mode, including an explicit redundant cover.
    # Schema refusals must precede media reads: the first source does not exist.
    for count in (2, 3):
        for value in ('cover', 'contain', None, 'stretch', True, 12, [], {}):
            bad_items = [dict(item) for item in items[:count]]
            bad_items[0].update(src=os.path.join(out_dir, 'missing-fit.png'), fit=value)
            for label in ('spec', 'add', 'method'):
                try:
                    route(label, 'image-gallery', {'title': 'Итоги', 'images': bad_items})
                    message = ''
                except (SpecError, ValueError, MediaError) as exc:
                    message = str(exc)
                check('image fit: %s gallery %d refuses item fit %r before media' %
                      (label, count, value), 'unknown field "fit"' in message,
                      message or 'accepted gallery mode')
        for label in ('spec', 'add'):
            for value in ('cover', 'contain', None):
                try:
                    route(label, 'image-gallery', {'title': 'Итоги',
                        'images': items[:count], 'fit': value})
                    message = ''
                except (SpecError, ValueError, MediaError) as exc:
                    message = str(exc)
                check('image fit: %s gallery %d refuses global fit %r' %
                      (label, count, value), 'unknown field "fit"' in message)

    notch = PV.outline('path("M 0 0 L 200 0 L 200 150 L 150 150 L 150 200 L 0 200 Z")')
    rounded = safe_contain_rect(src, 200, 200, radius=40)
    # x = 40*(1-1/sqrt(2)) + 1px numerical clearance, not CSS design padding.
    check('image fit: rounded safe rectangle literal',
          abs(rounded[0]-12.71572875) < .00001 and
          abs(rounded[2]-174.56854249) < .00001 and rounded[0] == rounded[1])
    notched = safe_contain_rect(src, 200, 200, outline=notch)
    # The expanded rectangle must end before the 150px concave boundary.
    check('image fit: concave cutout safe rectangle literal',
          all(abs(a-b) < .00001 for a, b in zip(notched, (51, 51, 98, 98))))
    check('image fit: rectangular contain needs no safety inset',
          safe_contain_rect(src, 400, 200) == (100, 0, 200, 200))
    check('image fit: cutout area literal', picture_mask_area(200, 200, outline=notch) == 37500)

    css = os.path.join(SKILL, 'assets/base.css')
    html = '<html><head><link rel="stylesheet" href="%s"></head><body><div class="slide" style="background: #FFFFFF;">' % css
    for index, mask in enumerate(('border-radius: 40px;',
            'clip-path: path("M 0 0 L 200 0 L 200 150 L 150 150 L 150 200 L 0 200 Z");', '')):
        html += '<img data-contain-safe="true" src="%s" style=\'position: absolute; left: %dpx; top: 100px; width: 200px; height: 200px; object-fit: contain; %s\'>' % (src, 100+index*250, mask)
    html += '</div></body></html>'
    path = os.path.join(out_dir, 'fit-mask.html')
    with open(path, 'w', encoding='utf-8') as stream:
        stream.write(html)
    pptx_path = write_pptx(Document.open(path, extra_dirs=[SKILL]),
                           os.path.join(out_dir, 'fit-mask.pptx'))
    ns = {'a': 'http://schemas.openxmlformats.org/drawingml/2006/main',
          'p': 'http://schemas.openxmlformats.org/presentationml/2006/main'}
    with zipfile.ZipFile(pptx_path) as archive:
        xml = etree.fromstring(archive.read('ppt/slides/slide1.xml'))
        pics = xml.findall('.//p:pic', ns)
        check('image fit: original alpha media retained',
              open(src, 'rb').read() in [archive.read(n) for n in archive.namelist()
                                       if n.startswith('ppt/media/')])
    check('image fit: all three pictures native and uncropped', len(pics) == 3
          and not any(p.xpath('./p:blipFill/a:srcRect/@*', namespaces=ns) for p in pics))
    check('image fit: native target insets literal',
          [p.xpath('./p:blipFill/a:stretch/a:fillRect/@*', namespaces=ns) for p in pics]
          == [['6358']*4, ['25500']*4, []])
    check('image fit: native masks retained',
          pics[0].xpath('./p:spPr/a:prstGeom/@prst', namespaces=ns) == ['roundRect']
          and len(pics[1].xpath('./p:spPr/a:custGeom/a:pathLst/a:path', namespaces=ns)) == 1)
    for scale in (1, .5):
        png = render_file(path, os.path.join(out_dir, 'fit-mask-%s' % scale),
                          SKILL, scale=scale)[0]
        im = Image.open(png).convert('RGB')
        for left, inset, size in ((100, 13, 174), (350, 51, 98), (600, 0, 200)):
            # Four source corners and source alpha survive the clipping mask.
            pixels = [im.getpixel((round((left+x)*scale), round((100+y)*scale)))
                      for x, y in ((inset+8, inset+8), (inset+size-9, inset+8),
                                   (inset+size-9, inset+size-9), (inset+8, inset+size-9))]
            check('image fit: four corners preserve alpha %s/%s' % (scale, left),
                  all(max(abs(a-b) for a, b in zip(pixel, (227, 137, 147))) <= 2
                      for pixel in pixels), repr(pixels))

    wide = os.path.join(out_dir, 'fit-wide.png')
    Image.new('RGB', (400, 200), 'red').save(wide)
    def issue_box(path, fit, width=200, height=200, radius='0px', safe=False):
        el = etree.Element('img', {'data-contain-safe': 'true'} if safe else {})
        return SimpleNamespace(src=path, w=width, h=height, x=0, y=0, el=el,
            style={'object-fit': fit, 'border-radius': radius},
            classes=lambda: ['media-image', 'framed-image'])
    issues = VD._image_issues(issue_box(wide, 'cover'), 4)
    check('image fit: cover reports source edges and cropped area',
          len(issues) == 1 and issues[0].code == 'IMAGE_CROP' and issues[0].slide == 4
          and 'cover removes 50.0% of the source area' in issues[0].message
          and 'rectangular crop 50.0%' in issues[0].message
          and 'left 25.0%' in issues[0].message
          and 'right 25.0%' in issues[0].message, repr(issues))
    gallery_box = issue_box(wide, 'cover')
    gallery_box.classes = lambda: ['media-image', 'gallery-picture']
    issues = VD._image_issues(gallery_box, 4)
    check('image fit: gallery crop advice offers a legal layout change',
          len(issues) == 1 and issues[0].code == 'IMAGE_CROP'
          and 'image-points with fit: contain' in issues[0].message
          and 'Use contain to preserve' not in issues[0].message, repr(issues))
    issues = VD._image_issues(issue_box(wide, 'contain', safe=True), 5)
    check('image fit: letterboxing is distinct from crop and resolution',
          len(issues) == 1 and issues[0].code == 'IMAGE_LETTERBOX'
          and '50.0%' in issues[0].message, repr(issues))
    # A 100x200 source into a 200x200 cover needs 2x scaling, even though the
    # panel height alone equals the source. Report displayed 200x400.
    tall = os.path.join(out_dir, 'fit-low.png')
    Image.new('RGB', (100, 200), 'red').save(tall)
    issues = VD._image_issues(issue_box(tall, 'cover'), 6)
    check('image fit: cover resolution uses uniform displayed scale',
          [i.code for i in issues] == ['LOW_RES_IMAGE', 'IMAGE_CROP']
          and '200x400' in issues[0].message, repr(issues))
    issues = VD._image_issues(issue_box(tall, 'contain', safe=True), 7)
    check('image fit: contain does not falsely report low resolution',
          [i.code for i in issues] == ['IMAGE_LETTERBOX'], repr(issues))


def test_exif_orientation(out_dir):
    """All eight EXIF transforms share upright geometry without changing sources."""
    from types import SimpleNamespace
    from deckkit.html2pptx.assets import AssetResolver, image_size, contain_rect, cover_crop
    from deckkit.validate import _image_issues
    resolver = AssetResolver(out_dir, os.path.join(out_dir, 'exif-cache'))
    colors = [(240, 20, 20), (20, 240, 20), (20, 20, 240), (240, 240, 20)]
    # Clockwise corners TL, TR, BR, BL, with literal expected source indices.
    expected = {1: (0, 1, 2, 3), 2: (1, 0, 3, 2),
                3: (2, 3, 0, 1), 4: (3, 2, 1, 0),
                5: (0, 3, 2, 1), 6: (3, 0, 1, 2),
                7: (2, 1, 0, 3), 8: (1, 2, 3, 0)}
    for orientation, corners in expected.items():
        source = Image.new('RGB', (1000, 500))
        for bounds, color in zip(((0, 0, 500, 250), (500, 0, 1000, 250),
                                  (500, 250, 1000, 500), (0, 250, 500, 500)), colors):
            source.paste(color, bounds)
        exif = source.getexif()
        exif[274] = orientation
        path = os.path.join(out_dir, 'exif-%d.jpg' % orientation)
        source.save(path, quality=100, subsampling=0, exif=exif)
        with open(path, 'rb') as stream:
            original = stream.read()
        resolved = resolver.image(path, 100, 100)
        with Image.open(resolved) as upright:
            width, height = upright.size
            actual = [upright.convert('RGB').getpixel(point) for point in
                      ((10, 10), (width-11, 10), (width-11, height-11), (10, height-11))]
            check('EXIF %d: literal corner ordering' % orientation,
                  all(max(abs(a-b) for a, b in zip(pixel, colors[index])) <= 2
                      for pixel, index in zip(actual, corners)), repr(actual))
            check('EXIF %d: oriented dimensions' % orientation,
                  (width, height) == ((500, 1000) if orientation >= 5 else (1000, 500)))
        with open(path, 'rb') as stream:
            check('EXIF %d: original bytes remain untouched' % orientation,
                  stream.read() == original)
        if orientation == 1:
            check('EXIF upright: resolver preserves original path', resolved == path)
        if orientation == 6:
            check('EXIF portrait: source dimension helper', image_size(path) == (500, 1000))
            check('EXIF portrait: contain uses upright bounds',
                  contain_rect(path, 100, 100) == (25, 0, 50, 100))
            check('EXIF portrait: cover uses upright crop',
                  cover_crop(path, 100, 100) == (0, .25, 0, .25))
            issues = _image_issues(SimpleNamespace(src=path, w=500, h=1000, style={}), 1)
            check('EXIF portrait: matching upright panel has no resolution/aspect warnings',
                  not issues, repr(issues))


def test_image_options(out_dir):
    """Approved image names share strict spec/API rules before resources."""
    from deckkit.validate import _fewer_of
    for layout in ('image-points-plate', 'image-points-plates'):
        check('image options: %s overflow advice names points' % layout,
              _fewer_of(layout) == 'a layout with fewer points')
    # macOS may expose the temporary root through /var -> /private/var;
    # relative paths are resolved from getcwd(), which uses the real path.
    out_dir = os.path.realpath(out_dir)
    src = os.path.join(out_dir, 'image-options.png')
    jpeg = os.path.join(out_dir, 'image-options.jpg')
    gif = os.path.join(out_dir, 'image-options.gif')
    corrupt = os.path.join(out_dir, 'image-options-corrupt.png')
    for path in (src, jpeg, gif):
        Image.new('RGB', (320, 180), (40, 120, 180)).save(path)
    with open(corrupt, 'w', encoding='utf-8') as stream:
        stream.write('not an image')
    missing = os.path.join(out_dir, 'image-options-missing.png')
    point = {'text': 'Вывод', 'icon': 'shield'}
    images = [{'src': src, 'title': 'Запуск', 'text': 'Короткая подпись',
               'icon': icon} for icon in ('shield', 'rocket', 'users')]
    bases = {
        'image-points': {'title': 'Итоги', 'src': src, 'points': [point]},
        'image-gallery': {'title': 'Итоги', 'images': images[:2]},
    }

    check('image options: literal parked set',
          L.DRAFT == frozenset(('image', 'image-wide', 'text-slide')))
    for name, data in [
            ('image', {'title': 'Итоги', 'src': src}),
            ('image-wide', {'title': 'Итоги', 'src': src}),
            ('text-slide', {'title': 'Итоги', 'text': 'Текст'})]:
        try:
            SP.deck_from_spec({'slides': [dict(data, layout=name)]}, skill_dir=SKILL)
            message = ''
        except SpecError as exc:
            message = str(exc)
        check('image options: %s stays outside public spec' % name,
              'unknown layout' in message, message)

    def via_spec(name, data, notes=None):
        return SP.deck_from_spec({'slides': [dict(data, layout=name, notes=notes)]},
                                 skill_dir=SKILL)

    def via_add(name, data, notes=None):
        return Deck(skill_dir=SKILL).add(name, data, notes=notes)

    def via_method(name, data, notes=None):
        deck = Deck(skill_dir=SKILL)
        if name == 'image-points':
            return deck.image_points(data['title'], data['src'], data['points'],
                                     look=data.get('look'), notes=notes)
        return deck.image_gallery(data['title'], data['images'], notes=notes)

    routes = [('spec', via_spec), ('add', via_add), ('method', via_method)]
    for label, route in routes:
        for count in (1, 2, 3, 4, 5):
            for look, expected in [(None, 'image-points-plates'),
                                   ('plates', 'image-points-plates'),
                                   ('plate', 'image-points-plate')]:
                data = dict(bases['image-points'], look=look,
                            points=[dict(point, icon='данные') for _ in range(count)])
                deck = route('image-points', data, notes='Заметка докладчика')
                check('image options: %s selects %d points/%s' % (label, count, look),
                      deck.slides[0].layout == expected
                      and len(deck.slides[0].data['points']) == count
                      and all(item['icon'] for item in deck.slides[0].data['points'])
                      and deck.slides[0].notes == 'Заметка докладчика')
        for count, expected in [(2, 'image-gallery-2'), (3, 'image-gallery-3')]:
            deck = route('image-gallery', dict(bases['image-gallery'], images=images[:count]))
            check('image options: %s selects gallery %d' % (label, count),
                  deck.slides[0].layout == expected
                  and len(deck.slides[0].data['images']) == count)
        deck = route('image-points', dict(bases['image-points'], src=jpeg))
        check('image options: %s accepts JPEG' % label,
              deck.slides[0].data['src'] == jpeg)

    invalid = []
    for name, base in bases.items():
        for key in ('title', 'src') if name == 'image-points' else ('title',):
            data = dict(base)
            del data[key]
            invalid.append((name, data, key, None))
            for value in (None, '', '   ', 12, [], {}, '\\(x\\)'):
                invalid.append((name, dict(base, **{key: value}), key, None))
        invalid.append((name, dict(base, invented='ignored'), 'invented', None))
        for notes in (12, [], {}, True):
            invalid.append((name, base, 'notes', notes))
    for value in ('steps', 'tilt', '', 0, [], {}, True):
        invalid.append(('image-points', dict(bases['image-points'], look=value),
                        'look', None))
    for name, field, count, count_message in [
            ('image-points', 'points', 0, 'required'),
            ('image-points', 'points', 6, 'takes 1 to 5 points'),
            ('image-gallery', 'images', 0, 'required'),
            ('image-gallery', 'images', 1, 'takes 2 or 3 images'),
            ('image-gallery', 'images', 4, 'takes 2 or 3 images')]:
        item = point if name == 'image-points' else images[0]
        invalid.append((name, dict(bases[name], **{field: [dict(item)] * count}),
                        count_message, None))
    for name, field, item, required in [
            ('image-points', 'points', point, ('text', 'icon')),
            ('image-gallery', 'images', images[0], ('src', 'title', 'text', 'icon'))]:
        for value in ('xy', {'a': {}, 'b': {}}, [12, None]):
            invalid.append((name, dict(bases[name], **{field: value}), 'object', None))
        for key in required:
            bad = dict(item)
            del bad[key]
            items = [bad] if name == 'image-points' else [bad, images[1]]
            invalid.append((name, dict(bases[name], **{field: items}), key, None))
            for value in (None, '', '   ', 12, [], {}, '\\(x\\)'):
                bad = dict(item, **{key: value})
                items = [bad] if name == 'image-points' else [bad, images[1]]
                invalid.append((name, dict(bases[name], **{field: items}), key, None))
        bad = dict(item, invented='ignored')
        items = [bad] if name == 'image-points' else [bad, images[1]]
        invalid.append((name, dict(bases[name], **{field: items}), 'invented', None))

    for number, (name, data, expected, notes) in enumerate(invalid, 1):
        for label, route in routes[:2]:
            try:
                route(name, data, notes=notes)
                message = ''
            except (SpecError, ValueError) as exc:
                message = str(exc)
            check('image options: %s rejects invalid case %d (%s)' % (label, number, expected),
                  expected in message, message or 'accepted invalid input')

    for path, expected in [(missing, 'image not found'), (corrupt, 'not a readable image'),
                           (gif, 'unsupported image format')]:
        for name in bases:
            data = dict(bases[name])
            if name == 'image-points':
                data['src'] = path
            else:
                data['images'] = [dict(images[0], src=path), images[1]]
            for label, route in routes:
                try:
                    route(name, data)
                    message = ''
                except (SpecError, MediaError) as exc:
                    message = str(exc)
                check('image options: %s/%s rejects bad source %s' % (label, name, expected),
                      expected in message, message or 'accepted invalid source')

    for name in bases:
        data = dict(bases[name])
        if name == 'image-points':
            data['points'] = [dict(point, icon='definitely_unknown_icon_xyz')]
        else:
            data['images'] = [dict(images[0], icon='definitely_unknown_icon_xyz'), images[1]]
        for label, route in routes:
            try:
                route(name, data)
                message = ''
            except (SpecError, IconNotFound) as exc:
                message = str(exc)
            check('image options: %s/%s refuses invented icon' % (label, name),
                  'no icon matched' in message, message or 'accepted unknown icon')

    for name, count, expected in [('image-points', 6, 'takes 1 to 5 points'),
                                   ('image-gallery', 4, 'takes 2 or 3 images')]:
        data = dict(bases[name])
        if name == 'image-points':
            data.update(src=missing, points=[dict(text='Вывод', icon='unknown_xyz')] * count)
        else:
            data['images'] = [dict(src=missing, title='Фото', text='Подпись',
                                   icon='unknown_xyz')] * count
        deck = Deck(skill_dir=SKILL)
        try:
            deck.add(name, data)
            message = ''
        except ValueError as exc:
            message = str(exc)
        check('image options: %s count precedes source/icon lookup' % name,
              expected in message and len(deck) == 0
              and deck.allocator.get_deck_usage() == {}, message)

    previous_cwd = os.getcwd()
    for name, base in bases.items():
        for data in (None, [], 'invalid'):
            _raises('image options: %s refuses non-object API data' % name,
                    ValueError, 'must be an object',
                    lambda: via_add(name, data))
        for field in ('layout', 'notes'):
            _raises('image options: %s refuses reserved API field %s' % (name, field),
                    ValueError, 'argument to Deck.add',
                    lambda: via_add(name, dict(base, **{field: 'ignored'})))
    try:
        os.chdir(out_dir)
        relative = os.path.basename(src)
        for label, route in routes:
            for name in bases:
                data = dict(bases[name])
                if name == 'image-points':
                    data['src'] = relative
                else:
                    data['images'] = [dict(item, src=relative) for item in images[:2]]
                deck = route(name, data)
                resolved = ([deck.slides[0].data['src']] if name == 'image-points'
                            else [item['src'] for item in deck.slides[0].data['images']])
                check('image options: %s/%s preserves relative source as absolute' % (label, name),
                      all(path == src for path in resolved), repr(resolved))
    finally:
        os.chdir(previous_cwd)





def test_circle_options():
    """Public circle accepts only two icon cards and three to six orbit nodes."""
    point = {'text': 'Изучаем задачу', 'icon': 'поиск'}
    card = {'title': 'Результат', 'text': 'Проверяем решение', 'icon': 'рост'}
    base = {'title': 'Цикл', 'points': [dict(point) for _ in range(3)],
            'cards': [dict(card), dict(card)]}

    def spec(data):
        return SP.deck_from_spec({'slides': [dict(data, layout='circle')]}, skill_dir=SKILL)

    routes = [('spec', spec),
              ('add', lambda data: Deck(skill_dir=SKILL).add('circle', data)),
              ('method', lambda data: Deck(skill_dir=SKILL).circle(**data))]
    for label, route in routes:
        for nodes in (3, 4, 5, 6):
            deck = route(dict(base, points=[dict(point) for _ in range(nodes)]))
            check('circle: %s accepts %d nodes and two cards' % (label, nodes),
                  len(deck.slides) == 1 and len(deck.slides[0].data['points']) == nodes
                  and len(deck.slides[0].data['cards']) == 2)
        for look in ('split', 'cards', None):
            _raises('circle: %s refuses removed look %r' % (label, look),
                    (SpecError, ValueError, TypeError), 'look',
                    lambda: route(dict(base, look=look)))
        for field, bad_counts in [('points', (0, 2, 7)), ('cards', (0, 1, 3))]:
            for count in bad_counts:
                sample = point if field == 'points' else card
                _raises('circle: %s rejects %d %s' % (label, count, field),
                        (SpecError, ValueError), field,
                        lambda: route(dict(base, **{field: [dict(sample) for _ in range(count)]})))
        for title in ('', ' ', None, 12):
            _raises('circle: %s rejects title %r' % (label, title),
                    (SpecError, ValueError), 'title', lambda: route(dict(base, title=title)))
        for bad in ({'text': 'Шаг'}, {'icon': 'рост'}, dict(point, text=' '),
                    dict(point, icon=' '), dict(point, title='Лишнее')):
            _raises('circle: %s rejects malformed node %r' % (label, bad),
                    (SpecError, ValueError), '',
                    lambda: route(dict(base, points=[bad, dict(point), dict(point)])))
        for bad in ({'text': 'Нет заголовка', 'icon': 'рост'}, dict(card, value='62%'),
                    dict(card, title=' '), {'value': ' ', 'text': 'Описание', 'icon': 'рост'}):
            _raises('circle: %s rejects malformed card head %r' % (label, bad),
                    (SpecError, ValueError), '', lambda: route(dict(base, cards=[bad, dict(card)])))
        _raises('circle: %s rejects two focus cards' % label,
                (SpecError, ValueError), 'one', lambda: route(dict(base, cards=[
                    {'value': '62%', 'text': 'Первый', 'icon': 'рост'},
                    {'value': '38%', 'text': 'Второй', 'icon': 'аналитика'}])))
        check('circle: %s accepts exactly one focus card' % label,
              len(route(dict(base, cards=[dict(card),
                  {'value': '62%', 'text': 'Доля', 'icon': 'аналитика'}])).slides) == 1)
        _raises('circle: %s requires card icons' % label,
                (SpecError, ValueError), 'icon', lambda: route(dict(base, cards=[
                    {'title': 'Итоги', 'text': 'Описание'}, dict(card)])))
        check('circle: %s accepts bullet items' % label,
              len(route(dict(base, cards=[dict(card),
                  {'title': 'Итоги', 'icon': 'рост', 'items': ['Первый', 'Второй']}])).slides) == 1)


def test_circle_output(out_dir):
    """The orbit is editable geometry, with measured copy on the shared ladder."""
    point = {'text': 'Изучаем задачу', 'icon': 'поиск'}
    node_icons = ('shield', 'rocket', 'users', 'lock', 'clock', 'star')
    slides = []
    for count in (3, 4, 5, 6):
        cards = [{'title': 'Результат', 'text': 'Проверяем решение', 'icon': 'рост'},
                 {'value': '62%', 'text': 'Доля участников', 'icon': 'аналитика'}]
        slides.append(dict(layout='circle', title='Цикл',
                           points=[dict(point, icon=icon) for icon in node_icons[:count]], cards=cards))
    built = SP.deck_from_spec({'slides': slides}, skill_dir=SKILL).build(
        os.path.join(out_dir, 'circle-output'), strict=False, keep_html=True)
    check('circle: all representative counts fit', not built.errors,
          '; '.join(str(issue) for issue in built.errors))
    roots = Document.open(built.html_path, extra_dirs=[SKILL]).boxes()
    for index, (slide, root) in enumerate(zip(slides, roots), 1):
        by_class = lambda name: [box for box in root.walk() if name in box.classes()]
        ring = by_class('circle-ring')[0]
        heading = by_class('circle-heading')[0]
        panel = by_class('circle-panel')[0]
        badges = by_class('circle-badge')
        labels = by_class('circle-label')
        for label, box, expected in [
                ('ring', ring, (307.9, 196.6, 688.8, 688.8)),
                ('heading', heading, (399, 432, 506, 248)),
                ('panel', panel, (40, 38, 1225, 1005))]:
            check('circle: slide %d literal %s bounds' % (index, label),
                  all(abs(actual - wanted) < .02 for actual, wanted in
                      zip((box.x, box.y, box.w, box.h), expected)))
        # Radius 344.4 around (652.3, 541) comes from the designer's ring;
        # the independent circle equation catches misplaced individual nodes.
        check('circle: slide %d badges sit on the source orbit' % index,
              len(badges) == len(slide['points']) and all(
                  abs(b.w - 102) < .01 and abs(b.h - 102) < .01
                  and abs(((b.x + 51 - 652.3) ** 2 + (b.y + 51 - 541) ** 2) ** .5 - 344.4) < .02
                  for b in badges))
        check('circle: slide %d all node labels have bounded fit boxes' % index,
              len(labels) == len(slide['points'])
              and all('fit-box' in b.classes()
                      and abs(b.w - (240 if len(labels) == 6 and position in (2, 5) else 300)) < .01
                      and abs(b.h - (84 if 'circle-label-above' in b.classes() else 106)) < .01
                      for position, b in enumerate(labels)))
        if len(labels) == 6:
            check('circle: slide %d equatorial captions stay outside the ring' % index,
                  abs(labels[2].x - 996) < .01 and abs(labels[5].x - 64) < .01
                  and abs(labels[2].y - 625) < .01 and abs(labels[5].y - 625) < .01)
        check('circle: slide %d uses the literal shared ceiling' % index,
              built.sizes[index - 1].pair == (44, 30)
              and built.sizes[index - 1].headline == 96)
        cards = by_class('circle-card')
        check('circle: slide %d right cards retain their region' % index,
              len(cards) == 2 and all(abs(b.x - 1277) < .01
                  and abs(b.w - 605) < .01 and abs(b.h - 496) < .01 for b in cards)
              and abs(cards[0].y - 38) < .01 and abs(cards[1].y - 547) < .01)
        copy = by_class('circle-card-copy')
        check('circle: slide %d reserves the card bottom and icon band' % index,
              len(copy) == 2 and all('fit-box' in box.classes()
                  and abs(box.x - 1337) < .01 and abs(box.w - 485) < .01
                  and abs(box.h - 300) < .01
                  for box in copy))
    ns = {'a': 'http://schemas.openxmlformats.org/drawingml/2006/main',
          'p': 'http://schemas.openxmlformats.org/presentationml/2006/main'}
    with zipfile.ZipFile(built.pptx_path) as archive:
        for index, slide in enumerate(slides, 1):
            xml = etree.fromstring(archive.read('ppt/slides/slide%d.xml' % index))
            paths = xml.findall('.//p:sp/p:spPr/a:custGeom', ns)
            rings = [geom for geom in paths if len(geom.findall('.//a:cubicBezTo', ns)) == 8]
            check('circle: slide %d ring is an editable eight-curve native path' % index,
                  len(rings) == 1 and rings[0].getparent().find('./a:gradFill', ns) is not None)
            groups = xml.findall('./p:cSld/p:spTree/p:grpSp', ns)
            badges = [g for g in groups if len(g.findall('./p:sp', ns)) == 1
                      and len(g.findall('./p:pic', ns)) == 1]
            check('circle: slide %d groups each disc with only its icon' % index,
                  len(badges) == len(slide['points'])
                  and all(not group.findall('.//a:t', ns) for group in badges))
            glows = xml.findall('.//a:innerShdw', ns)
            check('circle: slide %d keeps editable node and card inner shadows' % index,
                  len(glows) == len(slide['points']) + 3)
            labels = [shape for shape in xml.findall('.//p:sp', ns)
                      if ''.join(shape.xpath('.//a:t/text()', namespaces=ns)) == 'Изучаем задачу']
            check('circle: slide %d node labels remain editable Regular text' % index,
                  len(labels) == len(slide['points']) and all(
                      set(shape.xpath('.//a:rPr/@sz', namespaces=ns)) == {'2250'}
                      and set(shape.xpath('.//a:rPr/@b', namespaces=ns)) == {'0'}
                      and shape.getparent().tag == '{%s}spTree' % ns['p'] for shape in labels))
    # Top six-node labels end at y=166: the 84px two-line region starts at
    # y=82. At both ladder sizes the gap to the badge at y=191.74 is 25.74px.
    document = Document.open(built.html_path, extra_dirs=[SKILL])
    roots = document.boxes()
    top = [b for b in roots[-1].walk() if 'circle-label-above' in b.classes()]
    for body_size in (30, 24):
        for label in top:
            for node in F.by_class(label.el, 'card-description'):
                document.set_style(node, 'font-size', '%dpx' % body_size)
        root = document.boxes()[-1]
        texts = [b for label in root.walk() if 'circle-label-above' in label.classes()
                 for b in label.walk() if 'card-description' in b.classes()]
        check('circle: %dpx top labels retain the literal badge gap' % body_size,
              len(texts) == 2 and all(abs(b.y + b.h - 166) < .01 for b in texts))
    from deckkit import autofit
    sizes = autofit.fit(document, SKILL, ['circle-%d' % count for count in (3, 4, 5, 6)])
    first_bounds = [(b.x, b.y, b.w, b.h) for root in document.boxes() for b in root.walk()]
    sizes_again = autofit.fit(document, SKILL, ['circle-%d' % count for count in (3, 4, 5, 6)])
    again_bounds = [(b.x, b.y, b.w, b.h) for root in document.boxes() for b in root.walk()]
    check('circle: refitting preserves all label and card geometry',
          first_bounds == again_bounds
          and [size.pair for size in sizes] == [size.pair for size in sizes_again])
    bad = dict(slides[0], title='Ж' * 200,
               points=[dict(point, text='Очень длинная подпись. ' * 100) for _ in range(3)])
    bad_card = dict(slides[1], cards=[dict(slides[1]['cards'][0],
                    text='Очень длинный текст. ' * 500), slides[1]['cards'][1]])
    overflow = SP.deck_from_spec({'slides': [bad, bad_card]}, skill_dir=SKILL).build(
        os.path.join(out_dir, 'circle-overflow'), strict=False, pptx=False, keep_html=True)
    check('circle: impossible copy reports overflow rather than silently shrinking',
          any(issue.code == 'OVERFLOW' for issue in overflow.errors)
          and overflow.sizes[0].pair == (32, 20)
          and overflow.sizes[0].headline == 72 and not overflow.sizes[0].headline_fits)
    check('circle: oversized card copy stops at the legal floor and reports overflow',
          any(issue.code == 'OVERFLOW' and issue.slide == 2 for issue in overflow.errors)
          and overflow.sizes[1].pair == (32, 20))


def test_illustration_options():
    """Picture scenes have strict fields and never mask a structural refusal."""
    point = {'title': 'Рост', 'text': 'Развиваем продукт', 'icon': 'рост'}
    base = {'title': 'Новые возможности', 'points': [dict(point), dict(point)]}

    def via_spec(data):
        return SP.deck_from_spec({'slides': [dict(data, layout='illustration-points')]},
                                 skill_dir=SKILL, _allow_draft=True)

    routes = [('spec', via_spec),
              ('add', lambda data: Deck(skill_dir=SKILL).add('illustration-points', data)),
              ('method', lambda data: Deck(skill_dir=SKILL).illustration_points(
                  data['title'], data['points']))]
    check('illustrations: accepted layout is public',
          len(SP.deck_from_spec({'slides': [dict(base, layout='illustration-points')]},
                               skill_dir=SKILL).slides) == 1)
    for label, route in routes:
        for count in (2, 3, 4):
            deck = route(dict(base, points=[dict(point) for _ in range(count)]))
            check('illustrations: %s accepts %d titled points' % (label, count),
                  deck.slides[0].layout == 'illustration-points'
                  and len(deck.slides[0].data['points']) == count)
        for count in (1, 5):
            _raises('illustrations: %s rejects %d points' % (label, count),
                    (SpecError, ValueError), 'takes 2 to 4',
                    lambda: route(dict(base, points=[dict(point)] * count)))
    for label, route in routes[:2]:
        for key in ('title', 'text', 'icon'):
            for value in (None, '', ' ', 12, '\\(x\\)'):
                bad = dict(point, **{key: value})
                _raises('illustrations: %s refuses malformed point %s=%r' % (label, key, value),
                        (SpecError, ValueError), key,
                        lambda: route(dict(base, points=[bad, dict(point)])))
        for key in ('src', 'illustration', 'look', 'fit'):
            _raises('illustrations: %s has no scene or fit override %s' % (label, key),
                    (SpecError, ValueError), 'unknown field',
                    lambda: route(dict(base, **{key: 'рост'})))
        _raises('illustrations: %s refuses unknown point fields' % label,
                (SpecError, ValueError), 'unknown field',
                lambda: route(dict(base, points=[dict(point, invented='ignored'), dict(point)])))

    _raises('illustrations: injected cards cannot disable strict point fields',
            ValueError, 'unknown field "cards"', lambda: Deck(skill_dir=SKILL).add(
                'illustration-points', dict(base, cards=[Card('Title', 'Body')], typo='ignored')))
    for layout, count in [('cards', 2), ('grid', 4), ('complex', 5), ('pyramid', 5)]:
        cards = [dict(title='Рост', text='Развиваем продукт', icon='рост') for _ in range(count)]
        cards[-1]['illustration'] = 'рост'
        _raises('illustrations: removed last-card feature is rejected on %s' % layout,
                SpecError, 'unknown field', lambda: SP.deck_from_spec(
                    {'slides': [dict(layout=layout, title='Итоги', cards=cards)]},
                    skill_dir=SKILL, _allow_draft=True))


def test_illustration_output(out_dir):
    """Native pictures keep alpha; editable card geometry and fit stay shared."""
    import hashlib
    point = {'title': 'Рост', 'text': 'Развиваем продукт', 'icon': 'рост'}
    slides = [{'layout': 'illustration-points', 'title': 'Рост',
               'points': [dict(point) for _ in range(count)]} for count in (2, 3, 4)]
    built = SP.deck_from_spec({'slides': slides}, skill_dir=SKILL, _allow_draft=True).build(
        os.path.join(out_dir, 'illustration-output'), strict=False, keep_html=True)
    check('illustrations: representative point/card variants fit', not built.errors,
          repr(built.issues))
    roots = Document.open(built.html_path, extra_dirs=[SKILL]).boxes()
    for index, count in enumerate((2, 3, 4)):
        root = roots[index]
        hero = next(box for box in root.walk() if 'illustration-hero-card' in box.classes())
        right = next(box for box in root.walk() if 'illustration-right-card' in box.classes())
        heading = next(box for box in root.walk() if 'illustration-heading' in box.classes())
        title = next(box for box in root.walk() if 'title-chart-large' in box.classes())
        picture = next(box for box in root.walk() if 'illustration-hero-image' in box.classes())
        for label, box, expected in [('hero', hero, (38, 38, 915, 1004)),
                                     ('right', right, (968, 38, 914, 1004)),
                                     ('headline', heading, (112, 108, 701, 194)),
                                     ('picture', picture, (38, 308, 915, 734))]:
            check('illustrations: %d-point %s uses the measured source bounds' % (count, label),
                  all(abs(a - b) < .003 for a, b in zip((box.x, box.y, box.w, box.h), expected)))
        rows = [box for box in root.walk() if 'illustration-point' in box.classes()]
        captions = [box for box in root.walk() if 'card-description' in box.classes()]
        names = [box for box in root.walk() if 'card-subtitle' in box.classes()]
        fits = [box for box in root.walk() if 'fit-box' in box.classes()
                and 'illustration-heading' not in box.classes()]
        check('illustrations: %d-point rows use the shared ceiling and Medium titles' % count,
              len(rows) == count and len(captions) == count and len(names) == count
              and all(box.font_size == 44 and box.style.get('font-weight') == '500' for box in names)
              and all(box.font_size == 30 and box.style.get('color') == '#676767' for box in captions)
              and all(abs(box.w - 621) < .003 and abs(box.h - {2: 238, 3: 238, 4: 196}[count]) < .003
                      for box in fits)
              and title.font_size == 96 and abs(title.y - 108) < .003
              and heading.y + heading.h <= picture.y)
    samples = [
        {'title': 'Начинаем с задачи', 'text': 'Формулируем цель и выбираем сценарий, который поможет пользователю.', 'icon': 'цель'},
        {'title': 'Проверяем решение', 'text': 'Собираем обратную связь и обсуждаем результат с командой.', 'icon': 'проверка'}]
    for long, expected_y, expected_height in [(False, 312.8, 238), (True, 240.8, 340)]:
        points = [dict(p, text=(p['text'] + ' ' + p['text']) if long else p['text']) for p in samples]
        result = SP.deck_from_spec({'slides': [dict(layout='illustration-points',
            title='От идеи\nк результату', points=points)]}, skill_dir=SKILL).build(
                os.path.join(out_dir, 'illustration-center-%s' % long), pptx=False, keep_html=True)
        document = Document.open(result.html_path, extra_dirs=[SKILL])
        root = document.boxes()[0]
        visible = [b for b in root.walk() if
                   {'card-subtitle', 'card-description', 'illustration-point-icon'} & b.classes()]
        region = next(b for b in root.walk() if 'illustration-list' in b.classes())
        fits = [b for b in region.walk() if 'fit-box' in b.classes()]
        check('illustrations: accepted C geometry long=%s' % long,
              abs(region.y - expected_y) < .01 and all(abs(b.h - expected_height) < .01 for b in fits)
              and abs((min(b.y for b in visible) + max(b.y+b.h for b in visible))/2 - 540) < .01
              and result.sizes[0].pair == (44, 30))
        from deckkit import autofit
        autofit.fit(document, SKILL, ['illustration-points'])
        again = next(b for b in document.boxes()[0].walk() if 'illustration-list' in b.classes())
        check('illustrations: refitting preserves C placement long=%s' % long,
              abs(again.y - expected_y) < .01)
    bad_slides = [dict(slides[0], title='Ж' * 100),
                  dict(slides[2], points=[dict(point, text='Описание продукта. ' * 500)] * 4)]
    bad = SP.deck_from_spec({'slides': bad_slides}, skill_dir=SKILL, _allow_draft=True).build(
        os.path.join(out_dir, 'illustration-overflow'), strict=False, pptx=False, keep_html=True)
    for index, label in enumerate(('hero headline', 'point copy'), 1):
        check('illustrations: %s overflow is reported' % label,
              any(issue.slide == index and issue.code == 'OVERFLOW' for issue in bad.errors))
    check('illustrations: hero headline keeps the legal 72px floor',
          bad.sizes[0].headline == 72 and not bad.sizes[0].headline_fits)
    ns = {'a': 'http://schemas.openxmlformats.org/drawingml/2006/main',
          'p': 'http://schemas.openxmlformats.org/presentationml/2006/main',
          'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
    hero_path = os.path.join(SKILL, 'assets', 'images', 'illustration-collage.png')
    hero_hash = hashlib.sha256(open(hero_path, 'rb').read()).digest()
    with zipfile.ZipFile(built.pptx_path) as archive:
        for index in range(len(slides)):
            xml = etree.fromstring(archive.read('ppt/slides/slide%d.xml' % (index + 1)))
            rels = etree.fromstring(archive.read('ppt/slides/_rels/slide%d.xml.rels' % (index + 1)))
            media = {node.get('Id'): posixpath.normpath(posixpath.join('ppt/slides', node.get('Target')))
                     for node in rels if node.get('Type', '').endswith('/image')}
            wanted = hero_hash
            photos = [pic for pic in xml.findall('.//p:pic', ns)
                      if hashlib.sha256(archive.read(media[pic.find('./p:blipFill/a:blip', ns).get(
                          '{%s}embed' % ns['r'])])).digest() == wanted]
            check('illustrations: slide %d preserves one original editable alpha picture' % (index + 1),
                  len(photos) == 1 and photos[0].getparent().tag == '{%s}spTree' % ns['p'])
            if photos:
                check('illustrations: slide %d contains the scene without crop/stretch' % (index + 1),
                      photos[0].find('./p:blipFill/a:srcRect', ns) is None)
            expected_cards = 2
            glows = xml.findall('.//a:innerShdw', ns)
            check('illustrations: slide %d retains the existing card inner glows' % (index + 1),
                  len(glows) == expected_cards
                  and sum(glow.find('./a:srgbClr', ns).get('val') == 'FFFFFF'
                          for glow in glows) == 1)
            if index < 3:
                titles = [shape for shape in xml.findall('.//p:sp', ns)
                          if set(shape.xpath('.//a:rPr/@sz', namespaces=ns)) == {'3300'}
                          and ''.join(shape.xpath('.//a:t/text()', namespaces=ns)) == 'Рост']
                bodies = [shape for shape in xml.findall('.//p:sp', ns)
                          if ''.join(shape.xpath('.//a:t/text()', namespaces=ns)) == 'Развиваем продукт']
                check('illustrations: slide %d writes the shared Medium/Regular faces natively' % (index + 1),
                      len(titles) == index + 2 and len(bodies) == index + 2
                      and all(set(shape.xpath('.//a:rPr/@b', namespaces=ns)) == {'0'}
                              and set(shape.xpath('.//a:latin/@typeface', namespaces=ns)) == {'T-Sans Medium'}
                              for shape in titles)
                      and all(set(shape.xpath('.//a:rPr/@sz', namespaces=ns)) == {'2250'}
                              and set(shape.xpath('.//a:rPr/@b', namespaces=ns)) == {'0'}
                              for shape in bodies))
            # Cards and dedicated point rows remain independently editable;
            # no new broad group is introduced by this content enhancement.
            check('illustrations: slide %d adds no whole-card/slide group' % (index + 1),
                  not xml.findall('.//p:grpSp', ns))


def test_self_intro_options(out_dir):
    """Speaker introductions accept original portraits and plain bullets."""
    out_dir = os.path.realpath(out_dir)
    src = os.path.join(out_dir, 'self-intro-options.png')
    jpeg = os.path.join(out_dir, 'self-intro-options.jpg')
    gif = os.path.join(out_dir, 'self-intro-options.gif')
    corrupt = os.path.join(out_dir, 'self-intro-options-corrupt.png')
    for path in (src, jpeg, gif):
        Image.new('RGB', (320, 480), (40, 120, 180)).save(path)
    with open(corrupt, 'w', encoding='utf-8') as stream:
        stream.write('not an image')
    missing = os.path.join(out_dir, 'self-intro-options-missing.png')
    base = {'name': 'Анна Смирнова', 'role': 'Руководитель команды', 'src': src,
            'items': ['Запускаю новые продукты', 'Развиваю команду']}

    def via_spec(data, notes=None):
        return SP.deck_from_spec({'slides': [dict(data, layout='self-intro', notes=notes)]},
                                 skill_dir=SKILL)

    def via_add(data, notes=None):
        return Deck(skill_dir=SKILL).add('self-intro', data, notes=notes)

    def via_method(data, notes=None):
        return Deck(skill_dir=SKILL).self_intro(data['name'], data['role'], data['src'],
                                              data['items'], notes=notes)

    routes = [('spec', via_spec), ('add', via_add), ('method', via_method)]
    public = SP.deck_from_spec({'slides': [dict(base, layout='self-intro')]}, skill_dir=SKILL)
    check('self intro: accepted layout is available to ordinary specs',
          'self-intro' not in L.DRAFT and len(public.slides) == 1)
    for label, route in routes:
        for count in (2, 3, 4):
            items = ['Запускаю новые продукты'] * count
            deck = route(dict(base, items=items), notes='Заметка докладчика')
            check('self intro: %s accepts %d plain bullet strings and notes' % (label, count),
                  deck.slides[0].layout == 'self-intro'
                  and deck.slides[0].data['items'] == items
                  and deck.slides[0].notes == 'Заметка докладчика')
        deck = route(dict(base, src=jpeg))
        check('self intro: %s accepts a JPEG portrait' % label,
              deck.slides[0].data['src'] == jpeg)
    invalid = []
    for key in ('name', 'role', 'src'):
        data = dict(base)
        del data[key]
        invalid.append((data, 'the "%s" field is required' % key))
        for value in (None, '', '   ', 12, [], {}, True, '\\(x\\)'):
            expected = ('the "%s" field is required' % key
                        if value in (None, '', '   ', []) else
                        'formula' if isinstance(value, str) else
                        'the "%s" field must be a string' % key)
            invalid.append((dict(base, **{key: value}), expected))
    for value, expected in [(None, 'required'), ([], 'required'),
                             (['Пункт'], 'takes 2 to 4'),
                             (['Пункт'] * 5, 'takes 2 to 4'),
                             ('Пункт', 'list of strings'), ({}, 'list of strings'),
                             ([12], 'non-empty string'), ([''], 'non-empty string'),
                             (['   '], 'non-empty string'), ([{'text': 'Пункт'}], 'non-empty string'),
                             (['\\(x\\)'], 'formula')]:
        invalid.append((dict(base, items=value), expected))
    for key in ('title', 'fit', 'caption', 'icon', 'text', 'invented'):
        invalid.append((dict(base, **{key: 'ignored'}), 'unknown field "%s"' % key))
    for number, (data, expected) in enumerate(invalid, 1):
        for label, route in routes[:2]:
            try:
                route(data)
                message = ''
            except (SpecError, ValueError) as exc:
                message = str(exc)
            check('self intro: %s refuses invalid case %d (%s)' % (label, number, expected),
                  expected in message, message or 'accepted invalid input')
    for label, route in routes:
        for count in (1, 5):
            _raises('self intro: %s refuses unsupported bullet count %d' % (label, count),
                    (SpecError, ValueError), 'takes 2 to 4',
                    lambda: route(dict(base, items=['Пункт'] * count)))
        for notes in (12, [], {}, True):
            _raises('self intro: %s refuses non-text notes %r' % (label, notes),
                    (SpecError, ValueError), 'notes', lambda: route(base, notes=notes))
        for path, expected in [(missing, 'image not found'), (corrupt, 'not a readable image'),
                               (gif, 'unsupported image format')]:
            _raises('self intro: %s refuses bad portrait %s' % (label, expected),
                    (SpecError, MediaError), expected, lambda: route(dict(base, src=path)))
    for value in (None, [], 'invalid'):
        _raises('self intro: API refuses non-object data %r' % value,
                ValueError, 'must be an object', lambda: via_add(value))
    for key in ('layout', 'notes'):
        _raises('self intro: API refuses reserved data field %s' % key,
                ValueError, 'argument to Deck.add', lambda: via_add(dict(base, **{key: 'ignored'})))
    deck = Deck(skill_dir=SKILL)
    try:
        deck.add('self-intro', dict(base, src=missing, items=['Пункт'] * 5))
        message = ''
    except ValueError as exc:
        message = str(exc)
    check('self intro: bullet count precedes portrait lookup',
          'takes 2 to 4' in message and len(deck) == 0
          and deck.allocator.get_deck_usage() == {}, message)
    previous_cwd = os.getcwd()
    try:
        os.chdir(out_dir)
        for label, route in routes:
            deck = route(dict(base, src=os.path.basename(src)))
            check('self intro: %s resolves the original relative portrait path once' % label,
                  deck.slides[0].data['src'] == src)
    finally:
        os.chdir(previous_cwd)


def test_self_intro_output(out_dir):
    """Editable portraits and text retain the designer's bounded composition."""
    import hashlib
    from deckkit.preview import render_file
    out_dir = os.path.realpath(out_dir)
    wide = os.path.join(out_dir, 'intro-wide.png')
    alpha = os.path.join(out_dir, 'intro-alpha.png')
    Image.new('RGB', (400, 200), (20, 120, 180)).save(wide)
    Image.new('RGBA', (200, 400), (20, 120, 180, 128)).save(alpha)
    base = {'layout': 'self-intro', 'name': 'Анна', 'role': 'Директор', 'src': wide,
            'items': ['Развиваю команду', 'Развиваю команду']}
    slides = [dict(base, src=alpha if count == 3 else wide,
                   items=['Развиваю команду'] * count, notes='Заметка докладчика')
              for count in (2, 3, 4)]
    slides += [dict(base, items=['Работаю с командами\nи продуктами'] * 3),
               dict(base, name='Анна\nАнна\nАнна'),
               dict(base, role='Руководитель\nдепартамента'),
               dict(base, items=['Помогаю создавать и развивать новые продукты. ' * 40] * 3),
               dict(base, items=['Ж' * 100] * 2)]
    fitted_names = [dict(base, name='Ж' * length) for length in (6, 7)]
    built = SP.deck_from_spec({'slides': slides[:4] + fitted_names}, skill_dir=SKILL).build(
        os.path.join(out_dir, 'self-intro-output'), strict=False, keep_html=True)
    bad = SP.deck_from_spec({'slides': slides[4:]}, skill_dir=SKILL).build(
        os.path.join(out_dir, 'self-intro-overflow'), strict=False, pptx=False, keep_html=True)
    roots = Document.open(built.html_path, extra_dirs=[SKILL]).boxes()
    for index, count in enumerate((2, 3, 4)):
        root = roots[index]
        region = next(box for box in root.walk() if 'intro-list-region' in box.classes())
        holder = next(box for box in root.walk() if 'bullet-list' in box.classes())
        rows = [box for box in holder.walk() if 'bullet-item' in box.classes()]
        text = [box for box in holder.walk() if 'bullet-text' in box.classes()]
        check('self intro: %d items keep the literal bounded list region' % count,
              all(abs(a - b) < .003 for a, b in zip(
                  (region.x, region.y, region.w, region.h), (152.104, 530, 702.204, 369.051))))
        check('self intro: %d items grow upward from the shared bottom' % count,
              len(rows) == count and abs(holder.y + holder.h - 899.051) < .003
              and abs(holder.h - (39.6 * count + 27.2 * (count - 1))) < .003
              and all(box.font_size == 36 and box.style.get('line-height') == '110%'
                      for box in text))
        triangles = [node for node in root.el.iter() if node.tag.endswith('path')]
        check('self intro: %d items reuse the existing triangle marker' % count,
              len(triangles) == count
              and all(node.get('d') == 'M0 0H19.75L15.3611 4.46344L9.875 10.0944L0 19.75V0Z'
                      for node in triangles))
        name = next(box for box in root.walk() if 'title-person' in box.classes())
        role = next(box for box in root.walk() if 'intro-role' in box.classes())
        check('self intro: %d items retain name and role typography' % count,
              abs(name.x - 152.104) < .003 and abs(name.y - 180.949) < .003
              and name.font_size == 128 and name.style.get('font-weight') == '700'
              and abs(role.x - 152.104) < .003 and abs(role.y - 422.688) < .003
              and role.font_size == 44 and role.style.get('font-weight') == '400')
        check('self intro: %d items fit without content errors' % count,
              not any(issue.slide == index + 1 for issue in built.errors))
    short = next(box for box in roots[2].walk() if 'bullet-list' in box.classes())
    grown = next(box for box in roots[3].walk() if 'bullet-list' in box.classes())
    check('self intro: longer bullet lines grow upward without moving the bottom',
          grown.y < short.y and abs(grown.y + grown.h - 899.051) < .003
          and abs(grown.h - 292) < .003
          and not any(issue.slide == 4 for issue in built.errors))
    for index, field in ((5, 'name'), (6, 'role'), (7, 'list'), (8, 'unbroken bullet')):
        check('self intro: %s overflow is visible' % field,
              any(issue.slide == index - 4 and issue.code == 'OVERFLOW' for issue in bad.errors))
    check('self intro: oversized names stop at 96px and the two-line cap',
          bad.sizes[0].headline == 96 and not bad.sizes[0].headline_fits)
    check('self intro: wide names use the legal 112px and 96px steps',
          [size.headline for size in built.sizes[4:]] == [112, 96]
          and all(size.headline_fits for size in built.sizes[4:]))
    ns = {'a': 'http://schemas.openxmlformats.org/drawingml/2006/main',
          'p': 'http://schemas.openxmlformats.org/presentationml/2006/main',
          'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
    original_hashes = [hashlib.sha256(open(path, 'rb').read()).hexdigest() for path in (wide, alpha)]
    with zipfile.ZipFile(built.pptx_path) as archive:
        for index in range(3):
            xml = etree.fromstring(archive.read('ppt/slides/slide%d.xml' % (index + 1)))
            rels = etree.fromstring(archive.read('ppt/slides/_rels/slide%d.xml.rels' % (index + 1)))
            media = {node.get('Id'): posixpath.normpath(posixpath.join('ppt/slides', node.get('Target')))
                     for node in rels if node.get('Type', '').endswith('/image')}
            wanted = original_hashes[1 if index == 1 else 0]
            photos = [pic for pic in xml.findall('.//p:pic', ns)
                      if hashlib.sha256(archive.read(media[pic.find('./p:blipFill/a:blip', ns).get(
                          '{%s}embed' % ns['r'])])).hexdigest() == wanted]
            check('self intro: slide %d preserves the original native portrait bytes' % (index + 1),
                  len(photos) == 1)
            photo = photos[0]
            transform = photo.find('./p:spPr/a:xfrm', ns)
            values = [int(value) / 9525 for node, keys in ((transform.find('./a:off', ns), ('x', 'y')),
                                                          (transform.find('./a:ext', ns), ('cx', 'cy')))
                      for value in (node.get(key) for key in keys)]
            check('self intro: slide %d preserves portrait aperture and 43px corners' % (index + 1),
                  all(abs(a - b) < .003 for a, b in zip(values, (960, 233.158, 702.204, 700.756)))
                  and photo.xpath('./p:spPr/a:prstGeom/@prst', namespaces=ns) == ['roundRect']
                  and photo.xpath('./p:spPr/a:prstGeom/a:avLst/a:gd/@fmla', namespaces=ns)
                  == ['val 6136'])
            crop = photo.find('./p:blipFill/a:srcRect', ns)
            axes = ('t', 'b') if index == 1 else ('l', 'r')
            check('self intro: slide %d retains the centered cover crop' % (index + 1),
                  crop is not None and [crop.get(key) for key in axes]
                  == (['25052', '25052'] if index == 1 else ['24948', '24948']))
            groups = xml.findall('.//p:grpSp', ns)
            check('self intro: slide %d has bullet groups without a full-slide group' % (index + 1),
                  len(groups) == index + 2
                  and photo.getparent().tag == '{%s}spTree' % ns['p']
                  and all(int(group.find('./p:grpSpPr/a:xfrm/a:ext', ns).get('cx')) < 18288000
                          for group in groups))
            shapes = xml.findall('.//p:sp', ns)
            name = next(shape for shape in shapes if ''.join(shape.xpath('.//a:t/text()', namespaces=ns)) == 'Анна')
            role = next(shape for shape in shapes if ''.join(shape.xpath('.//a:t/text()', namespaces=ns)) == 'Директор')
            bullets = [shape for shape in shapes
                       if ''.join(shape.xpath('.//a:t/text()', namespaces=ns)) == 'Развиваю команду']
            check('self intro: slide %d exports editable whole-point name/role/bullets' % (index + 1),
                  set(name.xpath('.//a:rPr/@sz', namespaces=ns)) == {'9600'}
                  and set(name.xpath('.//a:rPr/@b', namespaces=ns)) == {'1'}
                  and not name.xpath('.//a:gradFill', namespaces=ns)
                  and set(role.xpath('.//a:rPr/@sz', namespaces=ns)) == {'3300'}
                  and set(role.xpath('.//a:rPr/@b', namespaces=ns)) == {'0'}
                  and len(bullets) == index + 2
                  and all(set(shape.xpath('.//a:rPr/@sz', namespaces=ns)) == {'2700'}
                          and set(shape.xpath('.//a:rPr/@b', namespaces=ns)) == {'0'} for shape in bullets))
            check('self intro: slide %d exports speaker notes' % (index + 1),
                  'Заметка докладчика' in archive.read('ppt/notesSlides/notesSlide%d.xml' % (index + 1)).decode('utf-8'))
        for slide_number, length, size in ((5, 6, '8400'), (6, 7, '7200')):
            xml = etree.fromstring(archive.read('ppt/slides/slide%d.xml' % slide_number))
            name = next(shape for shape in xml.findall('.//p:sp', ns)
                        if ''.join(shape.xpath('.//a:t/text()', namespaces=ns)) == 'Ж' * length)
            check('self intro: fitted name on slide %d exports legal whole-point Bold' % slide_number,
                  set(name.xpath('.//a:rPr/@sz', namespaces=ns)) == {size}
                  and set(name.xpath('.//a:rPr/@b', namespaces=ns)) == {'1'})
    preview = render_file(built.html_path, os.path.join(out_dir, 'intro-preview'), SKILL,
                          wanted=[2], scale=.5)[0]
    image = Image.open(preview).convert('RGB')
    centre = image.getpixel((round(1311 * .5), round(583 * .5)))
    corner = image.getpixel((round(962 * .5), round(235 * .5)))
    check('self intro: portrait alpha and rounded clearing survive preview',
          all(abs(a - b) <= 1 for a, b in zip(centre, (137, 187, 217)))
          and all(channel > 220 for channel in corner), repr((centre, corner)))


def test_screenshot_frame_output(out_dir):
    """Designer device apertures stay fixed when editable text grows."""
    out_dir = os.path.realpath(out_dir)
    import hashlib
    src = os.path.join(out_dir, 'screenshot-native-original.png')
    Image.new('RGB', (600, 1000), (20, 120, 180)).save(src)
    expected_screens = [
        [(1029.328, 198.722, 511.122, 842.049)],
        [(837.402, 54.392, 422.415, 912.789),
         (1348.094, 245.592, 422.415, 912.789)],
        [(793.783, 84.792, 313.174, 676.732),
         (1172.200, 307.173, 313.174, 676.732),
         (1550.617, 153.550, 313.174, 676.732)],
        [(832.182, 123.312, 1088.927, 740.411)],
    ]
    expected_native = [list(items) for items in expected_screens]
    expected_native[1][1] = (1348.094, 245.592, 422.415, 834.408)
    slides = [dict(layout='screenshot-phone', title='Новый интерфейс',
                   text='Обновили экран',
                   images=[dict(src=src, caption='Новый экран') for _ in range(count)])
              for count in (1, 2, 3)]
    slides.append(dict(layout='screenshot-monitor', title='Рабочее место', src=src,
                       points=[dict(text='Вывод', icon='shield')]))
    grown = []
    for slide in slides:
        data = dict(slide)
        if data['layout'] == 'screenshot-phone':
            data['text'] = 'Помогаем бизнесу решать задачи качественно и быстро. ' * 5
        else:
            data['points'] = [dict(text='Помогаем бизнесу решать задачи качественно и быстро. ' * 2,
                                  icon=icon) for icon in ('shield', 'rocket', 'users', 'check-circle')]
        grown.append(data)
    # Omitted captions must remove both native text and its arc.
    for count in (1, 2, 3):
        slides.append(dict(layout='screenshot-phone', title='Без выносок',
                           text='Обновили экран',
                           images=[dict(src=src) for _ in range(count)]))
    built = SP.deck_from_spec({'slides': slides + grown}, skill_dir=SKILL,
                              _allow_draft=True).build(
        os.path.join(out_dir, 'screenshot-frames'), strict=False, keep_html=True)
    check('screenshot frames: representative drafts fit', not built.errors,
          repr(built.issues))
    doc = Document.open(built.html_path, extra_dirs=[SKILL])
    roots = list(doc.boxes())
    for index, expected in enumerate(expected_screens):
        screens = [box for box in roots[index].walk()
                   if 'screenshot-screen' in box.classes()]
        actual = [(box.x, box.y, box.w, box.h) for box in screens]
        check('screenshot frames: variant %d uses designer apertures' % (index + 1),
              len(actual) == len(expected)
              and all(abs(a - b) < 0.003 for got, want in zip(actual, expected)
                      for a, b in zip(got, want)), repr(actual))
        plates = [box for box in roots[index].walk()
                  if 'screenshot-screen-base' in box.classes()]
        check('screenshot frames: variant %d has white screen underlays' % (index + 1),
              len(plates) == len(expected)
              and all(box.style.get('background-color') == '#FFFFFF' for box in plates)
              and all(abs(a - b) < 0.003
                      for box, want in zip(plates, expected_native[index])
                      for a, b in zip((box.x, box.y, box.w, box.h), want)))
        heading = next(box for box in roots[index].walk()
                       if 'title-screenshot' in box.classes())
        origin = (188.764, 320.810) if index == 0 else (59.269, 60.706)
        check('screenshot frames: variant %d keeps the designer headline origin' % (index + 1),
              abs(heading.x - origin[0]) < 0.003
              and abs(heading.y - origin[1]) < 0.003)
        text_class = ('screenshot-description' if index < 3 else 'chart-side')
        before = next(box for box in roots[index].walk() if text_class in box.classes())
        after = next(box for box in roots[index + 7].walk() if text_class in box.classes())
        check('screenshot frames: variant %d keeps its top text anchor' % (index + 1),
              abs(before.x - after.x) < 0.001 and abs(before.y - after.y) < 0.001,
              repr((before.x, before.y, after.x, after.y)))
        if index < 3:
            check('screenshot frames: variant %d uses the approved body size' % (index + 1),
                  before.style.get('font-size') == ('32px' if index == 0 else '36px'))
    caption_boxes = [box for root in roots for box in root.walk()
                     if 'screenshot-caption-box' in box.classes()]
    check('screenshot frames: annotation regions stay within the whole canvas',
          bool(caption_boxes) and all(0 <= box.x and 0 <= box.y
              and box.x + box.w <= 1920 and box.y + box.h <= 1080
              for box in caption_boxes))
    plain_ends = [
        [(1624.000, 160.000, 'left')],
        [(896.000, 1032.000, 'left'), (1752.513, 131.896, 'right')],
        [(823.134, 902.098, 'left'), (1468.926, 183.732, 'right'),
         (1806.497, 966.743, 'right')],
    ]
    for index, expected in enumerate(plain_ends):
        captions = [box for box in roots[index].walk()
                    if 'screenshot-caption-box' in box.classes()]
        for item, (holder, (x, y, align)) in enumerate(zip(captions, expected), 1):
            text = next(box for box in holder.walk() if 'screenshot-caption' in box.classes())
            edge = holder.x if align == 'left' else holder.x + holder.w
            gap = edge - x if align == 'left' else x - edge
            check('screenshot frames: variant %d caption %d clears the plain arc end by 16px' %
                  (index + 1, item),
                  abs(gap - 16) < 0.003 and abs(holder.y + holder.h / 2 - y) < 0.003
                  and holder.style.get('text-align') == align)
            check('screenshot frames: variant %d caption %d centres its measured text block' %
                  (index + 1, item),
                  abs(text.y + text.h / 2 - y) < 0.003
                  and text.style.get('font-size') == '36px'
                  and text.style.get('font-weight') == '500')
    arrow_sources = [os.path.join(os.path.dirname(built.html_path), box.src)
                     for box in roots[0].walk()
                     if box.el is not None and box.el.tag == 'img'
                     and os.path.basename(box.el.get('src', '')) == 'arrow.png']
    check('screenshot frames: one-phone decoration reuses the shared arrow',
          len(arrow_sources) == 1 and os.path.realpath(arrow_sources[0])
          == os.path.realpath(os.path.join(SKILL, 'assets', 'images', 'arrow.png')),
          repr(arrow_sources))
    ns = {'a': 'http://schemas.openxmlformats.org/drawingml/2006/main',
          'p': 'http://schemas.openxmlformats.org/presentationml/2006/main',
          'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
    original_hash = hashlib.sha256(open(src, 'rb').read()).hexdigest()
    with zipfile.ZipFile(built.pptx_path) as archive:
        for index, expected in enumerate(expected_native):
            xml = etree.fromstring(archive.read('ppt/slides/slide%d.xml' % (index + 1)))
            rel = etree.fromstring(archive.read(
                'ppt/slides/_rels/slide%d.xml.rels' % (index + 1)))
            media = {node.get('Id'): posixpath.normpath(posixpath.join(
                'ppt/slides', node.get('Target'))) for node in rel
                if node.get('Type', '').endswith('/image')}
            screens = [pic for pic in xml.findall('.//p:pic', ns)
                       if hashlib.sha256(archive.read(media[
                           pic.find('./p:blipFill/a:blip', ns).get('{%s}embed' % ns['r'])]
                       )).hexdigest() == original_hash]
            check('screenshot frames: variant %d keeps each original native picture' % (index + 1),
                  len(screens) == len(expected))
            actual = []
            for pic in screens:
                transform = pic.find('./p:spPr/a:xfrm', ns)
                offset = transform.find('./a:off', ns)
                extent = transform.find('./a:ext', ns)
                actual.append(tuple(int(value) / 9525.0 for value in
                                    (offset.get('x'), offset.get('y'),
                                     extent.get('cx'), extent.get('cy'))))
            check('screenshot frames: variant %d native picture viewport matches source' % (index + 1),
                  len(actual) == len(expected)
                  and all(abs(a - b) < 0.003 for got, want in zip(actual, expected)
                          for a, b in zip(got, want)), repr(actual))
            if index in (0, 3):
                # Designer phone1 has square bottom corners; monitor has only
                # one rounded corner. Neither can become an all-round frame.
                curves = screens[0].xpath(
                    './p:spPr/a:custGeom/a:pathLst/a:path/a:cubicBezTo', namespaces=ns)
                check('screenshot frames: variant %d preserves its partial rounded mask' % (index + 1),
                      len(curves) == (2 if index == 0 else 1)
                      and not screens[0].xpath('./p:spPr/a:prstGeom', namespaces=ns))
            else:
                check('screenshot frames: variant %d preserves rounded screen corners' % (index + 1),
                      all(pic.xpath('./p:spPr/a:prstGeom/@prst', namespaces=ns)
                          == ['roundRect'] for pic in (screens[:1] if index == 1 else screens)))
                if index == 1:
                    check('screenshot frames: second phone clips at canvas with square bottom corners',
                          len(screens[1].xpath(
                              './p:spPr/a:custGeom/a:pathLst/a:path/a:cubicBezTo', namespaces=ns)) == 2
                          and abs(actual[1][1] + actual[1][3] - 1080) < 0.003)
            check('screenshot frames: variant %d defaults to native cover' % (index + 1),
                  all(pic.xpath('./p:blipFill/a:srcRect', namespaces=ns)
                      and any(int(value) > 0 for value in pic.find('./p:blipFill/a:srcRect', ns).attrib.values())
                      for pic in screens))
            if index < 3:
                text_shapes = xml.findall('.//p:sp', ns)
                body = [shape for shape in text_shapes
                        if ''.join(shape.xpath('.//a:t/text()', namespaces=ns)) == 'Обновили экран']
                check('screenshot frames: variant %d body uses integer native points' % (index + 1),
                      len(body) == 1 and set(body[0].xpath('.//a:rPr/@sz', namespaces=ns))
                      == ({'2400'} if index == 0 else {'2700'}))
                captions = [shape for shape in text_shapes
                            if ''.join(shape.xpath('.//a:t/text()', namespaces=ns)) == 'Новый экран']
                check('screenshot frames: variant %d captions are editable 27pt Medium' % (index + 1),
                      len(captions) == index + 1
                      and all(set(caption.xpath('.//a:rPr/@sz', namespaces=ns)) == {'2700'}
                              and set(caption.xpath('.//a:rPr/a:latin/@typeface', namespaces=ns))
                              == {'T-Sans Medium'} for caption in captions))
                if index < 2:
                    quarter = xml.xpath('.//p:sp[p:spPr/a:prstGeom[@prst="arc"]]', namespaces=ns)[0]
                    check('screenshot frames: variant %d keeps the quarter-turn annotation' % (index + 1),
                          quarter.xpath('./p:spPr/a:prstGeom/a:avLst/a:gd/@fmla', namespaces=ns)
                          == ['val 5400000', 'val 10800000']
                          and not quarter.xpath('./p:spPr/a:xfrm/@flipH', namespaces=ns)
                          and quarter.xpath('./p:spPr/a:xfrm/@flipV', namespaces=ns)
                          == (['1'] if index == 0 else []))
                    if index == 0:
                        transform = quarter.find('./p:spPr/a:xfrm', ns)
                        offset = transform.find('./a:off', ns)
                        # The source backdrop's outer right bezel ends before
                        # x1565. Include the large arrowhead's half-width in
                        # the clearance, rather than checking only the path.
                        check('screenshot frames: single-phone downward callout clears the bezel at the top',
                              int(offset.get('x')) == 15030450
                              and int(offset.get('y')) == 1524000
                              and int(offset.get('x')) / 9525.0 - 2.765 * 5 / 2 > 1565
                              and quarter.xpath('./p:spPr/a:xfrm/a:ext/@cx | ./p:spPr/a:xfrm/a:ext/@cy',
                                                namespaces=ns) == ['876300', '1257300'])
        xml = etree.fromstring(archive.read('ppt/slides/slide3.xml'))
        arcs = xml.xpath('.//p:sp[p:spPr/a:prstGeom[@prst="arc"]]', namespaces=ns)
        check('screenshot frames: three captions produce three native arcs', len(arcs) == 3)
        expected_arcs = [
            ((777.066, 773.244, 132.233, 131.960), ['val 17261151', 'val 2706028'],
             {'flipH': '1', 'flipV': '1'}),
            ((1371.413, 166.836, 113.962, 113.727), ['val 18924109', 'val 3936764'], {}),
            ((1710.504, 841.904, 132.233, 131.960), ['val 17814735', 'val 2706028'],
             {'flipV': '1'}),
        ]
        for index, (arc, (rectangle, angles, flips)) in enumerate(zip(arcs, expected_arcs), 1):
            transform = arc.find('./p:spPr/a:xfrm', ns)
            offset, extent = transform.find('./a:off', ns), transform.find('./a:ext', ns)
            actual = tuple(int(value) / 9525.0 for value in
                           (offset.get('x'), offset.get('y'), extent.get('cx'), extent.get('cy')))
            check('screenshot frames: source annotation %d keeps arc geometry' % index,
                  all(abs(a - b) < 0.003 for a, b in zip(actual, rectangle))
                  and arc.xpath('./p:spPr/a:prstGeom/@prst', namespaces=ns) == ['arc']
                  and arc.xpath('./p:spPr/a:prstGeom/a:avLst/a:gd/@fmla', namespaces=ns) == angles
                  and {key: transform.get(key) for key in ('flipH', 'flipV')
                       if transform.get(key) is not None} == flips)
            check('screenshot frames: source annotation %d keeps native arrowhead' % index,
                  dict(arc.find('./p:spPr/a:ln/a:tailEnd', ns).attrib)
                  == {'type': 'arrow', 'w': 'lg', 'len': 'lg'}
                  and arc.xpath('./p:spPr/a:ln/@w', namespaces=ns) == ['26337']
                  and arc.xpath('./p:spPr/a:ln/a:solidFill/a:srgbClr/@val', namespaces=ns)
                  == ['333333'])
        for slide_number in (5, 6, 7):
            xml = etree.fromstring(archive.read('ppt/slides/slide%d.xml' % slide_number))
            check('screenshot frames: omitted captions remove annotations on slide %d' % slide_number,
                  not xml.xpath('.//p:sp[p:spPr/a:prstGeom[@prst="arc"]]', namespaces=ns)
                  and not xml.findall('.//p:cxnSp', ns)
                  and 'Новый экран' not in ''.join(xml.xpath('.//a:t/text()', namespaces=ns)))


def test_screenshot_caption_alignment(out_dir):
    """Two-line captions centre their actual block at the plain arc end."""
    src = os.path.join(out_dir, 'caption-alignment.png')
    Image.new('RGB', (600, 1000), (20, 120, 180)).save(src)
    built = Deck(skill_dir=SKILL).screenshot_phone(
        'Кабинет', 'Обновили интерфейс',
        [{'src': src, 'caption': 'Два этапа\nпроверки'} for _ in range(3)]).build(
            os.path.join(out_dir, 'screenshot-caption-alignment'),
            strict=False, keep_html=True)
    check('screenshot captions: two-line examples fit', not built.errors, repr(built.issues))
    root = list(Document.open(built.html_path, extra_dirs=[SKILL]).boxes())[0]
    holders = [box for box in root.walk() if 'screenshot-caption-box' in box.classes()]
    for index, (holder, centre, align) in enumerate(zip(
            holders, (902.098, 183.732, 966.743), ('left', 'right', 'right')), 1):
        text = next(box for box in holder.walk() if 'screenshot-caption' in box.classes())
        check('screenshot captions: two-line block %d centres without changing its alignment' % index,
              len(text.lines) == 2 and abs(text.h - 86.4) < .001
              and abs(text.y + text.h / 2 - centre) < .003
              and text.style.get('text-align') == align)
    ns = {'a': 'http://schemas.openxmlformats.org/drawingml/2006/main',
          'p': 'http://schemas.openxmlformats.org/presentationml/2006/main'}
    with zipfile.ZipFile(built.pptx_path) as archive:
        xml = etree.fromstring(archive.read('ppt/slides/slide1.xml'))
    captions = [shape for shape in xml.findall('.//p:sp', ns)
                if ''.join(shape.xpath('.//a:t/text()', namespaces=ns)) == 'Два этапапроверки']
    check('screenshot captions: each two-line block remains native Medium at 27pt',
          len(captions) == 3 and all(
              set(shape.xpath('.//a:rPr/@sz', namespaces=ns)) == {'2700'}
              and set(shape.xpath('.//a:rPr/a:latin/@typeface', namespaces=ns)) == {'T-Sans Medium'}
              for shape in captions))
    check('screenshot captions: native paragraphs preserve left/right text alignment',
          [set(shape.xpath('.//a:pPr/@algn', namespaces=ns)) for shape in captions]
          == [{'l'}, {'r'}, {'r'}])


def test_screenshot_headline_orphans(out_dir):
    """Use the next legal step for a stranded preposition, never rewrite text."""
    from unittest.mock import patch
    from deckkit import autofit as AF
    from deckkit import fit as FT
    from deckkit.typeset import glue_headline, typeset
    cases = [
        'Два экрана для сравнения',
        'Два экрана без изменений',
        'Проверка\nдля\nсравнения',
        'Обновление\nдля\nобслуживания\nклиентов',
        'Оченьдлинноеобязательноеназваниекотороенельзяразрывать для сравнения',
    ]
    # 638px is the measured bug reproduction: 96px leaves "для" alone,
    # while 88px has room to eliminate that connector-only middle line.
    path = os.path.join(out_dir, 'screenshot-headline-orphans.html')
    markup = '<html><head><link rel="stylesheet" href="%s"></head><body>' % os.path.join(SKILL, 'assets/base.css')
    for title in cases:
        markup += '<div class="slide"><div class="fit-box" style="position: absolute; left: 59px; top: 61px; width: 638px; height: 400px;"><p class="title-screenshot">%s</p></div></div>' % glue_headline(title).replace('\n', '<br>')
    markup += '</body></html>'
    with open(path, 'w', encoding='utf-8') as stream:
        stream.write(markup)
    document = Document.open(path, extra_dirs=[SKILL])
    layouts = ['screenshot-phone-2'] * len(cases)
    sizes = AF.fit(document, SKILL, layouts)
    headings = [next(box for box in root.walk() if 'title-screenshot' in box.classes())
                for root in document.boxes()]
    line_text = lambda box: [''.join(getattr(run, 'text', '') for run in line).strip()
                             for line in box.lines]
    for index, connector, following in ((0, 'для', 'сравнения'), (1, 'без', 'изменений')):
        check('screenshot headlines: %s is rescued by the first legal step' % connector,
              sizes[index].headline == 88 and sizes[index].headline_fits
              and len(headings[index].lines) == 2
              and connector + '\u00a0' + following in line_text(headings[index])
              and connector not in line_text(headings[index]),
              repr((sizes[index], line_text(headings[index]))))
    check('screenshot headlines: source words are preserved after fitting',
          all(' '.join(line_text(box)).split() == title.split()
              for box, title in zip(headings, cases)))
    check('screenshot headlines: unavoidable authored breaks keep the largest fit',
          sizes[2].headline == 96 and sizes[2].headline_fits
          and line_text(headings[2]) == ['Проверка', 'для', 'сравнения'])
    check('screenshot headlines: the line cap still stops at the legal floor',
          sizes[3].headline == 72 and not sizes[3].headline_fits
          and len(headings[3].lines) == 4)
    check('screenshot headlines: a mandatory long word still overflows at floor',
          sizes[4].headline == 72 and not sizes[4].headline_fits)
    warnings = VD._check_headline_orphans(document, layouts, SKILL)
    check('screenshot headlines: unavoidable orphan warnings remain visible',
          [(issue.slide, issue.code, issue.level) for issue in warnings]
          == [(3, 'HEADLINE_ORPHAN', 'warning'), (4, 'HEADLINE_ORPHAN', 'warning')],
          repr(warnings))
    overflows = VD._check_headlines(document, sizes, SKILL)
    check('screenshot headlines: warnings never replace floor overflow errors',
          [(issue.slide, issue.code, issue.level) for issue in overflows]
          == [(4, 'OVERFLOW', 'error'), (5, 'OVERFLOW', 'error')])
    check('screenshot headlines: opt-in glue preserves global prose typography',
          typeset(cases[0]) == cases[0]
          and glue_headline(cases[0]) == 'Два экрана для\u00a0сравнения')
    # The shared warning and candidate preference still detect unglued input
    # (for example an older intermediate HTML). Disabling that predicate
    # restores the exact connector-only middle line at 96px.
    mutant = Document.open(path, extra_dirs=[SKILL])
    mutant_heading_node = next(node for node in mutant.elements[0].iter()
                               if 'title-screenshot' in (node.get('class') or '').split())
    mutant_heading_node.text = cases[0]
    baseline_sizes = AF.fit(mutant, SKILL, layouts)
    check('screenshot headlines: candidate preference also rescues unglued HTML',
          baseline_sizes[0].headline == 88)
    with patch.object(FT, 'headline_orphans', return_value=[]):
        mutant_sizes = AF.fit(mutant, SKILL, layouts)
    mutant_heading = next(box for box in mutant.box(1).walk()
                          if 'title-screenshot' in box.classes())
    check('screenshot headlines: orphan predicate mutation restores the regression',
          mutant_sizes[0].headline == 96
          and line_text(mutant_heading) == ['Два экрана', 'для', 'сравнения'])
    src = os.path.join(out_dir, 'headline-original.png')
    Image.new('RGB', (600, 1000), (20, 120, 180)).save(src)
    deck = Deck(skill_dir=SKILL)
    deck.screenshot_phone(cases[0], 'Обновили экран', [{'src': src}] * 2)
    deck.screenshot_monitor(cases[0], src, [{'text': 'Вывод', 'icon': 'shield'}])
    built = deck.build(os.path.join(out_dir, 'screenshot-headline-integrated'),
                       strict=False, pptx=False, keep_html=True)
    headings = [next(box for box in root.walk() if 'title-screenshot' in box.classes())
                for root in Document.open(built.html_path, extra_dirs=[SKILL]).boxes()]
    check('screenshot headlines: both fillers keep the phrase connected in the built output',
          [size.headline for size in built.sizes] == [88, 88]
          and all('для\u00a0сравнения' in line_text(box) for box in headings)
          and all(slide.data['title'] == cases[0] for slide in deck.slides)
          and not any(issue.code == 'HEADLINE_ORPHAN' for issue in built.issues))


def test_self_intro_capacity(out_dir):
    """Pin person/list design budgets separately from tolerated defects."""
    src = os.path.join(out_dir, 'self-intro-capacity.png')
    Image.new('RGB', (800, 800), (40, 120, 180)).save(src)
    phrase = 'обслуживание клиентов и партнёров банка в едином окне '
    # Field/count/shape/last design fit/first OVERFLOW/chosen text px.
    cases = [('body', 2, 'prose', 168, 169, 32),
             ('body', 3, 'prose', 86, 124, 32),
             ('body', 4, 'prose', 86, 87, 32)]
    cases += [('body', count, 'word', 26, 27, 32) for count in (2, 3, 4)]
    cases += [('name', 2, 'prose', 27, 28, 96),
              ('name', 2, 'word', 7, 8, 96),
              ('role', 2, 'prose', 35, 36, 44),
              ('role', 2, 'word', 20, 21, 44)]
    slides, assertions = [], []
    for field, count, shape, limit, overflow, font_size in cases:
        for length in sorted(set((limit, limit + 1, overflow))):
            text = ('Ж' * length if shape == 'word'
                    else (phrase * (length // len(phrase) + 1))[:length])
            slide = dict(layout='self-intro', name='Анна', role='Директор', src=src,
                         items=['Короткий пункт'] * count)
            if field == 'body':
                slide['items'] = [text] * count
            else:
                slide[field] = text
            slides.append(slide)
            assertions.append((field, count, shape, length, limit, overflow, font_size))
    built = SP.deck_from_spec({'slides': slides}, skill_dir=SKILL).build(
        os.path.join(out_dir, 'self-intro-capacity'), strict=False, pptx=False, keep_html=True)
    roots = Document.open(built.html_path, extra_dirs=[SKILL]).boxes()
    for index, (root, case) in enumerate(zip(roots, assertions), 1):
        field, count, shape, length, limit, overflow, font_size = case
        label = '%s/%d/%s/%d' % (field, count, shape, length)
        region_class = {'body': 'intro-list-region', 'name': 'intro-name-region',
                        'role': 'intro-role-region'}[field]
        region = next(box for box in root.walk() if region_class in box.classes())
        texts = [box for box in region.walk() if box.kind == 'text' and box.lines]
        fits = all(max(box.line_widths or [0]) <= box.w + .5
                   and box.y >= region.y - .5
                   and box.y + box.h <= region.y + region.h + .5 for box in texts)
        if field == 'name':
            fits = fits and built.sizes[index - 1].headline_fits
        check('self intro capacity: %s has its measured design fit' % label,
              bool(texts) and fits == (length <= limit))
        errors = [issue for issue in built.errors if issue.slide == index]
        check('self intro capacity: %s has its separate defect threshold' % label,
              bool(errors) == (length >= overflow)
              and all(issue.code == 'OVERFLOW' for issue in errors), repr(errors))
        check('self intro capacity: %s keeps the legal text floor' % label,
              all(box.font_size == font_size for box in texts))
        if field == 'body':
            check('self intro capacity: %s shares the pair verdict' % label,
                  built.sizes[index - 1].pair_fits == (length <= limit))
            if length <= limit:
                holder = next(box for box in region.walk() if 'bullet-list' in box.classes())
                check('self intro capacity: %s retains the lower baseline' % label,
                      abs(holder.y + holder.h - 899.051) < .003)
        if field == 'body' and count == 3 and shape == 'prose' and length == 87:
            check('self intro capacity: small excess warns without becoming budget',
                  any(issue.slide == index and issue.code == 'OVERFLOW'
                      for issue in built.warnings) and not errors)


def test_screenshot_capacity(out_dir):
    """Pin measured fit boundaries independently of the overflow allowance."""
    src = os.path.join(out_dir, 'screenshot-capacity.png')
    Image.new('RGB', (1200, 2400), (20, 120, 180)).save(src)
    phrase = 'обслуживание клиентов и партнёров банка в едином окне '
    icons = ('shield', 'rocket', 'users', 'check-circle')
    # Family/count/field/shape/design last fit/first OVERFLOW/fixed text px.
    cases = []
    for count, body_limit, body_word, head_limit, head_word, body_size in (
            (1, 278, 27, 42, 10, 32), (2, 299, 19, 40, 9, 36),
            (3, 299, 19, 40, 9, 36)):
        cases += [
            ('screenshot-phone', count, 'body', 'prose', body_limit, body_limit + 1, body_size),
            ('screenshot-phone', count, 'body', 'word', body_word,
             29 if count == 1 else 20, body_size),
            ('screenshot-phone', count, 'caption', 'prose', 27, 28, 36),
            ('screenshot-phone', count, 'caption', 'word', 7, 9, 36),
            ('screenshot-phone', count, 'headline', 'prose', head_limit, head_limit + 1, None),
            ('screenshot-phone', count, 'headline', 'word', head_word, head_word + 1, None),
        ]
    for count, limit in ((1, 549), (2, 258), (3, 150), (4, 117)):
        cases += [('screenshot-monitor', count, 'body', 'prose', limit, limit + 1, 28),
                  ('screenshot-monitor', count, 'body', 'word', 23, 24, 28)]
    cases += [('screenshot-monitor', 1, 'headline', 'prose', 40, 41, None),
              ('screenshot-monitor', 1, 'headline', 'word', 9, 10, None)]
    slides, assertions = [], []
    for family, count, field, shape, limit, overflow, font_size in cases:
        for length in sorted(set((limit, limit + 1, overflow))):
            text = ('Ж' * length if shape == 'word'
                    else (phrase * (length // len(phrase) + 1))[:length])
            slide = {'layout': family,
                     'title': text if field == 'headline' else 'Заголовок слайда'}
            if family == 'screenshot-phone':
                slide.update(text=text if field == 'body' else 'Короткое описание',
                             images=[{'src': src, 'caption': text if field == 'caption' else 'Подпись'}
                                     for _ in range(count)])
            else:
                slide.update(src=src, points=[{'text': text if field == 'body' else 'Короткий вывод',
                                              'icon': icons[index]} for index in range(count)])
            slides.append(slide)
            assertions.append((family, count, field, shape, length, limit, overflow, font_size))
    built = SP.deck_from_spec({'slides': slides}, skill_dir=SKILL).build(
        os.path.join(out_dir, 'screenshot-capacity'), strict=False, pptx=False, keep_html=True)
    roots = Document.open(built.html_path, extra_dirs=[SKILL]).boxes()
    for index, (root, case) in enumerate(zip(roots, assertions), 1):
        family, count, field, shape, length, limit, overflow, font_size = case
        label = '%s/%d/%s/%s/%d' % (family, count, field, shape, length)
        role = ('title-screenshot' if field == 'headline' else 'screenshot-caption-box'
                if field == 'caption' else 'screenshot-body' if family == 'screenshot-phone'
                else 'chart-side')
        regions = [box for box in root.walk() if role in box.classes()]
        fits = built.sizes[index - 1].headline_fits
        text_boxes = []
        for region in regions:
            texts = [box for box in region.walk() if box.kind == 'text' and box.lines]
            for box in texts:
                text_boxes.append(box)
                fits = fits and (max(box.line_widths or [0]) <= box.w + .5
                                 and box.y >= region.y - .5
                                 and box.y + box.h <= region.y + region.h + .5)
        check('screenshot capacity: %s has its measured design fit' % label,
              bool(text_boxes) and fits == (length <= limit))
        errors = [issue for issue in built.errors if issue.slide == index]
        check('screenshot capacity: %s has its separate defect threshold' % label,
              bool(errors) == (length >= overflow)
              and all(issue.code == 'OVERFLOW' for issue in errors), repr(errors))
        if font_size is not None:
            check('screenshot capacity: %s keeps fixed typography' % label,
                  all(box.font_size == font_size for box in text_boxes))
        elif length == limit:
            check('screenshot capacity: %s stops at the legal headline floor' % label,
                  built.sizes[index - 1].headline == 72)


def test_screenshot_native_primitives(out_dir):
    """Contain retains a device viewport; annotations stay editable arcs."""
    import hashlib
    from deckkit.html2pptx.convert import write_pptx
    from deckkit.preview import render_file
    wide = os.path.join(out_dir, 'screen-wide.png')
    tall = os.path.join(out_dir, 'screen-tall.png')
    Image.new('RGBA', (400, 200), (220, 30, 40, 128)).save(wide)
    Image.new('RGB', (200, 400), (10, 120, 220)).save(tall)
    path = os.path.join(out_dir, 'screenshot-primitives.html')
    markup = '<html><head><link rel="stylesheet" href="%s"></head><body><div class="slide" style="background: #FFFFFF;">' % os.path.join(SKILL, 'assets/base.css')
    for index, (src, fit) in enumerate([(wide, 'contain'), (tall, 'contain'),
                                      (wide, 'cover')]):
        markup += '<img src="%s" style="position: absolute; left: %dpx; top: 100px; width: 200px; height: 200px; object-fit: %s; border-radius: 40px;">' % (src, 100 + index * 250, fit)
    markup += '<div data-connector="arc" data-connector-start="30" data-connector-end="140" data-connector-flip-h="true" style="position: absolute; left: 100px; top: 400px; width: 240px; height: 160px; --connector-color: #FF8800; --connector-width: 3px; --connector-head: arrow; --connector-head-width: lg; --connector-head-length: lg;"></div></div></body></html>'
    with open(path, 'w', encoding='utf-8') as stream:
        stream.write(markup)
    result = write_pptx(Document.open(path, extra_dirs=[SKILL]),
                        os.path.join(out_dir, 'screenshot-primitives.pptx'))
    ns = {'a': 'http://schemas.openxmlformats.org/drawingml/2006/main',
          'p': 'http://schemas.openxmlformats.org/presentationml/2006/main'}
    with zipfile.ZipFile(result) as archive:
        xml = etree.fromstring(archive.read('ppt/slides/slide1.xml'))
        media = [hashlib.sha256(archive.read(name)).hexdigest()
                 for name in archive.namelist() if name.startswith('ppt/media/')]
    pics = xml.findall('.//p:pic', ns)
    check('screen primitive: originals retained without flattened white margins',
          len(pics) == 3 and all(hashlib.sha256(open(src, 'rb').read()).hexdigest()
                                in media for src in (wide, tall)))
    check('screen primitive: contain picture viewport remains 200px square',
          all(pic.xpath('./p:spPr/a:xfrm/a:ext/@cx | ./p:spPr/a:xfrm/a:ext/@cy',
                        namespaces=ns) == ['1905000', '1905000'] for pic in pics[:2]))
    check('screen primitive: wide contain uses native vertical fill insets',
          dict(pics[0].find('./p:blipFill/a:stretch/a:fillRect', ns).attrib)
          == {'l': '0', 'r': '0', 't': '25000', 'b': '25000'}
          and not pics[0].xpath('./p:blipFill/a:srcRect', namespaces=ns))
    check('screen primitive: tall contain uses native horizontal fill insets',
          dict(pics[1].find('./p:blipFill/a:stretch/a:fillRect', ns).attrib)
          == {'l': '25000', 'r': '25000', 't': '0', 'b': '0'}
          and not pics[1].xpath('./p:blipFill/a:srcRect', namespaces=ns))
    check('screen primitive: cover preserves horizontal crop',
          pics[2].xpath('./p:blipFill/a:srcRect/@l | ./p:blipFill/a:srcRect/@r',
                        namespaces=ns) == ['25000', '25000'])
    check('screen primitive: contain and cover retain viewport rounded geometry',
          all(pic.xpath('./p:spPr/a:prstGeom/@prst', namespaces=ns) == ['roundRect']
              and pic.xpath('./p:spPr/a:prstGeom/a:avLst/a:gd/@fmla', namespaces=ns)
              == ['val 20000'] for pic in pics))
    arcs = xml.xpath('.//p:sp[p:spPr/a:prstGeom[@prst="arc"]]', namespaces=ns)
    check('screen primitive: annotation is one native editable arc',
          len(arcs) == 1
          and not xml.findall('.//p:cxnSp', ns)
          and arcs[0].find('./p:nvSpPr/p:cNvSpPr', ns) is not None
          and arcs[0].find('./p:spPr/a:noFill', ns) is not None
          and arcs[0].xpath('./p:spPr/a:prstGeom/@prst', namespaces=ns) == ['arc'])
    arc = arcs[0]
    check('screen primitive: arc keeps degree adjustments and local flips',
          arc.xpath('./p:spPr/a:prstGeom/a:avLst/a:gd/@name', namespaces=ns)
          == ['adj1', 'adj2']
          and arc.xpath('./p:spPr/a:prstGeom/a:avLst/a:gd/@fmla', namespaces=ns)
          == ['val 1800000', 'val 8400000']
          and arc.xpath('./p:spPr/a:xfrm/@flipH', namespaces=ns) == ['1']
          and not arc.xpath('./p:spPr/a:xfrm/@flipV', namespaces=ns))
    check('screen primitive: arc keeps native line pen and open large arrow',
          arc.xpath('./p:spPr/a:ln/@w', namespaces=ns) == ['28575']
          and arc.xpath('./p:spPr/a:ln/a:solidFill/a:srgbClr/@val', namespaces=ns)
          == ['FF8800']
          and dict(arc.find('./p:spPr/a:ln/a:tailEnd', ns).attrib)
          == {'type': 'arrow', 'w': 'lg', 'len': 'lg'})
    for scale in (1.0, 0.5):
        png = render_file(path, os.path.join(out_dir, 'screen-native-%s' % scale),
                          SKILL, scale=scale)[0]
        im = Image.open(png).convert('RGB')
        pixel = lambda x, y: im.getpixel((round(x * scale), round(y * scale)))
        check('screen primitive: contain margins and alpha survive scale %s' % scale,
              pixel(150, 120) == (255, 255, 255)
              and pixel(360, 200) == (255, 255, 255)
              and pixel(450, 200) == (10, 120, 220)
              and all(abs(a - b) <= 1 for a, b in zip(pixel(200, 200),
                                                     (237, 142, 147))))
        check('screen primitive: cover fills and clips the viewport at scale %s' % scale,
              pixel(602, 102) == (255, 255, 255)
              and all(abs(a - b) <= 1 for a, b in zip(pixel(650, 120),
                                                     (237, 142, 147))))


def test_picture_anchor_and_bottom_clip(out_dir):
    """Anchored originals crop natively before the viewport's bottom clip."""
    import hashlib
    from deckkit.html2pptx.assets import cover_crop, picture_fit
    from deckkit.html2pptx.convert import write_pptx
    from deckkit.preview import render_file
    src = os.path.join(out_dir, 'anchored-tall.png')
    image = Image.new('RGBA', (200, 800), (255, 0, 0, 128))
    image.paste((0, 255, 0, 128), (0, 0, 200, 100))
    image.save(src)
    wide = os.path.join(out_dir, 'anchored-wide.png')
    image = Image.new('RGBA', (400, 200), (0, 0, 255, 128))
    image.paste((255, 0, 255, 128), (200, 0, 400, 200))
    image.save(wide)
    check('picture anchor: top and bottom use opposite native crop edges',
          cover_crop(src, 200, 400, 'center top') == (0, 0, 0, .5)
          and cover_crop(src, 200, 400, '50% 0%') == (0, 0, 0, .5)
          and cover_crop(src, 200, 400, '50% 100%') == (0, .5, 0, 0))
    check('picture anchor: left and right use opposite native crop edges',
          cover_crop(wide, 200, 200, 'left center') == (0, 0, .5, 0)
          and cover_crop(wide, 200, 200, '0% 50%') == (0, 0, .5, 0)
          and cover_crop(wide, 200, 200, 'right center') == (.5, 0, 0, 0))
    check('picture anchor: clipping retains the original cover scale',
          picture_fit(src, 200, 400, 300, 'cover', '50% 0%')
          == ((0, 0, 0, .625), None))
    markup = '<html><head><link rel="stylesheet" href="%s"></head><body><div class="slide" style="background: #FFFFFF;">' % os.path.join(SKILL, 'assets/base.css')
    for left, boundary in [(100, 400), (400, 490)]:
        markup += '<img src="%s" data-clip-bottom="%d" style="position: absolute; left: %dpx; top: 100px; width: 200px; height: 400px; object-fit: cover; object-position: 50%% 0%%; border-radius: 40px;">' % (src, boundary, left)
    markup += '<img src="%s" data-clip-bottom="300" style="position: absolute; left: 700px; top: 100px; width: 200px; height: 400px; object-fit: contain; border-radius: 40px;">' % wide
    for left, position in [(1000, '50% 0%'), (1250, '50% 100%')]:
        markup += '<img src="%s" style="position: absolute; left: %dpx; top: 400px; width: 200px; height: 400px; object-fit: cover; object-position: %s;">' % (src, left, position)
    for left, position in [(1000, '0% 50%'), (1250, '100% 50%')]:
        markup += '<img src="%s" style="position: absolute; left: %dpx; top: 100px; width: 200px; height: 200px; object-fit: cover; object-position: %s;">' % (wide, left, position)
    markup += '</div></body></html>'
    path = os.path.join(out_dir, 'picture-anchor-clip.html')
    with open(path, 'w', encoding='utf-8') as stream:
        stream.write(markup)
    pptx = write_pptx(Document.open(path, extra_dirs=[SKILL]),
                      os.path.join(out_dir, 'picture-anchor-clip.pptx'))
    ns = {'a': 'http://schemas.openxmlformats.org/drawingml/2006/main',
          'p': 'http://schemas.openxmlformats.org/presentationml/2006/main'}
    with zipfile.ZipFile(pptx) as archive:
        xml = etree.fromstring(archive.read('ppt/slides/slide1.xml'))
        media = [hashlib.sha256(archive.read(name)).digest() for name in archive.namelist()
                 if name.startswith('ppt/media/')]
    pictures = xml.findall('.//p:pic', ns)
    check('picture clip: all seven anchored pictures stay native', len(pictures) == 7)
    check('picture clip: anchored images preserve original alpha media bytes',
          all(hashlib.sha256(open(source, 'rb').read()).digest() in media
              for source in (src, wide)))
    for index, (height, bottom, curves) in enumerate([(300, '62500', 2),
                                                    (390, '51250', 4)]):
        picture = pictures[index]
        check('picture clip: native clipped viewport %d preserves crop scale and mask' % (index + 1),
              picture.xpath('./p:spPr/a:xfrm/a:off/@y', namespaces=ns) == ['952500']
              and picture.xpath('./p:spPr/a:xfrm/a:ext/@cy', namespaces=ns)
              == (['2857500'] if height == 300 else ['3714750'])
              and picture.xpath('./p:blipFill/a:srcRect/@b', namespaces=ns) == [bottom]
              and len(picture.xpath('./p:spPr/a:custGeom/a:pathLst/a:path/a:cubicBezTo',
                                    namespaces=ns)) == curves)
        ys = picture.xpath('./p:spPr/a:custGeom/a:pathLst/a:path/*/a:pt/@y', namespaces=ns)
        check('picture clip: clipped native mask %d has no off-viewport path points' % (index + 1),
              bool(ys) and max(int(value) for value in ys)
              <= (2857500 if height == 300 else 3714750))
    check('picture clip: contain viewport clipping maps remaining content natively',
          pictures[2].xpath('./p:blipFill/a:srcRect/@b', namespaces=ns) == ['50000']
          and dict(pictures[2].find('./p:blipFill/a:stretch/a:fillRect', ns).attrib)
          == {'l': '0', 'r': '0', 't': '75000', 'b': '0'})
    for index, attribute, expected in [(3, 'b', '50000'), (4, 't', '50000'),
                                       (5, 'r', '50000'), (6, 'l', '50000')]:
        check('picture anchor: native picture %d keeps its requested crop edge' % (index + 1),
              pictures[index].xpath('./p:blipFill/a:srcRect/@%s' % attribute,
                                     namespaces=ns) == [expected])
    for scale in (1.0, .5):
        png = render_file(path, os.path.join(out_dir, 'anchor-preview-%s' % scale),
                          SKILL, scale=scale)[0]
        image = Image.open(png).convert('RGB')
        pixel = lambda x, y: image.getpixel((round(x * scale), round(y * scale)))
        check('picture clip: alpha and cut corners survive scale %s' % scale,
              pixel(200, 150) == (127, 255, 127)
              and pixel(200, 350) == (255, 127, 127)
              and pixel(200, 405) == (255, 255, 255)
              and pixel(101, 101) == (255, 255, 255)
              and pixel(402, 489) == (255, 255, 255)
              and pixel(750, 275) == (127, 127, 255)
              and pixel(800, 305) == (255, 255, 255))
        check('picture anchor: visible top/bottom and left/right content survives scale %s' % scale,
              pixel(1100, 450) == (127, 255, 127)
              and pixel(1350, 450) == (255, 127, 127)
              and pixel(1100, 200) == (127, 127, 255)
              and pixel(1350, 200) == (255, 127, 255))


def test_screenshot_options(out_dir):
    """Approved device layouts validate inputs before resources."""
    out_dir = os.path.realpath(out_dir)
    src = os.path.join(out_dir, 'screenshot-options.png')
    jpeg = os.path.join(out_dir, 'screenshot-options.jpg')
    gif = os.path.join(out_dir, 'screenshot-options.gif')
    corrupt = os.path.join(out_dir, 'screenshot-options-corrupt.png')
    for path in (src, jpeg, gif):
        Image.new('RGB', (320, 180), (40, 120, 180)).save(path)
    with open(corrupt, 'w', encoding='utf-8') as stream:
        stream.write('not an image')
    missing = os.path.join(out_dir, 'screenshot-options-missing.png')
    image = {'src': src, 'caption': 'Новый экран'}
    point = {'text': 'Вывод', 'icon': 'shield'}
    bases = {
        'screenshot-phone': {'title': 'Приложение', 'text': 'Обновили интерфейс',
                             'images': [image]},
        'screenshot-monitor': {'title': 'Рабочее место', 'src': src,
                               'points': [point]},
    }

    def via_spec(name, data, notes=None):
        return SP.deck_from_spec({'slides': [dict(data, layout=name, notes=notes)]},
                                 skill_dir=SKILL)

    def via_add(name, data, notes=None):
        return Deck(skill_dir=SKILL).add(name, data, notes=notes)

    def via_method(name, data, notes=None):
        deck = Deck(skill_dir=SKILL)
        if name == 'screenshot-phone':
            return deck.screenshot_phone(data['title'], data['text'], data['images'],
                                         fit=data.get('fit'), notes=notes)
        return deck.screenshot_monitor(data['title'], data['src'], data['points'],
                                       fit=data.get('fit'), notes=notes)

    routes = [('spec', via_spec), ('add', via_add), ('method', via_method)]
    for name, data in bases.items():
        accepted = SP.deck_from_spec({'slides': [dict(data, layout=name)]},
                                    skill_dir=SKILL)
        check('screenshots: %s is public in ordinary specs' % name,
              name not in L.DRAFT and len(accepted.slides) == 1)
    for label, route in routes:
        for name, field, maximum in [('screenshot-phone', 'images', 3),
                                      ('screenshot-monitor', 'points', 4)]:
            for count in range(1, maximum + 1):
                for fit in (None, 'contain', 'cover'):
                    item = image if field == 'images' else dict(point, icon='данные')
                    deck = route(name, dict(bases[name], **{
                        field: [dict(item) for _ in range(count)], 'fit': fit}),
                        notes='Заметка докладчика')
                    expected = ('screenshot-phone-%d' % count if field == 'images'
                                else 'screenshot-monitor')
                    check('screenshots: %s/%s selects count %d fit %s' %
                          (label, name, count, fit),
                          deck.slides[0].layout == expected
                          and len(deck.slides[0].data[field]) == count
                          and deck.slides[0].notes == 'Заметка докладчика')
        deck = route('screenshot-phone', dict(bases['screenshot-phone'],
                                             images=[{'src': jpeg}]))
        check('screenshots: %s accepts JPEG without annotation' % label,
              deck.slides[0].data['images'][0]['src'] == jpeg)

    invalid = []
    for name, base in bases.items():
        required = ('title', 'text') if name == 'screenshot-phone' else ('title', 'src')
        for key in required:
            omitted = dict(base)
            del omitted[key]
            invalid.append((name, omitted, key))
            for value in (None, '', '   ', 12, [], {}, '\\(x\\)'):
                invalid.append((name, dict(base, **{key: value}), key))
        invalid.append((name, dict(base, invented='ignored'), 'invented'))
        for value in ('stretch', '', 12, [], {}, True):
            invalid.append((name, dict(base, fit=value), 'fit'))
    for name, field, item, required, maximum in [
            ('screenshot-phone', 'images', image, ('src',), 3),
            ('screenshot-monitor', 'points', point, ('text', 'icon'), 4)]:
        for count, message in [(0, 'required'),
                               (maximum + 1, 'takes 1 to %d' % maximum)]:
            invalid.append((name, dict(bases[name], **{field: [dict(item)] * count}),
                            message))
        for value in ('xy', {'a': {}}, [12, None]):
            invalid.append((name, dict(bases[name], **{field: value}), 'object'))
        for key in required:
            omitted = dict(item)
            del omitted[key]
            invalid.append((name, dict(bases[name], **{field: [omitted]}), key))
            for value in (None, '', '   ', 12, [], {}, '\\(x\\)'):
                bad = dict(item, **{key: value})
                invalid.append((name, dict(bases[name], **{field: [bad]}), key))
        invalid.append((name, dict(bases[name], **{
            field: [dict(item, invented='ignored')]}), 'invented'))
    for value in (None, '', '   ', 12, [], {}, '\\(x\\)'):
        invalid.append(('screenshot-phone', dict(bases['screenshot-phone'],
                                                images=[dict(image, caption=value)]),
                        'caption'))
    for number, (name, data, expected) in enumerate(invalid, 1):
        for label, route in routes[:2]:
            try:
                route(name, data)
                message = ''
            except (SpecError, ValueError) as exc:
                message = str(exc)
            check('screenshots: %s rejects invalid case %d (%s)' %
                  (label, number, expected), expected in message,
                  message or 'accepted invalid input')

    for path, expected in [(missing, 'image not found'),
                           (corrupt, 'not a readable image'),
                           (gif, 'unsupported image format')]:
        for name, base in bases.items():
            data = (dict(base, images=[dict(image, src=path)])
                    if name == 'screenshot-phone' else dict(base, src=path))
            for label, route in routes:
                try:
                    route(name, data)
                    message = ''
                except (SpecError, MediaError) as exc:
                    message = str(exc)
                check('screenshots: %s/%s rejects source %s' % (label, name, expected),
                      expected in message, message or 'accepted invalid source')
    for name, field, maximum in [('screenshot-phone', 'images', 3),
                                  ('screenshot-monitor', 'points', 4)]:
        data = dict(bases[name])
        if field == 'images':
            data[field] = [{'src': missing}] * (maximum + 1)
        else:
            data.update(src=missing, points=[{'text': 'Вывод', 'icon': 'unknown_xyz'}]
                        * (maximum + 1))
        deck = Deck(skill_dir=SKILL)
        try:
            deck.add(name, data)
            message = ''
        except ValueError as exc:
            message = str(exc)
        check('screenshots: %s count precedes source/icon lookup' % name,
              'takes 1 to %d' % maximum in message and len(deck) == 0
              and deck.allocator.get_deck_usage() == {}, message)
    _raises('screenshots: monitor refuses missing icon', ValueError, 'icon',
            lambda: via_add('screenshot-monitor', dict(bases['screenshot-monitor'],
                                                       points=[{'text': 'Вывод'}])))
    _raises('screenshots: monitor refuses invented icon', IconNotFound, 'no icon matched',
            lambda: via_add('screenshot-monitor', dict(bases['screenshot-monitor'],
                                                       points=[dict(point, icon='unknown_xyz')])))
    for name, base in bases.items():
        for data in (None, [], 'invalid'):
            _raises('screenshots: %s refuses non-object API data' % name,
                    ValueError, 'must be an object',
                    lambda: via_add(name, data))
        for field in ('layout', 'notes'):
            _raises('screenshots: %s refuses reserved API field %s' % (name, field),
                    ValueError, 'argument to Deck.add',
                    lambda: via_add(name, dict(base, **{field: 'ignored'})))
        for label, route in routes:
            _raises('screenshots: %s/%s refuses non-text speaker notes' % (label, name),
                    (SpecError, ValueError), 'notes',
                    lambda: route(name, base, notes=123))
    previous_cwd = os.getcwd()
    try:
        os.chdir(out_dir)
        for label, route in routes:
            for name, base in bases.items():
                data = (dict(base, images=[{'src': os.path.basename(src)}])
                        if name == 'screenshot-phone'
                        else dict(base, src=os.path.basename(src)))
                deck = route(name, data)
                actual = (deck.slides[0].data['images'][0]['src']
                          if name == 'screenshot-phone' else deck.slides[0].data['src'])
                check('screenshots: %s/%s resolves relative source once' % (label, name),
                      actual == src, actual)
    finally:
        os.chdir(previous_cwd)


def test_image_frame_output(out_dir):
    """Accepted image frames are public; only wide images remain parked."""
    src = os.path.join(out_dir, 'draft-gallery.png')
    Image.new('RGB', (1920, 1080), (20, 120, 180)).save(src)
    items = [dict(src=src, title='Запуск', text='Короткая подпись', icon=icon)
             for icon in ('rocket', 'shield', 'users')]
    slides = [dict(layout='image-points', title='Итоги', src=src,
                   look=look, points=[dict(text='Вывод', icon='shield')])
              for look in ('plate', 'plates')]
    slides += [dict(layout='image-wide', title='Итоги', src=src, look=look)
               for look in ('plate', 'plates')]
    slides += [dict(layout='image-gallery', title='Итоги', images=items[:n])
               for n in (2, 3)]
    for slide in slides:
        try:
            SP.deck_from_spec({'slides': [slide]}, skill_dir=SKILL)
            refused = False
        except SpecError:
            refused = True
        check('image gate: %s has its approved public status' % slide['layout'],
              refused == (slide['layout'] == 'image-wide'))
    built = SP.deck_from_spec({'slides': slides}, skill_dir=SKILL,
                              _allow_draft=True).build(
        os.path.join(out_dir, 'image-gate-drafts'), strict=False, keep_html=True)
    check('image gate: all prototype frames fit', not built.errors, repr(built.issues))
    check('image gate: gallery literal ceilings',
          [s.pair for s in built.sizes[-2:]] == [(44, 30), (40, 28)])
    doc = Document.open(built.html_path, extra_dirs=[SKILL])
    last = []
    for root in list(doc.boxes())[:2]:
        rows = [b for b in root.walk() if 'chart-side' in b.classes()]
        last.append(rows[0].y + rows[0].h)
    check('image gate: shared points stay 96px above bottom',
          all(abs(y-984) < 0.01 for y in last), repr(last))
    with zipfile.ZipFile(built.pptx_path) as archive:
        xml = etree.fromstring(archive.read('ppt/slides/slide6.xml'))
    ns = {'a': 'http://schemas.openxmlformats.org/drawingml/2006/main',
          'p': 'http://schemas.openxmlformats.org/presentationml/2006/main'}
    check('image gate: each gallery picture has its curved native notch',
          len(xml.xpath('.//p:pic/p:spPr/a:custGeom', namespaces=ns)) == 3
          and len(xml.xpath('.//p:pic/p:spPr/a:custGeom//a:cubicBezTo', namespaces=ns)) == 18)
    with zipfile.ZipFile(built.pptx_path) as archive:
        for slide_number in (5, 6):
            gallery = etree.fromstring(archive.read('ppt/slides/slide%d.xml' % slide_number))
            background = gallery.find('./p:cSld/p:spTree/p:sp', ns)
            check('image gate: gallery %d paints white before text and pictures' % slide_number,
                  background is not None
                  and background.xpath('./p:spPr/a:solidFill/a:srgbClr/@val', namespaces=ns) == ['FFFFFF']
                  and background.xpath('./p:spPr/a:xfrm/a:off/@x | ./p:spPr/a:xfrm/a:off/@y', namespaces=ns) == ['0', '0']
                  and background.xpath('./p:spPr/a:xfrm/a:ext/@cx | ./p:spPr/a:xfrm/a:ext/@cy', namespaces=ns) == ['18288000', '10287000'])
    for look in ('steps', 'tilt'):
        try:
            SP.deck_from_spec({'slides': [dict(slides[0], look=look)]},
                             skill_dir=SKILL, _allow_draft=True)
            refused = False
        except SpecError:
            refused = True
        check('image gate: user-retired %s look refused' % look, refused)
    for field, value in [('src', 12), ('icon', None), ('data', {})]:
        bad = dict(items[0], **{field: value})
        try:
            SP.deck_from_spec({'slides': [dict(layout='image-gallery', title='Итоги',
                                               images=[bad, items[1]])]},
                             skill_dir=SKILL, _allow_draft=True)
            refused = False
        except SpecError:
            refused = True
        check('image gate: invalid gallery %s refused' % field, refused)


def test_image_capacity(out_dir):
    """Pin measured image text boundaries, independently of design constants."""
    src = os.path.join(out_dir, 'image-capacity.png')
    Image.new('RGB', (1920, 1080), (20, 120, 180)).save(src)
    phrase = 'обслуживание клиентов и партнёров банка в едином окне '
    icons = ('shield', 'rocket', 'users', 'star', 'рост')

    def text(n):
        return (phrase * (n // len(phrase) + 1))[:n]

    def points(count, look, body):
        return dict(layout='image-points', title='Заголовок слайда',
                    src=src, look=look,
                    points=[dict(text=body, icon=icons[i]) for i in range(count)])

    def gallery(count, body, title='Подзаголовок карточки'):
        return dict(layout='image-gallery', title='Заголовок слайда',
                    images=[dict(src=src, title=title, text=body, icon=icons[i])
                            for i in range(count)])

    def build(slide, name):
        deck = SP.deck_from_spec({'slides': [slide]}, skill_dir=SKILL)
        return deck.build(os.path.join(out_dir, 'capacity-' + name),
                          strict=False, pptx=False, keep_html=True)

    def rejects(slide, name, advice):
        deck = SP.deck_from_spec({'slides': [slide]}, skill_dir=SKILL)
        try:
            deck.build(os.path.join(out_dir, 'capacity-strict-' + name),
                       strict=True, pptx=False)
            rejected = False
        except BuildError as exc:
            message = str(exc)
            rejected = any(i.level == 'error' and i.code == 'OVERFLOW'
                           for i in exc.issues) and advice in message
        check('image capacity: strict refusal advises %s (%s)' % (advice, name),
              rejected)

    # Literal limits measured using this phrase, equal text in every point.
    # The two media looks share their left-column geometry and fixed 28px body.
    for count, limit in ((1, 685), (2, 329), (5, 105)):
        for look in ('plate', 'plates'):
            name = '%d-%s' % (count, look)
            good = build(points(count, look, text(limit)), name + '-good')
            bad_slide = points(count, look, text(limit + 1))
            bad = build(bad_slide, name + '-bad')
            check('image capacity: point prose boundary %s' % name,
                  good.sizes[0].fits and not good.errors
                  and any(i.code == 'OVERFLOW' for i in bad.errors))
            doc = Document.open(good.html_path, extra_dirs=[SKILL])
            bodies = [b for b in doc.box(1).walk() if 'chart-point-text' in b.classes()]
            check('image capacity: points keep 28px body and 473px width (%s)' % name,
                  len(bodies) == count
                  and all(b.style.get('font-size') == '28px' and abs(b.w - 473) < .01
                          and max(b.line_widths) <= 473.5 for b in bodies))
            rejects(bad_slide, name, 'points')
    for look in ('plate', 'plates'):
        good = build(points(2, look, 'Ж' * 21), 'point-word-' + look + '-good')
        bad_slide = points(2, look, 'Ж' * 22)
        bad = build(bad_slide, 'point-word-' + look + '-bad')
        check('image capacity: fixed-size point word overflow (%s)' % look,
              not good.errors and any(i.code == 'OVERFLOW' for i in bad.errors))
        rejects(bad_slide, 'point-word-' + look, 'shorten the word')

    # The design predicate holds the caption to 190px (+0.5px). The defect
    # reporter allows <8px protrusion; the fifth body line extends it by 5.2px.
    for count, limit, overflow, width in ((2, 367, 462, 874.417),
                                        (3, 224, 279, 565.206)):
        good = build(gallery(count, text(limit)), 'gallery-%d-good' % count)
        first_unfit = build(gallery(count, text(limit + 1)),
                            'gallery-%d-unfit' % count)
        bad_slide = gallery(count, text(overflow))
        bad = build(bad_slide, 'gallery-%d-overflow' % count)
        check('image capacity: gallery %d distinguishes design fit and defect' % count,
              good.sizes[0].pair == (36, 20) and good.sizes[0].fits
              and not good.errors and not first_unfit.sizes[0].pair_fits
              and first_unfit.sizes[0].pair == (32, 20) and not first_unfit.errors
              and bad.sizes[0].pair == (32, 20)
              and any(i.code == 'OVERFLOW' for i in bad.errors))
        doc = Document.open(good.html_path, extra_dirs=[SKILL])
        captions = [b for b in doc.box(1).walk() if 'gallery-caption' in b.classes()]
        titles = [b for b in doc.box(1).walk() if 'card-subtitle' in b.classes()]
        bodies = [b for b in doc.box(1).walk() if 'card-description' in b.classes()]
        check('image capacity: gallery %d has shared caption sizes and bounds' % count,
              len(captions) == len(titles) == len(bodies) == count
              and all(abs(b.h - 190) < .01 and abs(b.w - width) < .01 for b in captions)
              and all(b.style.get('font-size') == '36px' for b in titles)
              and all(b.style.get('font-size') == '20px' for b in bodies))
        floor_doc = Document.open(bad.html_path, extra_dirs=[SKILL])
        floor_titles = [b for b in floor_doc.box(1).walk()
                        if 'card-subtitle' in b.classes()]
        floor_bodies = [b for b in floor_doc.box(1).walk()
                        if 'card-description' in b.classes()]
        check('image capacity: gallery %d keeps literal 32/20 floor in saved HTML' % count,
              len(floor_titles) == len(floor_bodies) == count
              and all(b.style.get('font-size') == '32px' for b in floor_titles)
              and all(b.style.get('font-size') == '20px' for b in floor_bodies))
        rejects(bad_slide, 'gallery-%d-body' % count, 'images')
        for field, word_length in (('title', 33 if count == 2 else 22),
                                   ('body', 56 if count == 2 else 36)):
            word_slide = gallery(count, 'Короткое описание', title='Подзаголовок карточки')
            for item in word_slide['images']:
                item['title' if field == 'title' else 'text'] = 'Ж' * word_length
            result = build(word_slide, 'gallery-%d-word-%s' % (count, field))
            check('image capacity: gallery %d unbroken %s fails at floor' % (count, field),
                  result.sizes[0].pair == (32, 20)
                  and any(i.code == 'OVERFLOW' for i in result.errors))
            rejects(word_slide, 'gallery-%d-word-%s' % (count, field), 'images')


def test_media_slides_through_spec(out_dir):
    """image/chart slides go through deck_from_spec and the real template
    fragments end to end, not a hand-built Box tree like the two tests above.
    """
    from PIL import Image
    from pptx import Presentation
    from pptx.enum.chart import XL_CHART_TYPE

    # A stock asset image would be 16:9, far enough from the panel's ~6:5 to
    # trip IMAGE_ASPECT - synthesize one that matches so the build is clean.
    image_src = os.path.join(out_dir, 'media-image.png')
    Image.new('RGB', (1064, 900), (200, 200, 200)).save(image_src)
    csv_path = os.path.join(out_dir, 'media-chart.csv')
    with open(csv_path, 'w', encoding='utf-8') as f:
        f.write('quarter,revenue\nQ1,10\nQ2,20\nQ3,30\n')

    spec = {'slides': [
        {'layout': 'title', 'text': 'Медиаслайды'},
        {'layout': 'image', 'title': 'Фото', 'src': image_src,
         'note_icon': 'идея', 'note': 'Контекст к картинке',
         'caption': 'Подпись под изображением'},
        {'layout': 'chart', 'title': 'Рост выручки', 'data': csv_path,
         'x': 'quarter', 'y': 'revenue', 'chart_type': 'line',
         'chart_title': 'Диаграмма роста',
         'points': [{'text': 'Рост выручки за квартал', 'icon': 'рост'}]},
        {'layout': 'final'},
    ]}
    # image is status='draft' (layouts.DRAFT), held back from spec authoring
    # until a designer template lands - this test exercises the real
    # implementation end to end regardless, via the same escape hatch a
    # re-enable would use. chart is public since v2.0.
    deck = SP.deck_from_spec(spec, skill_dir=SKILL, _allow_draft=True)
    check('media spec builds to deck', len(deck) == 4, '%d slides' % len(deck))

    result = deck.build(os.path.join(out_dir, 'media-spec'), strict=True)
    check('media spec builds without warnings', not result.warnings,
          '; '.join(str(i) for i in result.warnings))
    check('media spec builds to PPTX',
          result.pptx_path and os.path.isfile(result.pptx_path))
    if not (result.pptx_path and os.path.isfile(result.pptx_path)):
        return

    slides = Presentation(result.pptx_path).slides
    pictures = [s for s in slides[1].shapes
               if s.shape_type is not None and 'PICTURE' in str(s.shape_type)]
    check('image slide from spec carries a picture', len(pictures) >= 1,
          '%d' % len(pictures))

    charts = [s for s in slides[2].shapes if s.has_chart]
    check('chart slide from spec carries a real chart shape', len(charts) == 1,
          '%d' % len(charts))
    if charts:
        check('chart slide from spec picked the "line" type',
              charts[0].chart.chart_type == XL_CHART_TYPE.LINE,
              str(charts[0].chart.chart_type))


def test_media_image_relative_src(out_dir):
    """A relative `src` must still reach the slide as a picture.

    `media.resolve_image` checks the path from the caller's cwd; the paint
    step's `AssetResolver.resolve` checks it relative to the built HTML's own
    directory instead. The image above (an absolute path) never crosses that
    seam - this test's whole point is a `src` that is only valid from a cwd
    neither of those two directories is.
    """
    from PIL import Image
    from pptx import Presentation

    image_dir = tempfile.mkdtemp(prefix='deckselftest-relsrc-')
    try:
        Image.new('RGB', (1064, 900), (60, 120, 200)).save(
            os.path.join(image_dir, 'relative-media.png'))

        old_cwd = os.getcwd()
        os.chdir(image_dir)
        try:
            spec = {'slides': [
                {'layout': 'title', 'text': 'Относительный путь'},
                {'layout': 'image', 'title': 'Фото',
                 'src': 'relative-media.png'},
                {'layout': 'final'},
            ]}
            deck = SP.deck_from_spec(spec, skill_dir=SKILL, _allow_draft=True)
            result = deck.build(os.path.join(out_dir, 'media-relative'),
                                strict=True)
        finally:
            os.chdir(old_cwd)
    finally:
        shutil.rmtree(image_dir, ignore_errors=True)

    check('relative src builds without warnings', not result.warnings,
          '; '.join(str(i) for i in result.warnings))
    check('relative src builds to PPTX',
          result.pptx_path and os.path.isfile(result.pptx_path))
    if not (result.pptx_path and os.path.isfile(result.pptx_path)):
        return

    slides = Presentation(result.pptx_path).slides
    pictures = [s for s in slides[1].shapes
               if s.shape_type is not None and 'PICTURE' in str(s.shape_type)]
    check('relative src image slide carries a picture', len(pictures) >= 1,
          '%d' % len(pictures))


# ------------------------------------------------------------- spec

def test_spec_rejects_mistakes():
    """Typos and invalid values are caught before build."""
    cases = [
        ('unknown layout',
         {'slides': [{'layout': 'таблица', 'title': 'з'}]}),
        ('field typo',
         {'slides': [{'layout': 'agenda', 'titel': 'з', 'items': ['a', 'b']}]}),
        ('missing required field',
         {'slides': [{'layout': 'cards', 'cards': [{'title': 'a'}]}]}),
        ('unknown card field',
         {'slides': [{'layout': 'cards', 'title': 'з',
                      'cards': [{'title': 'a', 'color': 'red'}]}]}),
        ('number instead of string',
         {'slides': [{'layout': 'metrics', 'title': 'з',
                      'metrics': [{'value': 38, 'text': 'рост'}]}]}),
        ('empty slides list', {'slides': []}),
        ('wrong card count in grid',
         {'slides': [{'layout': 'grid', 'title': 'з',
                      'cards': [{'title': str(i)} for i in range(5)]}]}),
        ('nonexistent icon',
         {'slides': [{'layout': 'cards', 'title': 'з',
                      'cards': [{'title': 'a', 'icon': 'абракадабра-которой-нет'}]}]}),
        # I1: a chart point without an icon is rejected (the designer forbids
        # an icon-less point).
        ('chart point without icon',
         {'slides': [{'layout': 'chart', 'title': 'з',
                      'data': {'categories': ['A'],
                               'series': [{'name': 's', 'values': [1]}]},
                      'chart_type': 'bar',
                      'points': [{'text': 'Вывод'}]}]}),
        # image is implemented (see AGENTS.md "Images and charts (v1.6)")
        # but status='draft' holds it out of spec authoring pending a
        # designer template - layouts.DRAFT. A normal spec must see it as
        # unknown, same as a typo, not as some other error that hints it
        # half-exists. (chart left draft in v2.0.)
        ('draft layout "image"',
         {'slides': [{'layout': 'image', 'title': 'з', 'src': 'x.png'}]}),
    ]
    for name, spec in cases:
        try:
            SP.deck_from_spec(spec, skill_dir=SKILL)
            check('spec rejects: %s' % name, False, 'no error')
        except SpecError:
            check('spec rejects: %s' % name, True)


def test_icon_enforcement_cases():
    """evals/icon-enforcement.json runs, instead of merely describing rules."""
    path = os.path.join(SKILL, 'evals', 'icon-enforcement.json')
    check('evals/icon-enforcement.json exists', os.path.isfile(path), path)
    if not os.path.isfile(path):
        return
    with open(path, 'r', encoding='utf-8') as f:
        suite = json.load(f)
    cases = suite.get('cases') or []
    check('icon-enforcement suite is not empty', bool(cases))

    # The suite described rules but nobody executed it: the file sat with
    # "bullets with optional icon" long after the field became required.
    # A paper check goes stale silently, so here every case runs through
    # the same path as a build.
    for case in cases:
        name = case.get('name') or '(unnamed)'
        rel = case.get('file')
        spec_path = os.path.join(SKILL, 'evals', rel) if rel else None
        if not spec_path or not os.path.isfile(spec_path):
            check('eval %s: fixture exists' % name, False, rel)
            continue
        try:
            deck = SP.deck_from_spec(SP.load_spec(spec_path), skill_dir=SKILL)
            error = None
        except SpecError as exc:
            deck, error = None, str(exc)
        if case.get('expect_error'):
            check('eval %s: rejected' % name, error is not None, 'built fine')
            wanted = case.get('error_contains')
            if error is not None and wanted:
                check('eval %s: names the reason' % name, wanted in error,
                      'expected %r in %r' % (wanted, error[:120]))
        else:
            check('eval %s: builds' % name, error is None, error)
        if deck is not None and case.get('expect_distinct_icons'):
            worst = ''
            for index, slide in enumerate(deck.slides, 1):
                icons = VD.icons_of(slide)
                if len(set(icons)) != len(icons):
                    worst = 'slide %d: %s' % (index, ', '.join(icons))
                    break
            check('eval %s: allocator gave distinct icons' % name, not worst,
                  worst)


def test_formula_enforcement_cases(out_dir):
    """The formula eval suite executes through spec, layout and PPTX output."""
    path = os.path.join(SKILL, 'evals', 'formula-enforcement.json')
    check('evals/formula-enforcement.json exists', os.path.isfile(path), path)
    if not os.path.isfile(path):
        return
    with open(path, 'r', encoding='utf-8') as f:
        cases = (json.load(f).get('cases') or [])
    check('formula-enforcement suite is not empty', bool(cases))

    for case in cases:
        name = case.get('name') or '(unnamed)'
        spec_path = os.path.join(SKILL, 'evals', case.get('file', ''))
        if not os.path.isfile(spec_path):
            check('formula eval %s: fixture exists' % name, False, spec_path)
            continue
        error = None
        result = None
        try:
            deck = SP.deck_from_spec(SP.load_spec(spec_path), skill_dir=SKILL)
            result = deck.build(os.path.join(out_dir, name), strict=True)
        except (SpecError, BuildError) as exc:
            error = str(exc)
        if case.get('expect_error'):
            check('formula eval %s: rejected' % name, error is not None,
                  'built fine')
            wanted = case.get('error_contains')
            if error is not None and wanted:
                check('formula eval %s: names reason' % name,
                      wanted in error, error[:180])
            continue
        check('formula eval %s: builds' % name, error is None, error)
        if result is None or not result.pptx_path:
            continue
        with zipfile.ZipFile(result.pptx_path) as archive:
            parts = [archive.read(part) for part in archive.namelist()
                     if re.match(r'ppt/slides/slide\d+\.xml$', part)]
        slides = b'\n'.join(parts)
        has_math = b'<a14:m' in slides and b'<m:oMath' in slides
        check('formula eval %s: math expectation' % name,
              has_math == bool(case.get('expect_math')),
              'has_math=%s' % has_math)
        if not case.get('expect_math'):
            continue
        ns = {'a': FM.A_NS, 'a14': FM.A14_NS, 'm': FM.M_NS}
        roots = [etree.fromstring(part) for part in parts]
        wrappers = [node for root in roots
                    for node in root.xpath('.//a:p/a14:m', namespaces=ns)]
        check('formula pptx: all equations are inline paragraph children',
              len(wrappers) >= 15, '%d' % len(wrappers))
        constructs = {tag: sum(len(root.xpath('.//m:' + tag, namespaces=ns))
                               for root in roots)
                      for tag in ('f', 'nary', 'func', 'sSub', 'sSup', 'rad',
                                  'd', 'bar')}
        check('formula pptx: structural subset reaches OMML',
              all(constructs.values()), repr(constructs))
        rprs = [node for root in roots
                for node in root.xpath('.//a14:m//a:rPr', namespaces=ns)]
        bad = [node for node in rprs
               if not node.get('sz')
               or not node.xpath('./a:solidFill/a:srgbClr', namespaces=ns)
               or not node.xpath('./a:latin[@typeface="Cambria Math"]',
                                 namespaces=ns)
               or not node.xpath('./a:ea', namespaces=ns)
               or not node.xpath('./a:cs', namespaces=ns)]
        check('formula pptx: every run and control is directly styled',
              bool(rprs) and not bad, '%d of %d bad' % (len(bad), len(rprs)))
        placeholders = [node for root in roots
                        for node in root.xpath(
                            './/m:f/m:num[not(*)] | '
                            './/m:f/m:den[not(*)] | '
                            './/m:sSub/m:e[not(*)] | '
                            './/m:sSub/m:sub[not(*)] | '
                            './/m:sSup/m:e[not(*)] | '
                            './/m:sSup/m:sup[not(*)] | '
                            './/m:sSubSup/m:e[not(*)] | '
                            './/m:sSubSup/m:sub[not(*)] | '
                            './/m:sSubSup/m:sup[not(*)] | '
                            './/m:nary/m:sub[not(*)] | '
                            './/m:nary/m:sup[not(*)] | '
                            './/m:nary/m:e[not(*)] | '
                            './/m:rad/m:deg[not(*)] | '
                            './/m:rad/m:e[not(*)] | '
                            './/m:func/m:fName[not(*)] | '
                            './/m:func/m:e[not(*)] | '
                            './/m:d/m:e[not(*)] | '
                            './/m:bar/m:e[not(*)] | '
                            './/m:acc/m:e[not(*)]', namespaces=ns)]
        check('formula pptx: mandatory formula arguments are populated',
              not placeholders, '%d empty arguments' % len(placeholders))
        plain_roots = [node for root in roots
                       for node in root.xpath(
                           './/m:rad[m:radPr/m:degHide[@m:val="on"]]',
                           namespaces=ns)]
        check('formula pptx: plain root uses canonical degHide',
              bool(plain_roots), '%d' % len(plain_roots))
        math_text = ''.join(node.text or '' for root in roots
                            for node in root.xpath('.//a14:m//m:t', namespaces=ns))
        expected_tokens = case.get('math_tokens', [])
        check('formula pptx %s: expected operators and glyphs survive' % name,
              bool(expected_tokens) and all(token in math_text for token in expected_tokens),
              math_text[:180])


def _formula_authoring_inventory():
    """Literal intent ledger; never derive these expectations from the writer.

    Each row names a JSON field and its unique prose anchor. Equation tuples
    hold source, visible operands, structural counts and critical arguments.
    """
    return [
        (2, ('cards', 0, 'text'), 'Доля:', [
            (r'p=\frac{k}{n}', 'p=kn', {'f': 1}, {'f/num': 'k', 'f/den': 'n'})]),
        (3, ('cards', 0, 'items', 0), 'Сумма:', [
            (r'S=\sum_{i=1}^{n}x_i', 'S=i=1nxi', {'nary': 1, 'sSub': 1},
             {'nary/sub': 'i=1', 'nary/sup': 'n', 'nary/e': 'xi'})]),
        (3, ('cards', 0, 'items', 1), 'Произведение:', [
            (r'P=\prod_{i=1}^{n}x_i', 'P=i=1nxi', {'nary': 1, 'sSub': 1},
             {'nary/sub': 'i=1', 'nary/sup': 'n', 'nary/e': 'xi'})]),
        (4, ('cards', 0, 'text'), 'Интеграл:', [
            (r'A=\int_0^1 x^2\,dx', 'A=01x2dx', {'nary': 1, 'sSup': 1},
             {'nary/sub': '0', 'nary/sup': '1', 'nary/e': 'x2dx'})]),
        (4, ('cards', 1, 'text'), 'Корень:', [
            (r'r=\sqrt{x}', 'r=x', {'rad': 1}, {'rad/e': 'x'})]),
        (5, ('columns', 0, 'text'), 'Индекс:', [
            (r'x_i', 'xi', {'sSub': 1}, {'sSub/e': 'x', 'sSub/sub': 'i'})]),
        (5, ('columns', 1, 'text'), 'Степень:', [
            (r'x^2', 'x2', {'sSup': 1}, {'sSup/e': 'x', 'sSup/sup': '2'})]),
        (5, ('columns', 2, 'text'), 'Параметры:', [
            (r'\alpha+\beta=\theta', 'α+β=θ', {}, {})]),
        (6, ('points', 0, 'text'), 'Вход:', [(r'x_1', 'x1', {'sSub': 1}, {})]),
        (6, ('points', 1, 'text'), 'Оценка:', [(r'\bar{x}', 'x', {'bar': 1}, {})]),
        (6, ('points', 2, 'text'), 'Выход:', [(r'y_1', 'y1', {'sSub': 1}, {})]),
        (7, ('steps', 0, 'text'), 'Данные:', [(r'x_i', 'xi', {'sSub': 1}, {})]),
        (7, ('steps', 1, 'text'), 'Норма:', [(r'\left|x\right|', 'x', {'d': 1}, {})]),
        (7, ('steps', 2, 'text'), 'Логарифм:', [(r'\log x', 'logx', {'func': 1}, {})]),
        (7, ('steps', 3, 'text'), 'Результат:', [(r'y_i', 'yi', {'sSub': 1}, {})]),
        (8, ('metrics', 0, 'text'), 'Корреляция:', [(r'\rho', 'ρ', {}, {})]),
        (8, ('metrics', 1, 'text'), 'Среднее:', [(r'\mu', 'μ', {}, {})]),
        (8, ('metrics', 2, 'text'), 'Разброс:', [(r'\sigma', 'σ', {}, {})]),
        (9, ('cards', 0, 'text'), 'Сначала', [
            (r'a_i', 'ai', {'sSub': 1}, {}), (r'b^2', 'b2', {'sSup': 1}, {})])]


def _formula_inventory_errors(roots, inventory):
    """Verify slide/field/order/operands, also on a desktop-saved scratch copy."""
    import unicodedata
    ns = {'a': FM.A_NS, 'a14': FM.A14_NS, 'm': FM.M_NS,
          'p': 'http://schemas.openxmlformats.org/presentationml/2006/main'}

    def normal(text):
        return ''.join(unicodedata.normalize('NFKC', text).split()).replace('\u200b', '')

    def tokens(node):
        return normal(''.join(node.xpath('.//m:t/text()', namespaces=ns)))

    errors = []
    totals = collections.Counter()
    structures = ('f', 'nary', 'rad', 'sSub', 'sSup', 'sSubSup', 'bar', 'acc', 'd', 'func')
    for slide, field, anchor, expected in inventory:
        label = 'slide %d %s' % (slide, field)
        totals[slide] += len(expected)
        shapes = roots[slide - 1].xpath('.//p:sp[p:txBody]', namespaces=ns)
        found = [s for s in shapes if normal(anchor) in normal(
            ''.join(s.xpath('./p:txBody//a:t/text()', namespaces=ns)))]
        if len(found) != 1:
            errors.append(label + ': prose anchor not unique/present')
            continue
        equations = found[0].xpath('./p:txBody/a:p/a14:m/m:oMath', namespaces=ns)
        if len(equations) != len(expected):
            errors.append(label + ': equation count')
        for equation, (latex, text, counts, arguments) in zip(equations, expected):
            if tokens(equation) != text:
                errors.append(label + ': ordered operands ' + latex)
            got = {tag: len(equation.xpath('.//m:' + tag, namespaces=ns))
                   for tag in structures}
            if {tag: count for tag, count in got.items() if count} != counts:
                errors.append(label + ': structure ' + latex)
            for path, text in arguments.items():
                nodes = equation.xpath('.//' + '/'.join('m:' + tag for tag in path.split('/')),
                                       namespaces=ns)
                if len(nodes) != 1 or tokens(nodes[0]) != text:
                    errors.append(label + ': argument ' + path)
            # PowerPoint omits the default integral character when saving.
            # Normalize each n-ary separately, never a missing sum/product.
            symbols = [node.xpath('string(./m:naryPr/m:chr/@m:val)', namespaces=ns) or '∫'
                       for node in equation.xpath('.//m:nary', namespaces=ns)]
            wanted = ('∑' if r'\sum' in latex else '∏' if r'\prod' in latex
                      else '∫' if r'\int' in latex else None)
            if symbols != ([wanted] if wanted else []):
                errors.append(label + ': operator ' + latex)
    for slide, root in enumerate(roots, 1):
        if len(root.xpath('.//m:oMath', namespaces=ns)) != totals[slide]:
            errors.append('slide %d: exact equation total' % slide)
    return errors


def test_formula_authoring(out_dir):
    """Intent → decoded JSON → field-bound OMML, not a deck-wide count > 0."""
    import copy
    spec = SP.load_spec(os.path.join(SKILL, 'evals/files/formula-authoring.json'))
    original = copy.deepcopy(spec)
    inventory = _formula_authoring_inventory()
    for slide, path, anchor, equations in inventory:
        value = spec['slides'][slide - 1]
        for key in path:
            value = value[key]
        check('formula authoring: JSON field %d %s' % (slide, path),
              [v for kind, v in FM.parse_inline(value) if kind == 'math']
              == [e[0] for e in equations] and anchor in value)
    deck = SP.deck_from_spec(spec, skill_dir=SKILL)
    result = deck.build(os.path.join(out_dir, 'formula-authoring'), strict=True)
    warnings = [i for i in result.issues if i.code == 'UNTAGGED_MATH']
    check('formula authoring: three advisory warnings only on slide 10',
          len(warnings) == 3 and all(i.level == 'warning' and i.slide == 10
                                    for i in warnings))
    check('formula authoring: input is not rewritten', spec == original)
    with zipfile.ZipFile(result.pptx_path) as z:
        roots = [etree.fromstring(z.read('ppt/slides/slide%d.xml' % i))
                 for i in range(1, 13)]
    errors = _formula_inventory_errors(roots, inventory)
    check('formula authoring: all 20 equations in their 19 intended fields',
          not errors, repr(errors))
    ns = {'a': FM.A_NS, 'm': FM.M_NS}
    for slide, fragments in ((9, ('Сначала', ', затем', ', после них виден весь текст.',
                                  'Новая строка также сохраняется.')),
                             (10, ('Индекс x_i = 2', 'Var(X) = 1', 'Артикул A_1')),
                             (11, ('$5', '$12', '+15%', '×2', '5 мс', '2 + 3 = 5'))):
        text = ''.join(roots[slide - 1].xpath('.//a:t/text()', namespaces=ns)).replace('\xa0', ' ')
        check('formula authoring: prose survives on slide %d' % slide,
              all(fragment in text for fragment in fragments), text)


def test_large_technical_deck(out_dir):
    """Mixed long-deck acceptance retains math, diagram edges and cycle lint."""
    import copy
    import hashlib
    from PIL import ImageDraw

    source = SP.load_spec(os.path.join(SKILL, 'evals/files/formula-authoring.json'))
    slides = copy.deepcopy(source['slides'][:-1])
    for index in range(12):
        kind = 'cards' if index % 3 == 2 else 'columns'
        field = 'cards' if kind == 'cards' else 'columns'
        item = {'title': 'Проверка', 'text': 'Содержание тестового примера сохранено.'}
        if kind == 'cards':
            item['icon'] = 'аналитика'
        items = [dict(item), dict(item), dict(item)]
        if kind == 'cards':
            for point, icon in zip(items, ('данные', 'время', 'результат')):
                point['icon'] = icon
        slides.append({'layout': kind, 'title': 'Разбираем пример %d' % (index + 1),
                       field: items})

    image_hashes = []
    for name, dimensions in [('wide', (1200, 400)), ('tall', (400, 1200))]:
        image = Image.new('RGB', dimensions, 'white')
        draw = ImageDraw.Draw(image)
        w, h = dimensions
        for corner, colour in [((0, 0), 'red'), ((w-40, 0), 'green'),
                               ((0, h-40), 'blue'), ((w-40, h-40), 'black')]:
            x, y = corner
            draw.rectangle((x, y, x+39, y+39), fill=colour)
        path = os.path.join(out_dir, 'technical-' + name + '.png')
        image.save(path)
        with open(path, 'rb') as handle:
            image_hashes.append(hashlib.sha256(handle.read()).hexdigest())
        slides.append({'layout': 'image-points', 'title': 'Схема сохраняет края',
                       'src': path, 'fit': 'contain', 'look': 'plate',
                       'points': [{'icon': 'данные',
                                   'text': 'Все четыре крайних метки остаются.'},
                                  {'icon': 'анализ',
                                   'text': 'Источник остаётся неизменным.'}]})
    slides.append({'layout': 'final'})
    spec = {'title': 'Technical acceptance', 'slides': slides}
    untouched = copy.deepcopy(spec)
    result = SP.deck_from_spec(spec, skill_dir=SKILL).build(
        os.path.join(out_dir, 'large-technical'), strict=True, keep_html=True)
    check('technical corpus: 26 slides build without rewriting',
          result.slides == 26 and spec == untouched and not result.errors)
    check('technical corpus: short cycles remain advisory',
          any(i.code == 'LAYOUT_CONCENTRATION' and i.level == 'warning'
              and 11 <= i.slide <= 14 for i in result.issues))
    check('technical corpus: both diagram empty margins are reported',
          sorted(i.slide for i in result.issues if i.code == 'IMAGE_LETTERBOX')
          == [24, 25])
    with zipfile.ZipFile(result.pptx_path) as archive:
        roots = [etree.fromstring(archive.read('ppt/slides/slide%d.xml' % i))
                 for i in range(1, 27)]
        members = [hashlib.sha256(archive.read(n)).hexdigest()
                   for n in archive.namelist() if n.startswith('ppt/media/')]
    check('technical corpus: original diagram bytes embedded',
          all(value in members for value in image_hashes))
    errors = _formula_inventory_errors(roots, _formula_authoring_inventory())
    check('technical corpus: all 20 field-bound equations survive the long deck',
          not errors, repr(errors))
    ns = {'a': FM.A_NS}
    for number in (24, 25):
        crop = roots[number - 1].xpath('.//a:srcRect', namespaces=ns)
        check('technical corpus: contain retains edges on slide %d' % number,
              all(all(int(v) == 0 for v in node.attrib.values()) for node in crop),
              repr([dict(node.attrib) for node in crop]))

    # Literal headline from the historical technical corpus; no private file
    # is needed to reproduce the accepted two-line cover boundary.
    long_cover = SP.deck_from_spec({'slides': [
        {'layout': 'title',
         'text': 'Causalis: от проверки корректности к расширению причинного анализа',
         'subtitle': 'Математика, архитектура, evidence и границы B01–B30'},
        {'layout': 'final'}]}, skill_dir=SKILL)
    rejected = long_cover.build(os.path.join(out_dir, 'technical-long-cover'),
                                strict=False, pptx=False, keep_html=True)
    check('technical corpus: crowded cover is rejected, never emitted as PPTX',
          rejected.pptx_path is None and
          any(i.code == 'OVERFLOW' and i.level == 'error' and i.slide == 1
              for i in rejected.issues))


def test_untagged_math():
    """High-confidence signals and deliberate false-positive/negative limits."""
    positive = [r'Доля \frac{k}{n}', r'Сумма \sum_i x_i', '∑ x', '∫ x dx',
                '√x', 'x_i = 2', 'x^2', 'x_{ij}', 'β_i', 'Var(X) = 1',
                'Cov(X,Y)=0', 'E[X] = 1', 'Артикул A_1']
    negative = ['$5 млн → $12 млн', '+15%', '×2', '5 мс', '2 + 3 = 5',
                'x + y = z', '2026-10-11', 'user_id', 'feature_x_i',
                '`x_i`', '`Var(X)=1`', 'https://host/x_i?q=x^2',
                '/tmp/x_i.json', r'C:\work\x_i.csv',
                r'Доля \(p=\frac{k}{n}\)', r'\(x_i\) и \(x^2\)',
                r'Var(X)\(x_i\)=1', r'\(\)']
    for text in positive:
        check('untagged math: signal %r' % text, VD._untagged_math(text) is not None)
    for text in negative:
        check('untagged math: prose/explicit/code %r' % text,
              VD._untagged_math(text) is None)
    deck = Deck(skill_dir=SKILL)
    deck.cards('Индекс x_i', [Card('Проверка', 'Текст x_i', 'аналитика')])
    deck.title('Индекс x_i')
    found = [i for i in VD.check_deck(deck) if i.code == 'UNTAGGED_MATH']
    check('untagged math: API titles/body name correct field and remedy',
          len(found) == 3 and all(i.level == 'warning' for i in found)
          and 'cards[].text' in found[0].message
          and 'cards 1.text' in found[1].message
          and 'choose a layout' in found[2].message)


def test_formula_prohibited_fields():
    """Every non-body path rejects an intentional formula in the JSON API."""
    slides = [
        {'layout': 'agenda', 'title': 'План',
         'items': ['Раз', 'Два \\(x\\)']},
        {'layout': 'statement', 'text': 'Тезис \\(x\\)'},
        {'layout': 'final', 'text': 'Финал \\(x\\)'},
        {'layout': 'cards', 'title': 'Карточка',
         'cards': [{'title': 'Заголовок \\(x\\)', 'text': 'Текст',
                    'icon': 'данные'}]},
        {'layout': 'timeline', 'title': 'Этапы',
         'points': [{'title': 'Шаг \\(x\\)', 'text': 'Раз'},
                    {'title': 'Шаг', 'text': 'Два'},
                    {'title': 'Шаг', 'text': 'Три'}]},
        {'layout': 'flow', 'title': 'Поток',
         'steps': [{'icon': 'данные', 'text': 'Раз'},
                   {'icon': 'таблица', 'text': 'Два'},
                   {'icon': 'расчет', 'text': 'Три'},
                   {'icon': 'результат', 'text': 'Четыре'}],
         'summary': {'title': 'Итог', 'text': 'Формула \\(x\\)'}},
    ]
    # The path within the slide, not prefixed by the layout: the message
    # already opens with `slide N (layout)`, and repeating it there produced
    # `field "metrics.metrics[].value"`.
    expected = ('items[]', 'text', 'text',
                'cards[].title', 'points[].title', 'summary.text')
    for slide, path in zip(slides, expected):
        label = '%s.%s' % (slide['layout'], path)
        try:
            SP.deck_from_spec({'slides': [slide]}, skill_dir=SKILL)
            check('formula prohibited: %s' % label, False, 'no error')
        except SpecError as exc:
            check('formula prohibited: %s' % label,
                  'field "%s"' % path in str(exc), str(exc))


def test_layout_runs():
    """Four slides of one layout in a row warn; `bullets` is refused with the fix.

    The ten 40-slide decks of tmp_files/layout-repeat-research ran `cards` five
    to ten slides long by holding the layout and changing the card count, so
    the run is counted on the layout the spec named, not the physical variant.
    Charts of different types are different pictures and do not form a run.
    """
    def card(n):
        return {'title': 'Карточка %d' % n, 'icon': 'данные', 'text': 'Текст'}

    def chart(kind):
        return {'layout': 'chart', 'title': 'График', 'chart_type': kind,
                'data': {'categories': ['А', 'Б'],
                         'series': [{'name': 'Ряд', 'values': [1, 2]}]},
                'points': [{'text': 'Вывод', 'icon': 'рост'}]}

    def runs(middle):
        spec = {'slides': [{'layout': 'title', 'text': 'Проверка'}] + middle
                + [{'layout': 'final'}]}
        deck = SP.deck_from_spec(spec, skill_dir=SKILL)
        return [(i.slide, i.message) for i in VD.check_deck(deck)
                if i.code == 'REPEATED_LAYOUT']

    cards = [{'layout': 'cards', 'title': 'Слайд', 'cards':
              [card(k) for k in range(1, n + 1)]} for n in (1, 3, 1, 2)]
    found = runs(cards)
    check('layout run: four cards slides with changing counts warn once',
          [slide for slide, _ in found] == [2], str(found))
    check('layout run: the message names the slides and the layout',
          found and found[0][1].startswith('slides 2-5 are all "cards"'),
          str(found))
    check('layout run: three in a row do not warn', runs(cards[:3]) == [],
          str(runs(cards[:3])))
    mixed = [chart('bar'), chart('line'), chart('line'), chart('bar')]
    check('layout run: charts of different types are not a run',
          runs(mixed) == [], str(runs(mixed)))
    check('layout run: four line charts are',
          [s for s, _ in runs([chart('line')] * 4)] == [2],
          str(runs([chart('line')] * 4)))

    try:
        SP.deck_from_spec({'slides': [
            {'layout': 'bullets', 'title': 'Список', 'card_title': 'Что',
             'icon': 'данные', 'items': ['Раз', 'Два']}]}, skill_dir=SKILL)
        problem = ''
    except SpecError as exc:
        problem = str(exc)
    check('bullets: refused with the one-card rewrite',
          'folded into "cards"' in problem
          and '"cards": [{"title": ..., "icon": ..., "items": [...]}]' in problem,
          problem)


def test_layout_concentration():
    """Literal thresholds, exclusions, ranges and chart/count/look semantics."""
    def findings(slides):
        deck = Deck(skill_dir=SKILL)
        deck.slides = slides
        return VD._check_layout_mix(deck)

    def slides(names):
        return [Slide(name, {}) for name in names]

    cycle = slides(['title'] + ['columns-3', 'columns-4', 'cards-2'] * 4
                   + ['final'])
    found = findings(cycle)
    check('layout mix: short cycle gives deck and window advisories',
          [i.code for i in found] == ['LAYOUT_DOMINANCE', 'LAYOUT_CONCENTRATION']
          and all(i.level == 'warning' for i in found), str(found))
    check('layout mix: original IDs, counts and first peak are literal',
          len(found) == 2 and found[0].slide == 2
          and '8/12 content slides (66.7%' in found[0].message
          and 'slides 2, 3, 5, 6, 8, 9, 11, 12.' in found[0].message
          and 'windows in slides 2-12' in found[1].message
          and 'peak window slides 2-11 has 7/10' in found[1].message,
          str(found))
    check('layout mix: changing count does not disguise a family',
          bool(found) and '"columns"' in found[0].message, str(found))
    check('layout mix: nine content slides stay quiet',
          findings(slides(['columns-3'] * 9)) == [])
    check('layout mix: exactly half and six in ten stay quiet',
          findings(slides(['columns-3', 'cards-2'] * 5)) == [])
    six = findings(slides(['columns-3'] * 6 + ['cards-2'] * 4))
    check('layout mix: over half warns, exactly six in ten does not',
          [i.code for i in six] == ['LAYOUT_DOMINANCE']
          and '6/10 content slides (60.0%' in six[0].message, str(six))
    check('layout mix: extra title/agenda/final do not dilute or qualify',
          findings(slides(['title', 'agenda'] * 5 + ['columns-3'] * 9
                          + ['final'])) == []
          and [i.message for i in findings(cycle + slides(['agenda', 'final']))]
          == [i.message for i in found])
    local = findings(slides(['columns-3'] * 7 + ['cards-2'] * 3
                            + ['metrics-3col', 'timeline-3'] * 5))
    check('layout mix: local hotspot without deck majority is detected',
          [i.code for i in local] == ['LAYOUT_CONCENTRATION']
          and local[0].slide == 1
          and 'windows in slides 1-10' in local[0].message
          and '7/10' in local[0].message, str(local))
    separated = findings(slides(
        ['columns-3'] * 7 + ['cards-2'] * 3
        + ['timeline-3', 'metrics-3col'] * 10
        + ['columns-4'] * 7 + ['cards-3'] * 3))
    check('layout mix: disjoint hotspots retain separate ranges',
          [i.slide for i in separated] == [1, 28]
          and all(i.code == 'LAYOUT_CONCENTRATION' for i in separated),
          str([(i.slide, i.message) for i in separated]))
    looks = [Slide('flow-4' if i % 2 else 'flow-5-zigzag',
                   {'look': 'line' if i % 2 else 'zigzag'}) for i in range(10)]
    check('layout mix: changing look stays one family',
          any('"flow" carries 10/10' in i.message for i in findings(looks)))
    charts = [Slide('chart-points', {'chart_type': kind})
              for kind in ['line', 'bar'] * 5]
    check('layout mix: distinct chart types remain distinct',
          findings(charts) == [])
    pair = [Slide('chart-two', {'charts': [{'chart_type': a}, {'chart_type': b}]})
            for a, b in [('bar', 'line'), ('line', 'bar')] * 5]
    check('layout mix: two-chart ordered types remain distinct',
          findings(pair) == [])
    specialized = findings([Slide('chart-points', {'chart_type': 'line'})
                            for _ in range(10)])
    check('layout mix: specialized uniform deck remains advisory',
          len(specialized) == 2 and all(i.level == 'warning' for i in specialized)
          and all('specialized deck may retain' in i.message
                  and 'quota' in i.message for i in specialized))
    with_agenda = slides(['columns-3'] * 7 + ['agenda']
                        + ['cards-2'] * 3 + ['metrics-3col', 'timeline-3'] * 5)
    gap = findings(with_agenda)
    check('layout mix: framing gap preserves original range and IDs',
          len(gap) == 1 and 'peak window slides 1-11 has 7/10' in gap[0].message)
    check('layout mix: empty deck is safe', findings([]) == [])


def test_element_kinds(deck):
    """Each element kind answers for itself, without building a deck.

    Until 2.1 an element's fields sat in spec.py, its shape and icons in
    deck.py and its icons again in validate.py; the copies drifted. The kind
    in elements.py is now the one place, so it is tested as one.
    """
    problems = []
    E.CARD.check([{'title': 'Т', 'icon': 'рост', 'colour': 'red'},
                  {'text': 'без заголовка'}], 'slide 2 (cards)', problems)
    check('kind: unknown field named with the element',
          any('card 1: unknown field "colour"' in p for p in problems), problems)
    check('kind: missing required field named',
          any('card 2: the "icon" field is required' in p for p in problems),
          problems)

    problems = []
    E.POINT.check([{'text': 'а', 'title': 'А'}, {'text': 'б'}],
                  'slide 3 (timeline)', problems)
    check('kind: cross-field rule runs after the elements',
          problems == ['slide 3 (timeline): either every point has a "title" '
                       'or none does - 1 of 2 have one'], problems)

    problems = []
    E.SUMMARY.check('текст', 'slide 4 (flow)', problems)
    check('kind: a single-object field is checked as one object',
          problems and 'summary 1: must be an object' in problems[0], problems)

    deck.allocator.begin_slide()
    steps = E.STEP.normalise([{'icon': 'рост', 'text': 'а'},
                              {'icon': 'рост', 'text': 'б'}], deck.allocator)
    icons = E.STEP.icons_of(steps)
    check('kind: normalise resolves icons, unique within the slide',
          len(icons) == 2 and len(set(icons)) == 2 and icons[0].endswith('.png'),
          icons)
    cards = E.CARD.normalise([{'title': 'Т', 'icon': 'цель'}], deck.allocator)
    check('kind: a card normalises to a Card', isinstance(cards[0], Card),
          repr(cards))
    check('kind: icons read back from objects as well as dicts',
          E.CARD.icons_of(cards) == [cards[0].icon], E.CARD.icons_of(cards))

    flow = L.PUBLIC['flow']
    check('layout: formula paths follow from the kinds',
          flow.formula_paths() == {'steps[].text'}, flow.formula_paths())
    check('layout: icon-free elements give no paths or icons',
          L.PUBLIC['chart-cards'].formula_paths() == set()
          and not L.PUBLIC['chart-cards'].has_icons())


def test_icon_checks_cover_every_kind():
    """Repeated icons are reported on every element that carries one.

    `validate._icons_of` read `cards` only, so a flow or chart deck with the
    same icon on every slide built without a word, and a chart slide with
    three identical point icons built clean.
    """
    def flow(icon):
        return {'layout': 'flow', 'title': 'Процесс',
                'steps': [{'icon': icon, 'text': 'Шаг %d' % n}
                          for n in range(1, 5)]}

    def chart(points):
        return {'layout': 'chart', 'title': 'График', 'chart_type': 'bar',
                'data': {'categories': ['А', 'Б'],
                         'series': [{'name': 'Ряд', 'values': [1, 2]}]},
                'points': points}

    def codes(middle):
        spec = {'slides': [{'layout': 'title', 'text': 'Проверка'}] + middle
                + [{'layout': 'final'}]}
        deck = SP.deck_from_spec(spec, skill_dir=SKILL)
        return sorted(set(i.code for i in VD.check_deck(deck)))

    found = codes([flow('рост'), flow('рост')])
    check('icons: a step icon repeated on the adjacent slide warns',
          'SAME_ICON' in found, found)
    point = {'text': 'Вывод', 'icon': 'рост'}
    found = codes([chart([point]), flow('цель')] * 4)
    check('icons: a chart point icon counts toward REPEATED_ICON',
          'REPEATED_ICON' in found, found)
    # An exact file name bypasses the allocator's exclusions by design.
    same = {'text': 'Вывод', 'icon': 'check'}
    found = codes([chart([same, same, same])])
    check('icons: identical point icons on one slide are an error',
          'DUPLICATE_ICON' in found, found)


def test_formula_author_fixes(out_dir):
    """The first-build formula failures of the v1.9 stress test stay fixed.

    Twenty formula-heavy decks (skill-test/v1.9-formula-test) stumbled on the
    same few things before their first clean build: a bare `*` for an optimum,
    `\\ne`, a formula pasted into JSON with single backslashes, a formula in a
    field that takes none, and a too-wide formula whose advice named bullets on
    a layout that has none. Each is pinned here by its literal outcome.
    """
    # A bare star is TeX's \ast, for both consumers. The mathtext source is
    # pinned whole: without the trailing space `x*y` would read as `\asty`.
    for latex, source in ((r'x^*', '{x}^{\\ast }'), (r'x*y', 'x\\ast y')):
        try:
            omath, got = FM.validate(latex)
            xml = etree.tostring(omath, encoding='unicode')
            check('formula star: %s is set as U+2217' % latex,
                  '∗' in xml and '*' not in xml, xml[:160])
            check('formula star: %s reaches mathtext as \\ast' % latex,
                  got == source, repr(got))
        except FormulaError as exc:
            check('formula star: %s accepted' % latex, False, str(exc))
    try:
        omath, got = FM.validate(r'a \ne b')
        check('formula: \\ne is \\neq',
              '≠' in etree.tostring(omath, encoding='unicode'), got)
    except FormulaError as exc:
        check('formula: \\ne is \\neq', False, str(exc))

    # Single backslashes are a JSON error, not a formula one; the message has
    # to say which, and only when the escape is what failed.
    bad = os.path.join(out_dir, 'single-backslash.json')
    with open(bad, 'w', encoding='utf-8') as f:
        f.write('{"slides": [{"layout": "statement", "text": "\\(x\\)"}]}')
    comma = os.path.join(out_dir, 'trailing-comma.json')
    with open(comma, 'w', encoding='utf-8') as f:
        f.write('{"slides": [],}')
    for path, wanted in ((bad, True), (comma, False)):
        try:
            SP.load_spec(path)
            check('json hint: %s rejected' % os.path.basename(path), False)
        except SpecError as exc:
            check('json hint: %s %s the doubled backslash'
                  % (os.path.basename(path), 'names' if wanted else 'omits'),
                  ('\\\\(' in str(exc)) == wanted, str(exc))

    # A rejected field names where the formula can go instead.
    metrics = {'layout': 'metrics', 'title': 'Итоги', 'metrics': [
        {'value': '\\(x\\)', 'text': 'Раз'}, {'value': '2', 'text': 'Два'},
        {'value': '3', 'text': 'Три'}]}
    statement = {'layout': 'statement', 'text': 'Тезис \\(x\\)'}
    for slide, wanted in ((metrics, 'formulas go in "metrics[].text"'),
                          (statement, 'this layout takes no formulas')):
        try:
            SP.deck_from_spec({'slides': [slide]}, skill_dir=SKILL)
            check('formula field hint: %s' % slide['layout'], False)
        except SpecError as exc:
            check('formula field hint: %s' % slide['layout'],
                  wanted in str(exc), str(exc))

    # The width advice has to work on a layout without bullets: on flow-4 the
    # whole sum needs ~550 px of a 368 px column, each half ~280 px.
    terms = ['x_{%d}' % i for i in range(1, 7)]
    whole = '\\(S=' + '+'.join(terms) + '\\)'
    halves = ('\\(S=' + '+'.join(terms[:3]) + '\\) \\(+'
              + '+'.join(terms[3:]) + '\\)')
    for name, text in (('whole', whole), ('halves', halves)):
        steps = [{'icon': 'рост', 'text': 'Сумма ' + text},
                 {'icon': 'команда', 'text': 'Короткий шаг'},
                 {'icon': 'безопасность', 'text': 'Короткий шаг'},
                 {'icon': 'аналитика', 'text': 'Короткий шаг'}]
        deck = SP.deck_from_spec({'slides': [
            {'layout': 'flow', 'title': 'Процесс', 'steps': steps}]},
            skill_dir=SKILL)
        result = deck.build(os.path.join(out_dir, 'formula-split-' + name),
                            strict=False, pptx=False)
        errors = [issue for issue in result.issues if issue.level == 'error']
        if name == 'whole':
            wide = [i for i in errors if i.code == 'FORMULA_TOO_WIDE']
            check('formula width: flow reports the whole sum', bool(wide),
                  str([str(i) for i in errors]))
            check('formula width: advice is two formulas, not bullets',
                  all('two \\(...\\) formulas' in i.message
                      and 'bullet' not in i.message for i in wide),
                  str([str(i) for i in wide]))
        else:
            check('formula width: the split sum builds clean', not errors,
                  str([str(i) for i in errors]))


def test_formula_errors_are_all_reported(out_dir):
    """One build names every bad formula, not just the first one it meets.

    A formula-heavy deck used to need one build per mistake: `render_html`
    raised on the first `FormulaError` it saw. The markers now carry their own
    rejection (`fragments.set_text_formula`) and `render_html` collects them,
    so this asserts on the count and on the field each one names.
    """
    spec = {'slides': [
        {'layout': 'cards', 'title': 'Первый', 'cards': [
            {'title': 'Список', 'icon': 'данные',
             'items': ['Плохая \\(\\zzz\\)',
                       'Тоже плохая \\(\\underbrace{x}_{y}\\)']}]},
        {'layout': 'cards', 'title': 'Второй', 'cards': [
            {'icon': 'данные', 'title': 'Раз',
             'text': 'Ещё \\(\\text{кириллица}\\)'},
            {'icon': 'таблица', 'title': 'Два', 'text': 'Хорошая \\(x^2\\)'}]},
    ]}
    try:
        deck = SP.deck_from_spec(spec, skill_dir=SKILL)
        deck.build(os.path.join(out_dir, 'formula-errors'), strict=True)
        check('formula errors: build refuses', False, 'built fine')
        return
    except BuildError as exc:
        issues = [i for i in exc.issues if i.code == 'FORMULA']
    check('formula errors: all three reported at once',
          len(issues) == 3, '%d of 3' % len(issues))
    check('formula errors: slides are named',
          sorted(i.slide for i in issues) == [1, 1, 2],
          repr(sorted(i.slide for i in issues)))
    text = '\n'.join(i.message for i in issues)
    for wanted in ('bullet-text', 'card-description', r'\zzz',
                   r'\underbrace', 'Cyrillic'):
        check('formula errors: message carries %s' % wanted,
              wanted in text, text[:200])


def test_bullet_marker_follows_a_tall_line(out_dir):
    """A formula on a bullet's first line takes the marker down with it.

    `_apply_marker` runs inside the size search, before any per-line geometry
    exists, so it can only place the marker against the ladder's nominal line
    box. A tall formula grows the line and moves the text baseline; without
    the second pass the marker stays where plain prose would have put it,
    which is what the v1.8 PowerPoint export showed. Two things are asserted,
    and the second is the one that catches an over-broad fix: the formula
    bullet moves, and its plain neighbour on the same slide does not.
    """
    sizes = {}

    def markers(items, name):
        spec = {'slides': [
            {'layout': 'title', 'text': 'Проверка маркера', 'subtitle': 'x'},
            {'layout': 'cards', 'title': 'Маркеры', 'cards': [
                {'title': 'Список', 'icon': 'данные', 'items': items}]},
            {'layout': 'final'}]}
        deck = SP.deck_from_spec(spec, skill_dir=SKILL)
        base = os.path.join(out_dir, name)
        deck.build(base, strict=False, pptx=False, keep_html=True)
        with open(base + '.html', 'r', encoding='utf-8') as f:
            html = f.read()
        found = re.search(r'class="bullet-text"[^>]*font-size:\s*(\d+)px', html)
        sizes[name] = float(found.group(1)) if found else 0.0
        return [int(v) for v in re.findall(
            r'class="bullet"[^>]*style="[^"]*margin-top:\s*(-?\d+)px', html)]

    plain = markers(['Обычный текст без формулы', 'Второй пункт'], 'mk-plain')
    tall = markers(['Дробь \\(\\frac{a}{b}\\) в строке', 'Второй пункт'],
                   'mk-tall')
    check('bullet marker: both decks have two markers',
          len(plain) == 2 and len(tall) == 2, '%r %r' % (plain, tall))
    if len(plain) != 2 or len(tall) != 2:
        return
    check('bullet marker: a tall first line moves its own marker down',
          tall[0] > plain[0], 'tall %d vs plain %d' % (tall[0], plain[0]))
    check('bullet marker: a plain neighbour is left where it was',
          tall[1] == plain[1], 'tall %d vs plain %d' % (tall[1], plain[1]))

    # A formula too short to grow the line still moves the marker, and by a
    # known amount: it puts Cambria Math on the line, whose line descent is
    # deeper than T-Sans's, so the baseline drops by exactly the difference.
    # The measured export agrees — fourteen such bullets all sat about 2px
    # lower than a model without the floor. Pinning the exact delta rather than
    # a direction is what separates this from the bug it replaced, where the
    # shift was an accident of treating a line differently the moment it held
    # a MathRun, with no number behind it.
    short = markers(['Короткая \\(x_i\\) в строке', 'Второй пункт'],
                    'mk-short')
    size = sizes.get('mk-short', 0.0)
    if len(short) == 2 and size:
        # 0.0766 em is Cambria Math's line descent (0.2222 typo + 0.1724 gap)
        # less T-Sans's 0.318, and it is written out here rather than read from
        # MATH_LINE_DESCENT_EM on purpose. A check that computes its
        # expectation from the constant it is checking passes for every value
        # of that constant — verified: zeroing the constant left this test
        # green until the number was stated independently.
        floor = 0.0766 * size
        check('bullet marker: a short inline formula moves the line by the '
              'math font descent, and by no more',
              abs((plain[0] - short[0]) - floor) <= 1.0,
              'short %d vs plain %d, floor %.1f at %.0fpx'
              % (short[0], plain[0], floor, size))


def test_spec_accepts_example():
    """Example from assets builds without errors."""
    path = os.path.join(SKILL, 'assets', 'example-deck.json')
    check('example spec exists', os.path.isfile(path), path)
    if not os.path.isfile(path):
        return
    deck = SP.deck_from_spec(SP.load_spec(path), skill_dir=SKILL)
    check('example builds to deck', len(deck) == 7, '%d slides' % len(deck))


def test_example_plan_matches_spec():
    """The example plans and the example spec describe the same deck.

    `assets/example-plan.md` is the shape of the plan step: a working document
    the build never reads. That is exactly why it can rot — nothing downstream
    would notice. So the one thing it and the spec both state, the slide list,
    is compared here. Change either file's slides and this fails, naming both.

    Both forms are checked — the detailed plan of the "agree first" branch and
    the short plan of the "straight away" one. They are the same deck told at
    two depths, and a branch whose example has drifted is the branch nobody
    reads twice.
    """
    spec_path = os.path.join(SKILL, 'assets', 'example-deck.json')
    plan_paths = [os.path.join(SKILL, 'assets', 'example-plan.md'),
                  os.path.join(SKILL, 'assets', 'example-plan-quick.md')]
    for plan_path in plan_paths:
        check('example plan exists', os.path.isfile(plan_path), plan_path)
    if not (os.path.isfile(spec_path)
            and all(os.path.isfile(p) for p in plan_paths)):
        return
    with open(spec_path, 'r', encoding='utf-8') as f:
        spec = json.load(f)
    actual = [slide['layout'] for slide in spec['slides']]
    for plan_path in plan_paths:
        # The slide list is the only numbered list in the file whose items open
        # with a backticked word, so this picks it out without parsing headings.
        # The detailed form hangs its drafted text off sub-bullets, which do not
        # start a numbered item and so cannot be mistaken for a slide.
        planned = re.findall(r'^\d+\.\s+`(\w+)`', read_text(plan_path),
                             re.MULTILINE)
        check('%s lists every slide of the example spec'
              % os.path.basename(plan_path),
              planned == actual,
              'plan: %s / spec: %s' % (', '.join(planned) or '(none found)',
                                       ', '.join(actual)))

    # The plan step sits before the spec is written, and that order is the
    # whole point of it — a renumbering that moved it after would leave the
    # instruction intact and the point gone.
    skill = read_text(os.path.join(SKILL, 'SKILL.md'))
    plan_at = skill.find('Settle the plan')
    spec_at = skill.find('**Write the spec**')
    check('SKILL.md: the plan step comes before the spec step',
          0 <= plan_at < spec_at, 'plan at %d, spec at %d' % (plan_at, spec_at))


def test_docs_match_code():
    """Documentation and implementation describe the same layout set."""
    doc = os.path.join(SKILL, 'references', 'layouts.md')
    if not os.path.isfile(doc):
        check('references/layouts.md exists', False, doc)
        return
    with open(doc, 'r', encoding='utf-8') as f:
        text = f.read()
    # Draft layouts (status='draft') are implemented but deliberately
    # undocumented for spec authors (see AGENTS.md "Images and charts
    # (v1.6)") - the doc/code guard below only applies to what a spec can
    # actually reach.
    for layout in sorted(set(SP.LAYOUTS) - L.DRAFT):
        check('layout %s documented in references/layouts.md' % layout,
              ('"%s"' % layout) in text or ('`%s`' % layout) in text)

    # A slide example in the reference is what an author copies. The v2.0
    # chart example sat there without its required points: every block that
    # is one slide object has to pass the spec as written.
    for block in re.findall(r'```json\n(.*?)```', text, re.S):
        try:
            slide = json.loads(block)
        except ValueError:
            continue
        if not isinstance(slide, dict) or 'layout' not in slide:
            continue
        try:
            SP.deck_from_spec({'slides': [slide]}, skill_dir=SKILL)
            problem = ''
        except SpecError as exc:
            problem = str(exc)
        check('layouts.md example %s passes the spec' % slide['layout'],
              not problem, problem[:300])

    mentioned = set(re.findall(r'`(title|agenda|cards|grid|bullets|complex|'
                               r'pyramid|statement|metrics|final|timeline|'
                               r'flow|columns|image|chart)`', text))
    unknown = mentioned - set(SP.LAYOUTS)
    check('no layouts in docs missing from code', not unknown,
          ', '.join(sorted(unknown)))

    # Numbers in documentation go stale silently: "162 business concepts"
    # survived the dictionary growing to 253 in both files at once because
    # nobody recounted it. Since the number is named, let the check hold it.
    counts = {}
    for name, path in (('index', ('assets', 'icons', 'INDEX.json')),
                       ('concepts', ('assets', 'icons', 'CONCEPTS.json'))):
        with open(os.path.join(SKILL, *path), 'r', encoding='utf-8') as f:
            raw = json.load(f)
        if name == 'index':
            counts[name] = len(raw.get('icons') or raw.get('иконки') or raw)
        else:
            counts[name] = len(raw.get('concepts') or raw.get('концепты') or {})
    pattern = re.compile(r'(\d+)\s*\n?\s*icons plus a layer of (\d+) '
                         r'business concepts')
    for rel in ('SKILL.md', os.path.join('references', 'layouts.md')):
        path = os.path.join(SKILL, rel)
        with open(path, 'r', encoding='utf-8') as f:
            body = f.read()
        found = pattern.search(body)
        check('%s states the icon and concept counts' % rel, bool(found),
              'the "N icons plus a layer of M business concepts" sentence '
              'is gone or reworded - update this check with it')
        if found:
            check('%s: icon count is current (%s)' % (rel, found.group(1)),
                  int(found.group(1)) == counts['index'],
                  'documented %s, actual %d' % (found.group(1),
                                                counts['index']))
            check('%s: concept count is current (%s)' % (rel, found.group(2)),
                  int(found.group(2)) == counts['concepts'],
                  'documented %s, actual %d' % (found.group(2),
                                                counts['concepts']))


# ------------------------------------------------------------ conventions

# SKILL-CONVENTIONS.md, sections 2, 3, 5, 8 and 9. Only the rules a machine
# can decide live here. Whether the description is a good activation signal,
# whether the procedure is the right size, whether the strictness is calibrated
# — those stay a reading matter and are not faked with a check.
#
# What ships is this directory alone: everything at repo level (README,
# AGENTS.md, PROGRESS.md, skill-test/) is development material. So the walk
# starts at SKILL, and the file limit is counted from here — counting the whole
# tree is what once produced a phantom "422 files".

FILE_LIMIT = 200
PACKAGE_DIRS = ('assets', 'evals', 'references', 'scripts')
ROOT_DEV_DOCS = ('readme', 'changelog', 'history', 'todo', 'notes', 'worklog',
                 'progress', 'agents', 'setup', 'publishing', 'contributing')
TEXT_SUFFIXES = ('.md', '.py', '.json', '.css', '.html', '.txt', '.yml', '.js',
                 '.sh')

# The forbidden patterns are assembled from fragments instead of written out.
# This file ships inside the package and is scanned along with the rest — by
# the check below and by the marketplace's own scanner, which reads plain text
# and does not care that the string sits in a test. Spelling a download-and-run
# command out here would be a true finding for both — this comment said one out
# loud in its first draft and the check below caught it. Keeping the literals
# out of the source is what lets the rule hold on the file that states it.
_INTERPRETERS = ('bash', 'sh', 'zsh', 'python', 'python3', 'node')
_DOWNLOADERS = ('curl', 'wget')
_BYPASS = (('ignore', 'previous', 'instructions'),
           ('disregard', 'the', 'system', 'prompt'),
           ('unrestricted', 'mode'),
           ('god', 'mode'))
_CJK_RANGES = ((0x3040, 0x30ff), (0x3400, 0x4dbf),
               (0x4e00, 0x9fff), (0xac00, 0xd7a3))

FORBIDDEN = (
    ('pipes into an interpreter',
     re.compile(r'\|\s*(?:%s)\b' % '|'.join(_INTERPRETERS))),
    ('downloads piped onward',
     re.compile(r'\b(?:%s)\b[^\n|]*\|' % '|'.join(_DOWNLOADERS))),
    ('CJK characters',
     re.compile('[%s]' % ''.join('%s-%s' % (chr(low), chr(high))
                                 for low, high in _CJK_RANGES))),
    ('instruction-bypass phrases',
     re.compile('(?i)' + '|'.join(r'\s*'.join(words) for words in _BYPASS))),
    ('dynamic code execution',
     re.compile(r'\beval\s*\(|\bexec\s*\(|\bos\.system\s*\(|'
                r'shell\s*=\s*True|\bpickle\.loads?\s*\(')),
    ('credential access',
     re.compile(r'~/\.(?:ssh|aws|gnupg)|\bnetrc\b|'
                r'environ\s*(?:\.get\s*\(|\[)\s*[\'"][^\'"]*'
                r'(?:TOKEN|SECRET|PASSWORD|KEY)')),
)


def package_files():
    """Every file that ships, relative to the skill root — junk included.

    Nothing is filtered on the way out: `__pycache__` and `.DS_Store` count
    against the file limit like anything else, so the walk that counts has to
    be the walk that finds them.
    """
    found = []
    for base, dirs, names in os.walk(SKILL):
        dirs.sort()
        for name in sorted(names):
            found.append(os.path.relpath(os.path.join(base, name), SKILL))
    return found


def frontmatter(text):
    """The YAML block of SKILL.md as `{field: (value, line index)}`.

    Only top-level fields: nested keys under `metadata` are indented and do
    not match, which is what the field checks want.
    """
    lines = text.splitlines()
    if not lines or lines[0].strip() != '---':
        return {}
    end = 0
    for index in range(1, len(lines)):
        if lines[index].strip() == '---':
            end = index
            break
    fields = {}
    for index, line in enumerate(lines[1:end]):
        found = re.match(r'^([a-z][a-z-]*):[ \t]?(.*)$', line)
        if found:
            fields[found.group(1)] = (found.group(2), index)
    return fields


def test_package_shape():
    """Structure, name and SKILL.md against the publication checklist."""
    files = package_files()
    check('package: within the %d-file limit (%d files)'
          % (FILE_LIMIT, len(files)), len(files) <= FILE_LIMIT,
          'the 355 icons are archived precisely to stay under it — unpacking '
          'them and forgetting to repack takes the package straight over')
    # Bytecode is not a mistake, it is what running the scripts leaves behind
    # — but it ships and it counts against the limit, so it has to go before
    # publication. Deleting it is the whole fix.
    junk = [f for f in files if os.path.basename(f) == '.DS_Store'
            or f.endswith('.pyc') or '__pycache__' in f.split(os.sep)]
    check('package: no editor or bytecode leftovers', not junk,
          'delete them — they count against the file limit and ship with the '
          'skill: %s' % '; '.join(junk[:5]))

    top = set(f.split(os.sep)[0] for f in files if os.sep in f)
    check('package: only the sanctioned resource directories',
          top <= set(PACKAGE_DIRS), ', '.join(sorted(top - set(PACKAGE_DIRS))))

    text = read_text(os.path.join(SKILL, 'SKILL.md'))

    # Section 2 does not say "only SKILL.md": the root may also hold resources
    # SKILL.md points at and helper files the skill needs. What it forbids by
    # name is development material — a README, a changelog, working notes. The
    # repo root is a different place and keeps all of that quite legitimately;
    # this walk starts at the package.
    loose = sorted(f for f in files if os.sep not in f)
    stray = [f for f in loose if f != 'SKILL.md' and ('`%s`' % f) not in text]
    check('package: the root holds nothing SKILL.md does not point at',
          not stray, ', '.join(stray))
    dev = [f for f in loose
           if os.path.splitext(f)[0].lower() in ROOT_DEV_DOCS]
    check('package: no development docs inside the package', not dev,
          'these belong at repo level: %s' % ', '.join(dev))

    lines = text.splitlines()
    fields = frontmatter(text)
    check('SKILL.md: opens with a YAML frontmatter block', bool(fields))
    check('SKILL.md: under 500 lines (%d)' % len(lines), len(lines) <= 500,
          'the agent reads the whole file on activation — detail belongs in '
          'references/')

    for field in ('name', 'description'):
        check('SKILL.md: %s is present' % field, field in fields)
    name = fields.get('name', ('', 0))[0].strip()
    folder = os.path.basename(SKILL)
    check('SKILL.md: name matches the folder', name == folder,
          '%r in the frontmatter, %r on disk' % (name, folder))
    check('SKILL.md: name is latin kebab-case under 64 characters',
          bool(re.match(r'^[a-z0-9]+(?:-[a-z0-9]+)*$', name)) and
          len(name) <= 64, name)

    desc, at = fields.get('description', ('', -1))
    check('SKILL.md: description is 1-1024 characters (%d)' % len(desc),
          0 < len(desc) <= 1024)
    front_lines = lines[1:] if lines else []
    spilled = (0 <= at and at + 1 < len(front_lines)
               and front_lines[at + 1][:1] in (' ', '\t'))
    check('SKILL.md: description is a single YAML line',
          desc.strip()[:1] not in ('>', '|') and not spilled,
          'the marketplace reads it as one string and rejects the folded forms')
    compat = fields.get('compatibility', ('', 0))[0]
    check('SKILL.md: compatibility is under 500 characters (%d)' % len(compat),
          len(compat) <= 500)

    heads = [line[3:].strip() for line in lines if line.startswith('## ')]
    for section in ('Instructions', 'Gotchas', 'Resources', 'Output format'):
        check('SKILL.md: has a %s section' % section, section in heads,
              'present: %s' % ', '.join(heads))

    linked = set(re.findall(r'`((?:%s)/[\w./-]+)`' % '|'.join(PACKAGE_DIRS),
                            text))
    broken = sorted(t for t in linked
                    if not os.path.exists(os.path.join(SKILL, t)))
    check('SKILL.md: every path it names exists', not broken,
          '; '.join(broken))

    # The other direction. Progressive disclosure only works if the entry
    # point names the resource: a reference or a script nothing links to is
    # never opened, and pays for itself in the file budget regardless.
    for name in sorted(os.listdir(os.path.join(SKILL, 'references'))):
        check('SKILL.md: references/%s is reachable' % name,
              ('references/%s' % name) in text)
    scripts = sorted(n for n in os.listdir(os.path.join(SKILL, 'scripts'))
                     if n.endswith('.py'))
    for name in scripts:
        check('SKILL.md: scripts/%s is reachable' % name,
              ('scripts/%s' % name) in text)

    for name in scripts:
        run = subprocess.Popen(
            [sys.executable, os.path.join(SKILL, 'scripts', name), '--help'],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        out, err = run.communicate()
        check('scripts/%s answers --help' % name,
              run.returncode == 0 and b'usage' in out.lower(),
              err.decode('utf-8', 'replace').strip()[:160])

    waiting = [f for f in files if f.endswith('.py')
               and re.search(r'\binput\s*\(',
                             read_text(os.path.join(SKILL, f)))]
    check('scripts: nothing stops to read stdin', not waiting,
          '; '.join(waiting))


def test_evals_are_scenarios():
    """evals/ holds runnable scenarios, and every fixture belongs to one.

    Two kinds of file live here deliberately. `evals.json` and
    `activation-queries.json` are the agent-facing scenarios the conventions
    ask for; `icon-coverage.json` and `icon-enforcement.json` are fixtures this
    self-test runs against the real build path. Both are evaluation data, and
    neither follows the other's schema.
    """
    evals = os.path.join(SKILL, 'evals')
    with open(os.path.join(evals, 'evals.json'), 'r', encoding='utf-8') as f:
        scenarios = json.load(f)
    check('evals: evals.json is a non-empty list of scenarios',
          isinstance(scenarios, list) and bool(scenarios))
    for row in scenarios if isinstance(scenarios, list) else []:
        name = row.get('name') or '(unnamed)'
        check('evals: %s states a prompt and an expected result' % name,
              bool(row.get('prompt')) and bool(row.get('expected')))
        for rel in row.get('files') or []:
            check('evals: %s input %s exists' % (name, rel),
                  os.path.isfile(os.path.join(SKILL, rel)))

    path = os.path.join(evals, 'activation-queries.json')
    with open(path, 'r', encoding='utf-8') as f:
        queries = json.load(f)
    for side in ('positive', 'negative'):
        split = queries.get(side) or {}
        total = sum(len(v) for v in split.values())
        check('evals: %d %s activation queries, 8 wanted' % (total, side),
              total >= 8)
        check('evals: %s queries are split train/validation' % side,
              set(split) == set(('train', 'validation')),
              'fixes to the description are checked against validation')

    blob = ''.join(read_text(os.path.join(evals, n))
                   for n in sorted(os.listdir(evals)) if n.endswith('.json'))
    orphans = [n for n in sorted(os.listdir(os.path.join(evals, 'files')))
               if n not in blob]
    check('evals: every fixture in evals/files belongs to a scenario',
          not orphans, '; '.join(orphans))


def test_security_rules():
    """Section 9, over every text file that ships.

    Over half the marketplace's recorded blocks came from nested `.md` and
    code examples rather than SKILL.md, so the sweep is the whole package and
    documentation counts: a shell example that pipes a download into an
    interpreter is blocked exactly like the command would be.
    """
    hits = []
    unreadable = []
    for rel in package_files():
        if not rel.endswith(TEXT_SUFFIXES):
            continue
        try:
            body = read_text(os.path.join(SKILL, rel))
        except (UnicodeDecodeError, OSError) as failure:
            unreadable.append('%s (%s)' % (rel, failure))
            continue
        for label, pattern in FORBIDDEN:
            found = pattern.search(body)
            if found:
                line = body.count('\n', 0, found.start()) + 1
                hits.append('%s:%d %s — %r'
                            % (rel, line, label, found.group(0)[:40]))
    check('security: every text file in the package reads as UTF-8',
          not unreadable, '; '.join(unreadable[:4]))
    for label, _pattern in FORBIDDEN:
        matching = [h for h in hits if label in h]
        check('security: no %s anywhere in the package' % label, not matching,
              '; '.join(matching[:4]))


def test_registry_matches_layouts():
    """Registry, records and fillers describe the same set of layouts.

    The builder derives its fragment files from the registry now, so the old
    form of this check — "does the registry cover what the builder knows" —
    could no longer fail. What is checked instead is the part that was never
    checked while the eight tables were parallel: that every public name picks
    a fragment that exists, at every element count it accepts.
    """
    slugs = set(L.physical(SKILL))
    known = L.known_slugs()
    check('every template slide has a layout record', slugs <= known,
          ', '.join(sorted(slugs - known)))
    check('no layout record names a missing fragment', known <= slugs,
          ', '.join(sorted(known - slugs)))
    for slug in sorted(slugs):
        check('layout %s has a filler' % slug, slug in S.FILLERS)

    for name, record in L.PUBLIC.items():
        for count in record.counts():
            data = {record.element: [None] * count} if record.element else {}
            picked = record.variant(data)
            check('%s at %d picks a fragment' % (name, count),
                  picked in slugs, picked)
            if record.summary_variants:
                data['summary'] = {'title': 'a', 'text': 'b'}
                picked = record.variant(data)
                check('%s at %d with a summary picks a fragment' % (name, count),
                      picked in slugs, picked)


def test_paint_diagnostics(out_dir):
    """Incomplete images and paint failures cannot masquerade as saved output."""
    from unittest.mock import patch
    from contextlib import nullcontext
    from deckkit import preview as PV
    import importlib
    from deckkit.html2pptx import paint as PT
    from deckkit.html2pptx import svgraster as SV
    C = importlib.import_module('deckkit.html2pptx.convert')
    from deckkit.html2pptx.assets import AssetResolver
    from deckkit.html2pptx.render import Renderer

    work = os.path.join(out_dir, 'paint-diagnostics')
    os.makedirs(work, exist_ok=True)
    css = os.path.join(SKILL, 'assets', 'base.css')

    def document(name, slides):
        path = os.path.join(work, name + '.html')
        markup = '<html><head><link rel="stylesheet" href="%s"></head><body>%s</body></html>' % (
            css, ''.join('<div class="slide">%s</div>' % body for body in slides))
        with open(path, 'w', encoding='utf-8') as handle:
            handle.write(markup)
        return Document.open(path, extra_dirs=[SKILL])

    def refusal(label, call):
        try:
            call()
        except Exception as exc:
            diagnostics = getattr(exc, 'diagnostics', [])
            check(label + ' raises structured PaintError',
                  type(exc).__name__ == 'PaintError' and bool(diagnostics), str(exc))
            return diagnostics
        check(label + ' raises structured PaintError', False, 'returned incomplete output')
        return []

    svg_path = os.path.join(work, 'valid.svg')
    with open(svg_path, 'w', encoding='utf-8') as handle:
        handle.write('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40">'
                     '<rect width="40" height="40" fill="red"/></svg>')
    corrupt = os.path.join(work, 'corrupt.png')
    with open(corrupt, 'wb') as handle:
        handle.write(b'unreadable image')
    cases = [
        ('missing', '<img class="z required" src="missing-paint.png" style="width:40px;height:40px">',
         None, 'ASSET_UNAVAILABLE', 'img', ('required', 'z'), "picture asset unavailable: 'missing-paint.png'"),
        ('background', '<div class="required" style="width:40px;height:40px;background-image:url(missing-bg.png)"></div>',
         None, 'ASSET_UNAVAILABLE', 'div', ('required',), "background asset unavailable: 'missing-bg.png'"),
        ('inline', '<svg class="required" width="40" height="40" style="width:40px;height:40px"><rect width="40" height="40"/></svg>',
         '_raster_inline_svg', 'ASSET_UNAVAILABLE', 'svg', ('required',), "picture asset unavailable: '<inline svg>'"),
        ('svg file', '<img class="required" src="%s" style="width:40px;height:40px">' % svg_path,
         '_raster_svg', 'ASSET_UNAVAILABLE', 'img', ('required',), "picture asset unavailable: %r" % svg_path),
        ('inner SVG', '<img class="required" src="%s" style="width:41px;height:41px">' % svg_path,
         'inner_svg', 'ASSET_UNAVAILABLE', 'img', ('required',), "picture asset unavailable: %r" % svg_path),
        ('unsupported URL', '<img class="required" src="https://example.invalid/image.png" style="width:40px;height:40px">',
         None, 'ASSET_UNAVAILABLE', 'img', ('required',), "picture asset unavailable: 'https://example.invalid/image.png'"),
        ('no source', '<img class="required" style="width:40px;height:40px">',
         None, 'ASSET_UNAVAILABLE', 'img', ('required',), 'picture asset unavailable: None'),
        ('corrupt', '<img class="required" src="%s" style="width:40px;height:40px">' % corrupt,
         None, 'PAINT_FAILED', 'img', ('required',), None),
    ]
    for label, markup, method, code, tag, classes, message in cases:
        doc = document(label.replace(' ', '-'), [markup + '<p>Later content</p>'])
        path = os.path.join(work, 'destination.pptx')
        with open(path, 'wb') as handle:
            handle.write(b'previous complete output')
        if method == 'inner_svg':
            context = patch.object(SV.Renderer, 'render', side_effect=RuntimeError('inner SVG fault'))
        else:
            context = patch.object(AssetResolver, method, return_value=None) if method else nullcontext()
        with context:
            native = refusal('paint %s native' % label,
                             lambda: C.write_pptx(doc, path, os.path.join(work, 'cache')))
            preview = PV.Preview(doc.assets(os.path.join(work, 'preview-cache')), doc.fonts)
            raster = refusal('paint %s preview' % label, lambda: preview.render(doc.box(1), index=1))
            preflight = PT.check_resources(doc)
        for medium, diagnostics in [('native', native), ('preview', raster), ('preflight', preflight)]:
            check('paint %s %s exact location/code' % (label, medium),
                  len(diagnostics) == 1 and diagnostics[0].code == code
                  and diagnostics[0].slide == 1 and diagnostics[0].tag == tag
                  and diagnostics[0].classes == classes, repr(diagnostics))
            check('paint %s %s actionable detail' % (label, medium),
                  bool(diagnostics) and (diagnostics[0].message == message if message is not None
                  else 'UnidentifiedImageError:' in diagnostics[0].message))
        with open(path, 'rb') as handle:
            check('paint %s preserves native destination' % label,
                  handle.read() == b'previous complete output')
        check('paint %s preview retains diagnostic' % label, preview.diagnostics == raster and bool(raster))

    # A zero-area or wholly clipped picture needs no bytes in either medium.
    doc = document('empty-geometry', [
        '<img src="not-needed.png" style="width:0px;height:40px">'
        '<img src="not-needed.png" data-clip-bottom="0" style="position:absolute;top:10px;width:40px;height:40px">'
        '<div style="width:0px;height:40px;background-image:url(not-needed.png)"></div>'])
    check('paint zero/clipped resource preflight stays clean', PT.check_resources(doc) == [])
    path = os.path.join(work, 'empty.pptx')
    check('paint zero/clipped native retains path return', C.write_pptx(doc, path) == path)
    image = PV.Preview(doc.assets(os.path.join(work, 'empty-cache')), doc.fonts).render(doc.box(1))
    check('paint zero/clipped preview retains image return', image.size == (1920, 1080))

    doc = document('continuation', ['<p id="bad">Bad</p><p id="other">Other</p><p id="tail">Tail</p>'])
    class RecordingTarget(PT.PaintTarget):
        def __init__(self):
            self.attempts, self.failures = [], []
        def text(self, box, style):
            self.attempts.append(box.el.get('id'))
            if box.el.get('id') != 'tail':
                raise ValueError('injected text failure')
            return 1
        def failed(self, box, exc):
            self.failures.append(box.el.get('id'))  # no super: collection is engine-owned
    target = RecordingTarget()
    diagnostics = refusal('paint walk continuation', lambda: PT.paint_slide(doc.box(1), target, index=7))
    check('paint walk attempts later boxes after two failures',
          target.attempts == ['bad', 'other', 'tail'] and target.failures == ['bad', 'other'])
    check('paint walk collects independent exact diagnostics',
          [(d.code, d.slide, d.tag, d.classes, d.message) for d in diagnostics] == [
              ('PAINT_FAILED', 7, 'p', (), 'ValueError: injected text failure'),
              ('PAINT_FAILED', 7, 'p', (), 'ValueError: injected text failure')])

    root = doc.box(1)
    root.style['background-color'] = '#FFFFFF'
    with patch.object(target, 'background', side_effect=RuntimeError('root failure')):
        diagnostics = refusal('paint root background', lambda: PT.paint_slide(root, target, index=8))
    check('paint root background location retained', bool(diagnostics)
          and diagnostics[0].slide == 8 and diagnostics[0].tag == 'div'
          and diagnostics[0].classes == ('slide',)
          and diagnostics[0].message == 'RuntimeError: root failure')
    for fatal in (MemoryError, SystemExit, KeyboardInterrupt):
        target = RecordingTarget()
        with patch.object(target, 'text', side_effect=fatal('fatal paint')):
            try:
                PT.paint_slide(root, target)
            except fatal:
                rejected = True
            else:
                rejected = False
        check('paint propagates %s' % fatal.__name__, rejected)

    # Resolver error handlers must not turn process exhaustion into a missing SVG.
    from deckkit.html2pptx import assets as AS
    resolver = AssetResolver(work, os.path.join(work, 'fatal-cache'))
    svg = etree.fromstring(b'<svg xmlns="http://www.w3.org/2000/svg"/>')
    for label, owner, attribute, call in [
        ('file SVG', AS, 'rasterize', lambda: resolver._raster_svg(svg_path, 41, 41, 1)),
        ('inline SVG', AS, 'rasterize', lambda: resolver._raster_inline_svg(svg, 41, 41)),
        ('SVG serialization', AS.etree, 'tostring', lambda: resolver._raster_inline_svg(svg, 42, 42)),
        ('opacity image', Image, 'open', lambda: resolver._bake_opacity(corrupt, .5)),
        ('contain geometry', AS, 'image_size', lambda: AS.contain_rect(corrupt, 40, 40)),
        ('cover geometry', AS, 'image_size', lambda: AS.cover_crop(corrupt, 40, 40)),
        ('SVG drawing', SV.Renderer, 'render', lambda: SV.rasterize(svg_path, 43, 43)),
        ('SVG embedded decode', SV.Image, 'open', lambda: SV._decode_data_uri_image('data:image/png;base64,YQ==')),
    ]:
        with patch.object(owner, attribute, side_effect=MemoryError('fatal resource')):
            _raises('paint resolver propagates MemoryError: ' + label,
                    MemoryError, 'fatal resource', call)
    _raises('paint SVG rejects corrupt supported embedded image',
            OSError, 'cannot identify image',
            lambda: SV.rasterize('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40">'
                                 '<image href="data:image/png;base64,YQ==" width="40" height="40"/></svg>'))

    # Both concrete text adapters fail explicitly and still try the following text.
    for label, owner, attribute in [('native', Renderer, '_add_text'), ('preview', PV.Preview, '_text')]:
        original = getattr(owner, attribute)
        attempted = []
        def broken_text(adapter, *args):
            box = args[1] if label == 'native' else args[0]
            attempted.append(box.el.get('id'))
            if box.el.get('id') == 'bad':
                raise RuntimeError('adapter text fault')
            return original(adapter, *args)
        with patch.object(owner, attribute, broken_text):
            if label == 'native':
                call = lambda: C.write_pptx(doc, os.path.join(work, 'adapter.pptx'))
            else:
                call = lambda: PV.Preview(doc.assets(os.path.join(work, 'adapter-cache')), doc.fonts).render(root, index=1)
            diagnostics = refusal('paint concrete ' + label, call)
        check('paint concrete %s continuation and detail' % label,
              attempted == ['bad', 'other', 'tail'] and len(diagnostics) == 1
              and diagnostics[0].message == 'RuntimeError: adapter text fault')

    broken = document('multi', ['<p>Good</p>',
        '<img src="missing-one.png" style="width:40px;height:40px">',
        '<img src="missing-two.png" style="width:40px;height:40px">'])
    renderer = Renderer(broken.assets(os.path.join(work, 'multi-cache')), broken.fonts)
    refusal('paint renderer slide', lambda: renderer.render_slide(broken.box(2), 2))
    check('paint renderer retains failures', len(renderer.diagnostics) == 1
          and renderer.diagnostics[0].slide == 2)
    renderer.render_slide(broken.box(1), 1)
    path = os.path.join(work, 'direct-save.pptx')
    refusal('paint renderer direct save', lambda: renderer.save(path))
    check('paint renderer direct save writes nothing', not os.path.exists(path))
    diagnostics = refusal('paint native multiple slides', lambda: C.convert(broken.path, path))
    check('paint native collects failing slide numbers', [d.slide for d in diagnostics] == [2, 3])
    check('paint native multiple slides writes nothing', not os.path.exists(path))
    preview_dir = os.path.join(work, 'multi-preview')
    os.makedirs(preview_dir, exist_ok=True)
    previous = os.path.join(preview_dir, 'probe-01.png')
    with open(previous, 'wb') as handle:
        handle.write(b'previous complete preview')
    diagnostics = refusal('paint preview multiple slides', lambda: PV.render_document(
        broken, preview_dir, os.path.join(work, 'multi-cache'), stem='probe'))
    check('paint preview collects failing slide numbers', [d.slide for d in diagnostics] == [2, 3])
    with open(previous, 'rb') as handle:
        check('paint preview preserves complete previous output', handle.read() == b'previous complete preview')
    check('paint preview discards staged successful slides', sorted(os.listdir(preview_dir)) == ['probe-01.png'])
    paths = PV.render_document(broken, preview_dir, os.path.join(work, 'multi-cache'), wanted={1}, stem='probe')
    check('paint preview selection ignores unrequested broken slides', paths == [previous]
          and Image.open(previous).size == (1920, 1080))
    preview = PV.Preview(broken.assets(os.path.join(work, 'multi-cache')), broken.fonts)
    diagnostics = refusal('paint anonymous preview', lambda: preview.render(broken.box(2)))
    check('paint anonymous preview location is zero', [d.slide for d in diagnostics] == [0])
    preview.render(broken.box(1))
    check('paint preview resets per-call diagnostics', preview.diagnostics == [])

    import preview_deck
    with patch('sys.stderr', new_callable=io.StringIO) as stderr:
        exit_code = preview_deck.main([broken.path, '--out', preview_dir])
    check('paint preview CLI rejects partial output', exit_code == 1
          and 'preview not rendered:' in stderr.getvalue()
          and 'slide 2' in stderr.getvalue() and 'ASSET_UNAVAILABLE' in stderr.getvalue())


def test_build_paint_diagnostics(out_dir):
    """Build issues include preflight and late writer faults, with no publication."""
    from unittest.mock import patch
    import importlib
    C = importlib.import_module('deckkit.html2pptx.convert')
    from deckkit.html2pptx.assets import AssetResolver
    from deckkit.html2pptx.render import _Shapes

    work = os.path.join(out_dir, 'build-paint-diagnostics')
    os.makedirs(work, exist_ok=True)
    path = os.path.join(work, 'result.pptx')
    def deck():
        return SP.deck_from_spec({'slides': [
            {'layout': 'title', 'text': 'Paint diagnostics'}, {'layout': 'final'}]}, SKILL)
    def build_issues(strict, pptx=True):
        try:
            result = deck().build(path, strict=strict, pptx=pptx, keep_html=True)
        except BuildError as exc:
            check('build paint strict=%s raises only in strict mode' % strict, strict)
            return exc.issues
        check('build paint strict=%s returns only in non-strict mode' % strict,
              not strict and result.pptx_path is None and bool(result.errors))
        return result.issues
    def preserved(label):
        with open(path, 'rb') as handle:
            check(label + ' preserves deliverable', handle.read() == b'previous complete deck')
        check(label + ' cleans staging', not any(n.startswith('.deck-build-') for n in os.listdir(work)))
    for strict in (True, False):
        for pptx in (True, False):
            with open(path, 'wb') as handle:
                handle.write(b'previous complete deck')
            with patch.object(AssetResolver, 'for_box', return_value=None):
                issues = build_issues(strict, pptx=pptx)
            errors = [i for i in issues if i.level == 'error']
            check('build paint missing resources strict=%s pptx=%s' % (strict, pptx),
                  len(errors) >= 2 and {i.code for i in errors} == {'ASSET_UNAVAILABLE'}
                  and {i.slide for i in errors} == {1, 2}
                  and all('picture asset unavailable:' in i.message for i in errors))
            preserved('build paint missing strict=%s pptx=%s' % (strict, pptx))

    original_writer = C.write_pptx
    def late_resource_loss(*args, **kwargs):
        with patch.object(AssetResolver, 'for_box', return_value=None):
            return original_writer(*args, **kwargs)
    original_text = _Shapes.text
    def late_text_loss(target, box, style):
        if 'title-large' in box.classes():
            raise RuntimeError('late paint fault')
        return original_text(target, box, style)
    for strict in (True, False):
        for label, owner, attribute, failure, code in [
            ('late resources', C, 'write_pptx', late_resource_loss, 'ASSET_UNAVAILABLE'),
            ('late text', _Shapes, 'text', late_text_loss, 'PAINT_FAILED'),
        ]:
            with open(path, 'wb') as handle:
                handle.write(b'previous complete deck')
            with patch.object(owner, attribute, failure):
                issues = build_issues(strict)
            errors = [i for i in issues if i.level == 'error']
            check('build paint %s strict=%s maps engine issues' % (label, strict),
                  bool(errors) and {i.code for i in errors} == {code})
            if code == 'PAINT_FAILED':
                check('build paint late text exact diagnostic strict=%s' % strict,
                      len(errors) == 1 and errors[0].slide == 1 and errors[0].message ==
                      '<h1 class="title-large">: RuntimeError: late paint fault')
            preserved('build paint %s strict=%s' % (label, strict))


def test_paint_interface_shared():
    """render.py and preview.py are adapters over paint.py, not a second walk.

    Before v1.5 both had their own `_paint`/`_paint_order` and their own
    reading of a text box's style; where the two drifted, "the preview looks
    right" was the evidence that delayed finding four separate bugs — see
    AGENTS.md, "One paint walk, two adapters". This guards the seam: if either
    adapter stops going through `PaintTarget`, or a second traversal or a
    second baseline formula creeps back in, this is where it is meant to fail.
    """
    from deckkit import preview as PV
    from deckkit.html2pptx import paint as PT
    from deckkit.html2pptx import render as R

    check('render._Shapes implements PaintTarget',
          issubclass(R._Shapes, PT.PaintTarget))
    check('preview.Preview implements PaintTarget',
          issubclass(PV.Preview, PT.PaintTarget))

    primitives = {name for name, method in vars(PT.PaintTarget).items()
                  if not name.startswith('_') and callable(method)}
    for adapter in (R._Shapes, PV.Preview):
        missing = primitives - {name for name, method in vars(adapter).items()
                                if callable(method)}
        check('%s overrides every PaintTarget primitive' % adapter.__name__,
              not missing, repr(sorted(missing)))

    with open(R.__file__, encoding='utf-8') as f:
        render_src = f.read()
    with open(PV.__file__, encoding='utf-8') as f:
        preview_src = f.read()
    check('render.py defines no traversal of its own',
          'def _paint_order' not in render_src and 'def paint_order' not in render_src)
    check('preview.py defines no traversal of its own',
          'def _paint_order' not in preview_src and 'def paint_order' not in preview_src)
    check('the baseline formula is not duplicated outside textmeasure.py',
          'def baseline_offset' not in render_src
          and 'def baseline_offset' not in preview_src)


# ------------------------------------------------------------------ icons

def test_icons(deck):
    library = deck.icons
    # B1+B2: Check that concepts and plain queries find icons
    # (not exact name, but what is found at all)
    pairs = [
        ('молния', 'flash.png'),  # Exact keyword match
        ('галочка', 'check.png'),  # Exact keyword match
        ('ракета', 'rocket.png'),  # Exact keyword match
        ('часы', 'clock.png'),     # Exact keyword match
        ('щит', None),             # Concept → shield or shield-check
        ('документ', None),        # Concept → doc or doc-checkbox
    ]
    for query, expected in pairs:
        got = library.resolve(query)
        if expected:
            check('icon for query "%s" -> %s' % (query, expected), got == expected, got)
        else:
            check('icon for query "%s" found' % query, got is not None, got or 'nothing')

    try:
        library.resolve('абракадабра-которой-нет')
        check('nonexistent icon rejected', False, 'no exception')
    except IconNotFound:
        check('nonexistent icon rejected', True)

    index = json.load(open(os.path.join(SKILL, 'assets', 'icons', 'INDEX.json'),
                           'r', encoding='utf-8'))
    entries = index['icons'] if isinstance(index, dict) else index
    listed = [e['file'] for e in entries]
    missing = [f for f in listed
               if not asset_exists(os.path.join(SKILL, 'assets', 'icons', f))]
    check('all icons from index exist', not missing, ', '.join(missing[:5]))

    # The flip side: an archive member not in the index is unreachable by
    # design — the icon is in the skill but cannot be selected. For now it's
    # 12 KB of dead weight, but this is exactly how the set diverges from
    # the index.
    archive = icon_archive()
    check('icon archive exists', os.path.isfile(archive), archive)
    packed = _archive_members(archive)
    orphans = sorted(packed - set(listed))
    check('every icon in the archive is in INDEX.json', not orphans,
          '%d orphans: %s' % (len(orphans), ', '.join(orphans[:5])))
    check('archive holds every indexed icon',
          len(packed) == len(listed),
          'archive %d, index %d' % (len(packed), len(listed)))

    # The concept layer references files by name, and there was no check for
    # these links: the first version of the dictionary contained 122 references
    # (15%) to icons that do not exist — `handshake`, `target`, `brain`, `eye`.
    # The first position for most concepts was real, so a normal build passed,
    # and the miss only surfaced when the allocator fell back to a spare:
    # the path was not found and the card came out without an icon. That is
    # exactly the complaint that started all this.
    concepts_path = os.path.join(SKILL, 'assets', 'icons', 'CONCEPTS.json')
    check('CONCEPTS.json exists', os.path.isfile(concepts_path), concepts_path)
    if os.path.isfile(concepts_path):
        with open(concepts_path, 'r', encoding='utf-8') as f:
            raw = json.load(f)
        mapping = raw.get('concepts') or raw.get('концепты') or {}
        stems = set(f[:-4] for f in listed)
        unknown = sorted({name for icons in mapping.values() for name in icons
                          if name not in stems and name not in listed})
        check('every icon named in CONCEPTS.json exists (%d concepts, %d refs)'
              % (len(mapping), sum(len(v) for v in mapping.values())),
              not unknown,
              '%d invented names: %s' % (len(unknown), ', '.join(unknown[:8])))

        # A ranked list is needed for the allocator: when the first icon is
        # taken, it takes the second. Fewer than three options — and on a
        # four-card slide the spare runs out.
        thin = sorted(c for c, icons in mapping.items() if len(icons) < 3)
        check('every concept offers at least 3 alternatives', not thin,
              '%d too thin: %s' % (len(thin), ', '.join(thin[:8])))

        dupes = sorted(c for c, icons in mapping.items()
                       if len(set(icons)) != len(icons))
        check('no concept repeats an icon', not dupes, ', '.join(dupes[:8]))

        # The allocator separates icons within a slide, but not within a deck.
        # If a third of concepts lead with `star` as first position, the whole
        # presentation slides toward the star — that same complaint, one level
        # up. The first position matters more than the rest: the allocator
        # reaches spares only on collision, so its cap is tighter.
        MAX_FIRST, MAX_TOTAL = 4, 12
        first = collections.Counter(icons[0] for icons in mapping.values()
                                    if icons)
        total = collections.Counter(name for icons in mapping.values()
                                    for name in icons)
        hot = sorted(((n, c) for n, c in first.items() if c > MAX_FIRST),
                     key=lambda p: -p[1])
        check('no icon is first choice for more than %d concepts' % MAX_FIRST,
              not hot,
              '%d over the cap: %s' % (len(hot), ', '.join(
                  '%s=%d' % p for p in hot[:8])))
        wide = sorted(((n, c) for n, c in total.items() if c > MAX_TOTAL),
                      key=lambda p: -p[1])
        check('no icon appears in more than %d concepts' % MAX_TOTAL,
              not wide,
              '%d over the cap: %s' % (len(wide), ', '.join(
                  '%s=%d' % p for p in wide[:8])))

    # Gate words are data, not logic: the list lives in evals/icon-coverage.json,
    # and is updated far more often than this file. Three lists check three
    # different matching layers, and they must not be confused — see
    # _how_to_extend in the file itself.
    words_path = os.path.join(SKILL, 'evals', 'icon-coverage.json')
    check('icon-coverage.json exists', os.path.isfile(words_path), words_path)
    with open(words_path, 'r', encoding='utf-8') as f:
        words = json.load(f)
    concept_words = words['concept_words']
    keyword_words = words['keyword_words']
    inflected = words['inflected_words']
    for name, lst in (('concept_words', concept_words),
                      ('keyword_words', keyword_words),
                      ('inflected_words', inflected)):
        check('icon-coverage.json: %s is a non-empty list' % name,
              isinstance(lst, list) and len(lst) > 0, repr(lst)[:60])

    coverage_words = concept_words + keyword_words + inflected

    failed_coverage = []
    for word in coverage_words:
        try:
            library.resolve(word)
        except IconNotFound:
            failed_coverage.append(word)

    if failed_coverage:
        check('concept coverage gate (%d/%d words)' %
              (len(coverage_words) - len(failed_coverage), len(coverage_words)),
              False,
              'do not find icons: %s' % ', '.join(failed_coverage[:10]))
    else:
        check('concept coverage gate (%d words)' % len(coverage_words), True)

    # The gate must not become a tautology again: if every gate word is a
    # CONCEPTS.json key, it only checks that the dictionary contains its own
    # keys, and lets any keyword search breakage slip through. That is exactly
    # how the morphology regression went unnoticed.
    concepts = library.concepts
    non_concept = [w for w in coverage_words if _norm_ru(w) not in concepts]
    check('coverage gate reaches past the concept map '
          '(%d of %d words are not concept keys)'
          % (len(non_concept), len(coverage_words)),
          len(non_concept) >= 20,
          'only %d non-concept words - the gate cannot catch keyword '
          'regressions' % len(non_concept))

    # Keyword layer separate from concepts: search() does not substitute them.
    broken = [w for w in keyword_words if not library.search(w, limit=1)]
    check('keyword search still finds plain index words (%d)'
          % len(keyword_words),
          not broken, 'lost: %s' % ', '.join(broken))


# ------------------------------------------------------------------ build

# Regular cards need an icon on every entry path (P22.03).
ICONS4 = ('рост', 'цель', 'команда', 'щит')


def test_overflow(out_dir):
    """Too long text is caught before file build."""
    long_text = ('Очень длинное описание, которое совершенно точно не помещается '
                 'в узкую карточку и обязано вызвать замечание при проверке, '
                 'потому что текста здесь кратно больше, чем предусмотрено '
                 'макетом на четыре карточки в один ряд. ') * 8
    deck = Deck(skill_dir=SKILL)
    deck.title('Проверка')
    deck.cards('Заголовок', [Card('Карточка %d' % i, long_text, icon)
                              for i, icon in enumerate(ICONS4, 1)])
    deck.final()
    result = deck.build(os.path.join(out_dir, 'overflow'), strict=False, pptx=False)
    codes = [i.code for i in result.issues]
    check('card overflow detected', 'OVERFLOW' in codes, str(codes))
    check('overflow is error not warning',
          any(i.code == 'OVERFLOW' and i.level == 'error' for i in result.issues))

    with_icon = Deck(skill_dir=SKILL)
    with_icon.title('Проверка')
    with_icon.cards('Заголовок', [
        Card('Карточка %d' % i, 'Описание. ' * 70 if i == 1 else 'Коротко',
             icon='щит') for i in range(1, 5)])
    with_icon.final()
    overlap = with_icon.build(os.path.join(out_dir, 'overlap'), strict=False, pptx=False)
    # Since v1.3 the icon's band is reserved before the size is chosen, so text
    # can no longer be laid under the icon: what used to surface as ICON_OVERLAP
    # now surfaces as OVERFLOW at the bottom step of the ladder. Either code
    # counts — what must not happen is the deck passing silently.
    check('text that would reach the icon is still caught',
          any(i.code in ('ICON_OVERLAP', 'OVERFLOW') and i.level == 'error'
              for i in overlap.issues),
          str([i.code for i in overlap.issues]))

    # The other half of the same contract: text that only just reaches the icon
    # must be rescued by a smaller step rather than reported. Before v1.3 this
    # deck produced ICON_OVERLAP; now it must be clean.
    rescued = Deck(skill_dir=SKILL)
    rescued.title('Проверка')
    rescued.cards('Заголовок', [
        Card('Карточка %d' % i, 'Описание. ' * 18 if i == 1 else 'Коротко',
             icon='щит') for i in range(1, 5)])
    rescued.final()
    saved = rescued.build(os.path.join(out_dir, 'rescued'), strict=False, pptx=False)
    check('text near the icon is rescued by a smaller step, not reported',
          not [i for i in saved.issues if i.code in ('ICON_OVERLAP', 'OVERFLOW')],
          str([str(i) for i in saved.issues]))

    normal = Deck(skill_dir=SKILL)
    normal.title('Проверка')
    normal.cards('Заголовок', [Card('Карточка %d' % i, 'Короткое описание', icon)
                               for i, icon in enumerate(ICONS4, 1)])
    normal.final()
    ok = normal.build(os.path.join(out_dir, 'normal'), strict=False, pptx=False)
    check('normal text raises no issues',
          not [i for i in ok.issues if i.level == 'error'],
          '; '.join(str(i) for i in ok.issues))


def test_formula_geometry(out_dir):
    """A tall formula owns one line and still participates in overflow."""
    spec = SP.load_spec(os.path.join(SKILL, 'evals', 'files',
                                     'formula-quantitative.json'))
    deck = SP.deck_from_spec(spec, skill_dir=SKILL)
    result = deck.build(os.path.join(out_dir, 'formula-geometry'),
                        strict=False, pptx=False, keep_html=True)
    document = Document.open(result.html_path, extra_dirs=[SKILL])
    root = document.box(3)  # covariance bullet
    boxes = [box for box in root.walk()
             if box.kind == 'text'
             and any(isinstance(run, MathRun) for line in box.lines for run in line)]
    check('formula geometry: math box found', bool(boxes))
    if boxes:
        box = boxes[0]
        formula_lines = [i for i, line in enumerate(box.lines)
                         if any(isinstance(run, MathRun) for run in line)]
        check('formula geometry: line arrays stay parallel',
              len(box.lines) == len(box.line_heights) == len(box.line_baselines),
              '%d/%d/%d' % (len(box.lines), len(box.line_heights),
                             len(box.line_baselines)))
        check('formula geometry: tall expression expands its own line',
              formula_lines and box.line_heights[formula_lines[0]] > box.line_height,
              '%s nominal %.1f' % (box.line_heights, box.line_height))

    too_wide = Deck(skill_dir=SKILL)
    too_wide.title('Проверка')
    too_wide.cards('Формула', [
        {'title': 'Очень длинная', 'icon': 'аналитика',
         'items': ['\\(' + '+'.join(['x'] * 600) + '\\)']}])
    too_wide.final()
    overflow = too_wide.build(os.path.join(out_dir, 'formula-overflow'),
                              strict=False, pptx=False)
    check('formula geometry: formula overflow is reported',
          any(issue.code == 'OVERFLOW' for issue in overflow.issues),
          str([str(issue) for issue in overflow.issues]))


def test_slide_headline_width(out_dir):
    """One over-wide word in a slide headline is reported, not painted past the edge.

    `_slide_issues` gained this check in v1.6, after a `chart` title clipped a
    word mid-glyph while `--check` reported nothing. Only the card path
    (`_card_issues`) had a regression test for the same class of failure, so
    the slide-level half could be deleted and nothing would go red. This pins
    it.

    The word is synthetic rather than a real Russian noun on purpose. The
    widest realistic one, «конкурентоспособность», clears the title box by
    only ~56px at 144px — a test that close to the boundary is a font-metrics
    tripwire, not a check. A repeated letter puts the failure many hundreds of
    px past the edge, where no plausible drift in `sfnt.py` can reach it.

    Deliberately NOT asserted here: that the ladder steps down for a wide
    word. It does not, and that is the decision, not an oversight —
    `fit.headline_fits` measures height and obstacle clearance only. See
    AGENTS.md, "Known open items".
    """
    wide = Deck(skill_dir=SKILL)
    wide.title('ш' * 30)
    wide.final()
    result = wide.build(os.path.join(out_dir, 'headline-wide'),
                        strict=False, pptx=False)
    hits = [i for i in result.issues
            if i.code == 'OVERFLOW' and i.level == 'error'
            and 'wider than its box' in i.message]
    check('over-wide headline word reported as OVERFLOW', hits,
          str([str(i) for i in result.issues]))

    # The other half of the contract, and the thing that makes this a width
    # check rather than a length one: the same characters as several words
    # break between them and must build clean.
    wrapped = Deck(skill_dir=SKILL)
    wrapped.title(' '.join(['ш' * 5] * 3))
    wrapped.final()
    ok = wrapped.build(os.path.join(out_dir, 'headline-wrapped'),
                       strict=False, pptx=False)
    check('the same characters split into words build clean',
          not [i for i in ok.issues if i.level == 'error'],
          '; '.join(str(i) for i in ok.issues))


def test_headline_ladder_runs_out(out_dir):
    """A headline the ladder cannot seat is reported, with the right advice.

    The verdict comes from the size search (`fit.headline_fits`), which is the
    only place that knows what a headline must clear on each layout; until 2.1
    `build.py` turned it into an issue itself and picked the chart wording by
    slug. Now `validate` reports it and the layout's `remedy` in
    typography.json picks the wording. Neither message had a test.
    """
    def overflow(deck, name):
        result = deck.build(os.path.join(out_dir, name), strict=False, pptx=False)
        return [i.message for i in result.issues
                if i.code == 'OVERFLOW' and i.level == 'error'
                and ('even with the title at' in i.message
                     or 'does not fit its place even at' in i.message)]

    words = ' '.join(['Заголовок'] * 14)
    timeline = Deck(skill_dir=SKILL)
    timeline.timeline(words, [{'text': 'Этап %d' % n} for n in range(1, 4)])
    found = overflow(timeline, 'ladder-timeline')
    check('headline ladder: a timeline title is told to shorten the title',
          len(found) == 1 and 'shorten it' in found[0], str(found))

    long_point = ' '.join(['Значимость этих проблем настолько очевидна'] * 3)
    chart = Deck(skill_dir=SKILL)
    chart.chart(words, {'categories': ['А', 'Б'],
                        'series': [{'name': 'Ряд', 'values': [1, 2]}]},
                points=[{'text': long_point, 'icon': ic}
                        for ic in ('рост', 'цель', 'щит', 'команда', 'флаг')])
    found = overflow(chart, 'ladder-chart')
    check('headline ladder: chart-points is told to shorten the points',
          len(found) == 1 and 'shorten the points' in found[0], str(found))


def test_columns_subtitle_gutters(out_dir):
    """Subtitle fit bands share the body's existing horizontal gutter."""
    from deckkit import fit as FT
    from deckkit import typography as T

    scale = T.load(SKILL)
    deck = Deck(skill_dir=SKILL)
    samples = []
    # Literal template geometry and synthetic T-Sans Medium word boundaries.
    # A 32px 'ш' advances 24.544px; these floor words fill their bands.
    for count, width, band, middle, floor, bad in (
            (3, 542, 53, 17, 22, 23), (4, 398, 53, 12, 16, 17),
            (5, 312, 48, 11, 12, 14), (6, 254, 48, 9, 10, 11)):
        for kind, title, step in (
                ('short', 'Этап', 44 if count < 5 else 40),
                ('middle', 'ш' * middle, 40 if count < 5 else 36),
                ('floor', 'ш' * floor, 32),
                ('wide', 'ш' * bad, 32),
                ('break', 'Первая\nВторая', 32)):
            deck.columns('Заголовок', [dict(title=title, text='Короткий текст')
                                      for _ in range(count)])
            samples.append((count, width, band, kind, step))
    result = deck.build(os.path.join(out_dir, 'columns-subtitle-gutters'),
                        strict=False, pptx=False, keep_html=True)
    document = Document.open(result.html_path, extra_dirs=[SKILL])
    for index, (count, width, band, kind, step) in enumerate(samples, 1):
        root = document.box(index)
        cols = [b for b in root.walk() if 'columns-col' in b.classes()]
        heads = [b for b in root.walk() if 'point-title' in b.classes()]
        dots = [b for b in root.walk() if 'columns-dot' in b.classes()]
        rule = next(b for b in root.walk() if 'columns-line' in b.classes())
        label = 'columns-%d subtitle %s' % (count, kind)
        check(label + ': common legal step', result.sizes[index-1].pair[0] == step)
        check(label + ': title and body share the literal text width',
              len(cols) == count and all(
                  abs(col.children[0].w - width) < .01
                  and abs(col.children[2].w - width) < .01
                  and abs(col.children[0].h - band) < .01
                  for col in cols))
        check(label + ': pitch, marker and rule remain fixed',
              all(abs(col.x - (96 + i * 1728.0 / count)) < .01
                  for i, col in enumerate(cols))
              and all(abs(dot.y - (362 + band + 29)) < .01 for dot in dots)
              and abs(rule.y - (362 + band + 41.5)) < .01)
        errors = [i for i in result.errors if i.slide == index]
        accepted = kind not in ('wide', 'break')
        check(label + ': fit and diagnostic agree on this case',
              result.sizes[index-1].pair_fits == accepted
              and bool(errors) != accepted,
              str([str(i) for i in errors]))
        if accepted:
            check(label + ': every subtitle clears the next column',
                  all(len(h.lines) == 1 and h.line_widths[0] <= width + .5
                      and cols[i+1].x - (h.x + h.line_widths[0]) >= 33
                      for i, h in enumerate(heads[:-1])))
        if kind == 'short':
            tier = scale.tier_of('columns-%d' % count)
            for over, expected in ((.4, True), (.6, False)):
                original = heads[0].line_widths
                heads[0].line_widths = [width + over]
                check(label + ': measured width boundary %.1f' % over,
                      FT.cards_fit(root, tier) == expected)
                heads[0].line_widths = original

    original = {'title': 'Regression', 'slides': [{
        'layout': 'columns', 'title': 'Что audit считает доказательством',
        'columns': [{'title': t, 'text': 'Короткий текст'} for t in (
            'Вывод derivative', 'Независимый reference', 'Инвариантность',
            'Sampling simulation', 'Совместимость')]}]}
    source = copy.deepcopy(original)
    failing = SP.deck_from_spec(original, skill_dir=SKILL)
    refused_path = os.path.join(out_dir, 'columns-reference-refused')
    try:
        failing.build(refused_path)
        refused = False
    except BuildError as exc:
        refused = any(i.code == 'OVERFLOW' and i.level == 'error'
                      and '29 px over at 32px' in i.message
                      and 'Независимый reference' in i.message
                      and 'fewer columns' in i.message for i in exc.issues)
    check('columns subtitle: strict original refusal names the remedy', refused)
    check('columns subtitle: refused build publishes no PPTX',
          not os.path.exists(refused_path + '.pptx'))
    check('columns subtitle: no automatic content rewrite', original == source)


def test_columns_title_panel_clearance(out_dir):
    """The measured dark-slide title must clear its fixed white panel."""
    from deckkit import fit as FT

    deck = Deck(skill_dir=SKILL)
    samples = []
    for count in (3, 4, 5, 6):
        columns = [{'title': 'Этап %d' % i,
                    'text': 'Описание результата и следующего действия'}
                   for i in range(1, count + 1)]
        for lines in (1, 2, 3, 4):
            deck.columns('\n'.join(['Проверка длинного заголовка'] * lines),
                         columns)
            samples.append((count, lines))
    natural_title = ' '.join([
        'Оценка эффекта зависит от допущений модели и структуры данных'] * 2)
    deck.columns(natural_title,
                 [{'title': 'Этап %d' % i, 'text': 'Описание результата'}
                  for i in range(1, 4)])
    result = deck.build(os.path.join(out_dir, 'columns-title-clearance'),
                        strict=False, pptx=False, keep_html=True)
    document = Document.open(result.html_path, extra_dirs=[SKILL])
    roots = document.boxes()
    failures = [issue for issue in result.issues
                if issue.level == 'error' and issue.code == 'OVERFLOW']
    dense = [issue for issue in result.issues
             if issue.level == 'warning' and issue.code == 'COLUMNS_TITLE_DENSE']
    check('columns title: only four-line cases fail at the legal floor',
          [issue.slide for issue in failures] == [4, 8, 12, 16],
          repr([str(issue) for issue in failures]))
    check('columns title: all three-line cases warn, including natural wrap',
          [issue.slide for issue in dense] == [3, 7, 11, 15, 17]
          and all('shorten it to at most 2 lines' in issue.message
                  for issue in dense),
          repr([str(issue) for issue in dense]))
    for index, ((count, lines), root, size) in enumerate(
            zip(samples, roots[:len(samples)], result.sizes), 1):
        title = next(box for box in root.walk()
                     if box.kind == 'text' and 'slide-title' in box.classes())
        panel = next(box for box in root.walk()
                     if 'columns-panel' in box.classes())
        gap = panel.y - title.y - title.h
        expected_size = 64 if lines >= 3 else 88
        check('columns-%d title %d lines: measured legal step' % (count, lines),
              size.headline == expected_size and
              size.headline_fits == (lines <= 3) and
              len(title.lines) == lines,
              'slide %d: %s; lines %d' % (index, size, len(title.lines)))
        if lines <= 3:
            check('columns-%d title %d lines: panel has 24px clearance'
                  % (count, lines), gap >= 24,
                  'slide %d: gap %.1fpx' % (index, gap))
        else:
            message = next((issue.message for issue in failures
                            if issue.slide == index), '')
            check('columns-%d title four lines: measured remedy' % count,
                  gap < 0 and 'overlap %.1fpx' % -gap in message
                  and 'shorten the title' in message,
                  'slide %d: %s; gap %.1fpx' % (index, message, gap))

    # Move only the panel in this test Document. The title remains measured
    # from the real engine; the exact threshold is an independent 24px rule.
    root_index = samples.index((3, 3))
    element = document.elements[root_index]
    panel_element = F.first(element, 'columns-panel')
    title = next(box for box in roots[root_index].walk()
                 if box.kind == 'text' and 'slide-title' in box.classes())
    for gap, expected in ((24.1, True), (23.9, False)):
        document.set_style(panel_element, 'top', '%.1fpx' %
                           (title.y + title.h + gap))
        root = document.measure(element)
        actual = FT.headline_fits(root, {'columns-panel'}, 24, 24,
                                  'slide-title', 3)
        check('columns title: %.1fpx boundary is %s' % (gap, expected),
              actual == expected)

    natural = next(box for box in roots[-1].walk()
                   if box.kind == 'text' and 'slide-title' in box.classes())
    panel = next(box for box in roots[-1].walk()
                 if 'columns-panel' in box.classes())
    check('columns title: natural wrapping is measured against the panel',
          result.sizes[-1].headline == 64 and result.sizes[-1].headline_fits
          and len(natural.lines) == 3
          and panel.y - natural.y - natural.h >= 24,
          '%s; lines %d' % (result.sizes[-1], len(natural.lines)))


def test_emoji_and_structure(out_dir):
    deck = Deck(skill_dir=SKILL)
    deck.title('Заголовок')
    deck.cards('Итоги \U0001F680', [Card('Раз', 'Два', 'рост')])
    deck.final()
    result = deck.build(os.path.join(out_dir, 'emoji'), strict=False, pptx=False)
    check('emoji in text detected', any(i.code == 'EMOJI' for i in result.issues))

    # The separator dots · • ∙ ⋅ ride the same forbidden-char check.
    dots = Deck(skill_dir=SKILL)
    dots.title('Заголовок')
    dots.cards('Итоги · Выводы', [Card('• Раз', 'Два ⋅ Три', 'рост')])
    dots.final()
    dot_result = dots.build(os.path.join(out_dir, 'dot'), strict=False, pptx=False)
    check('separator dot in text detected',
          any(i.code == 'EMOJI' for i in dot_result.issues))

    bare = Deck(skill_dir=SKILL)
    bare.cards('Без титульного', [Card('Раз', 'Два', 'рост')])
    structure = bare.build(os.path.join(out_dir, 'structure'), strict=False, pptx=False)
    codes = [i.code for i in structure.issues]
    check('missing title slide detected', 'NO_TITLE' in codes, str(codes))
    check('missing final slide detected', 'NO_FINAL' in codes, str(codes))


def test_texts_cover_every_field(out_dir):
    """The content check reads every text field, not a list of known ones.

    `_texts_of` used to enumerate keys written for the card layouts; flow
    steps and summary, columns and a timeline point's title were never read,
    so an emoji or an arrow there built clean — one of the ten agent-written
    test decks shipped «→ → →» in a flow summary that way. The labels below
    are literal on purpose: one per field that used to be missed, plus the
    card fields that always worked.
    """
    mark = ' ✅'
    spec = {'slides': [
        {'layout': 'title', 'text': 'Проверка'},
        {'layout': 'flow', 'title': 'Шаги',
         'steps': [{'text': 'Сбор' + mark, 'icon': 'рост'},
                   {'text': 'Два', 'icon': 'команда'},
                   {'text': 'Три', 'icon': 'безопасность'},
                   {'text': 'Четыре', 'icon': 'деньги'}],
         'summary': {'title': 'Итог' + mark, 'text': 'Вывод' + mark}},
        {'layout': 'columns', 'title': 'Колонки',
         'columns': [{'title': 'Раз' + mark, 'text': 'Текст' + mark},
                     {'title': 'Два', 'text': 'Текст'},
                     {'title': 'Три', 'text': 'Текст'}]},
        {'layout': 'timeline', 'title': 'Годы',
         'points': [{'title': '2024' + mark, 'text': 'Старт' + mark},
                    {'title': '2025', 'text': 'Рост'},
                    {'title': '2026', 'text': 'План'}]},
        {'layout': 'cards', 'title': 'Карточки',
         'cards': [{'title': 'Раз' + mark, 'text': 'Два' + mark, 'icon': 'рост'},
                   {'title': 'Три', 'text': 'Четыре', 'icon': 'команда'}]},
        {'layout': 'final'}]}
    deck = SP.deck_from_spec(spec, skill_dir=SKILL)
    result = deck.build(os.path.join(out_dir, 'texts-cover'), strict=False,
                        pptx=False)
    found = set()
    for issue in result.issues:
        if issue.code == 'EMOJI':
            match = re.search(r'\(([^)]*)\)', issue.message)
            found.add((issue.slide, match.group(1) if match else ''))
    for slide, where in ((2, 'steps 1.text'), (2, 'summary.title'),
                         (2, 'summary.text'), (3, 'columns 1.title'),
                         (3, 'columns 1.text'), (4, 'points 1.title'),
                         (4, 'points 1.text'), (5, 'cards 1.title'),
                         (5, 'cards 1.text')):
        check('texts: emoji caught in slide %d %s' % (slide, where),
              (slide, where) in found, str(sorted(found)))
    check('texts: icon queries are not read as text',
          not any('icon' in where for _, where in found), str(sorted(found)))


def test_line_widths_agree(out_dir):
    """A line's width is measured once, by the layout, and read by everyone.

    Until 2.1 `widest_line` measured again and stripped the trailing space of
    every run; the wrapper makes each word its own run, so every space between
    words went missing and a line read up to ~100 px narrower than it was.
    """
    from deckkit import fit as FT
    from deckkit.html2pptx.textmeasure import measure_runs

    deck = SP.deck_from_spec(SP.load_spec(SP.example_spec_path(SKILL)),
                             skill_dir=SKILL)
    result = deck.build(os.path.join(out_dir, 'widths'), strict=False,
                        pptx=False, keep_html=True)
    document = Document.open(result.html_path, extra_dirs=[SKILL])
    texts = [box for root in document.boxes() for box in root.walk()
             if box.kind == 'text' and box.lines]
    check('line widths: one width per wrapped line',
          texts and all(len(b.line_widths) == len(b.lines) for b in texts))
    wrong = [(b, i) for b in texts for i, line in enumerate(b.lines)
             if abs(b.line_widths[i] - measure_runs(
                 line, document.fonts, b.style.get('font-family'),
                 b.font_size)) > 0.01]
    check('line widths: each is the layout measure of its line', not wrong,
          str(wrong[:3]))
    check('line widths: widest_line reads them',
          all(FT.widest_line(b) == max(b.line_widths) for b in texts))
    spaced = [b for b in texts if any(
        len([r for r in line if getattr(r, 'text', '').endswith(' ')]) > 1
        for line in b.lines)]
    check('line widths: spaces between words count',
          spaced and all(
              FT.widest_line(b) > max(
                  sum(document.fonts.get(b.style.get('font-family'), r.weight,
                                         b.font_size).getlength(r.text.rstrip(' '))
                      for r in line if hasattr(r, 'text'))
                  for line in b.lines) + 1.0
              for b in spaced[:5]),
          '%d multi-word boxes' % len(spaced))


def test_typeset():
    """Numbers, units, dashes, short words, initials and «г.» with its
    year do not break across lines.

    Expectations are written out, not computed from `typeset.py`'s own
    tables: a check derived from the code under test checks nothing.
    """
    from deckkit.typeset import typeset
    nb = '\u00a0'
    cases = (
        ('25 000 клиентов', '25' + nb + '000 клиентов'),
        ('1 200 000 ₽', '1' + nb + '200' + nb + '000' + nb + '₽'),
        ('= 4,5 млн ₽', '= 4,5' + nb + 'млн' + nb + '₽'),
        ('рост 15 %', 'рост 15' + nb + '%'),
        ('+1,5 п. п. к конверсии', '+1,5' + nb + 'п.' + nb + 'п. к' + nb
         + 'конверсии'),
        ('за 6 мин и 3 дня', 'за' + nb + '6' + nb + 'мин и' + nb + '3' + nb
         + 'дня'),
        ('№ 5', '№' + nb + '5'),
        ('рост — это главное', 'рост' + nb + '— это главное'),
        # Short words, since 2.3.0 everywhere; a chain glues whole.
        ('по бизнес-метрике', 'по' + nb + 'бизнес-метрике'),
        ('и не в объёме', 'и' + nb + 'не' + nb + 'в' + nb + 'объёме'),
        ('Решения не всегда', 'Решения не' + nb + 'всегда'),
        # Initials, either way round, and «г.» with its year.
        ('А. С. Пушкин', 'А.' + nb + 'С.' + nb + 'Пушкин'),
        ('Пушкин А. С.', 'Пушкин' + nb + 'А.' + nb + 'С.'),
        ('2024 г.', '2024' + nb + 'г.'),
        ('2023–2024 гг.', '2023–2024' + nb + 'гг.'),
        # Left alone: a year and a count, a word that starts like a unit,
        # a range without spaces, a word before a full stop, a particle.
        ('в 2024 100 клиентов', 'в' + nb + '2024 100 клиентов'),
        ('5 минут', '5 минут'),
        ('5–7 дней', '5–7' + nb + 'дней'),
        ('США. Далее', 'США. Далее'),
        ('мы бы смогли', 'мы бы смогли'),
        ('ИИ меняет', 'ИИ меняет'),
    )
    for source, expected in cases:
        got = typeset(source)
        check('typeset: %s' % source, got == expected,
              '%r, expected %r' % (got, expected))

    from lxml import html as lhtml
    root = lhtml.fromstring('<div><p class="a"></p><p class="b"></p>'
                            '<p class="c"></p></div>')
    plain, value, maths = root.xpath('//p')
    F.set_text(plain, 'итого 4,5 млн ₽')
    check('typeset: set_text glues by default',
          plain.text == 'итого 4,5' + nb + 'млн' + nb + '₽', repr(plain.text))
    F.set_text(value, '174 млрд', typeset=False)
    check('typeset: a metric value is left as written',
          value.text == '174 млрд', repr(value.text))
    F.set_text_formula(maths, 'доля 12 000 ₽ и \\(a + b\\)')
    span = maths.find('span')
    check('typeset: prose around a formula is glued',
          maths.text == 'доля 12' + nb + '000' + nb + '₽ и ', repr(maths.text))
    check('typeset: the formula source is untouched',
          span is not None and span.get('data-latex') == 'a + b',
          span.get('data-latex') if span is not None else 'no span')

    # End to end: the layout engine must keep U+00A0 (HTML collapses ASCII
    # whitespace only) and the wrapper must not break at it.
    deck = Deck(skill_dir=SKILL)
    deck.title('Проверка')
    text = ' '.join(['доход 4,5 млн ₽'] * 8)
    deck.grid('Узкие ячейки', [Card('Карта %d' % i, text, icon)
                               for i, icon in enumerate(
                                   ('рост', 'команда', 'безопасность',
                                    'деньги', 'цель', 'время'))])
    deck.final()
    out_dir = tempfile.mkdtemp(prefix='typeset-')
    try:
        result = deck.build(os.path.join(out_dir, 'typeset'), strict=False,
                            pptx=False, keep_html=True)
        document = Document.open(result.html_path, extra_dirs=[SKILL])
        lines = []
        for box in document.box(2).walk():
            if box.kind == 'text' and 'card-description' in box.classes():
                lines = [''.join(getattr(run, 'text', '') for run in line)
                         for line in box.lines]
                break
    finally:
        shutil.rmtree(out_dir, ignore_errors=True)
    check('typeset: the card wraps at all', len(lines) > 1, str(lines))
    # Where the breaks fall depends on the widths, so a missing glue need not
    # show up as a bad line end. That the laid-out lines still carry every
    # U+00A0 does not depend on them: it fails if the text was never glued
    # and if the engine collapsed the NBSP back into a space.
    glued = ''.join(lines).count('4,5' + nb + 'млн' + nb + '₽')
    check('typeset: NBSP survives into the laid-out lines', glued == 8,
          '%d of 8 glued: %s' % (glued, lines))
    broken = [line for line in lines
              if line.rstrip().endswith(('4,5', 'млн'))]
    check('typeset: no line ends inside «4,5 млн ₽»', not broken, str(lines))


def test_glue_steps_down():
    """2.3.0: a glued group too wide for its line steps the headline down.

    «Спасибо за внимание!» on the closing slide: «за внимание!» is one word
    once glued, 1059 px at 168 against a 1014 px column. Until 2.3.0 the
    search checked a headline's width only inside a fit-box, kept 168 and
    left the validator an OVERFLOW (`fit.headline_fits`).
    """
    out_dir = tempfile.mkdtemp(prefix='glue-')
    try:
        deck = SP.deck_from_spec({'slides': [
            {'layout': 'title', 'text': 'Проверка'},
            {'layout': 'final', 'text': 'Спасибо за внимание!'}]},
            skill_dir=SKILL)
        result = deck.build(os.path.join(out_dir, 'glue'), strict=False,
                            pptx=False, keep_html=True)
        document = Document.open(result.html_path, extra_dirs=[SKILL])
        sizes = [round(b.font_size) for b in document.box(2).walk()
                 if 'title-xlarge' in b.classes()]
    finally:
        shutil.rmtree(out_dir, ignore_errors=True)
    issues = [str(i) for i in result.issues if i.level == 'error']
    check('glue: the closing slide builds clean', not issues, str(issues))
    check('glue: «за внимание!» takes the step below 168',
          sizes and sizes[0] < 168, str(sizes))


def test_field_errors_2_3():
    """The user's agent read `fill` in the list of allowed fields and tried
    it (2026-10-04): the list leaves the switched-off field out. A
    chart_title on chart-cards is refused with where the name goes."""
    try:
        SP.deck_from_spec({'slides': [
            {'layout': 'title', 'text': 'x'},
            {'layout': 'chart-cards', 'title': 'T', 'chart_type': 'line',
             'chart_title': 'Конверсия',
             'data': {'categories': ['A', 'B'], 'series': [
                 {'name': 'S', 'values': [1, 2]}]},
             'cards': [{'title': 'a', 'text': 'b'}] * 3},
            {'layout': 'chart-two', 'title': 'T', 'charts': [
                {'chart_type': 'bar', 'chart_title': 'A', 'colour': 'red',
                 'data': {'categories': ['A'], 'series': [
                     {'name': 'S', 'values': [1]}]}},
                {'chart_type': 'bar', 'chart_title': 'B',
                 'data': {'categories': ['A'], 'series': [
                     {'name': 'S', 'values': [1]}]}}]}]}, skill_dir=SKILL)
        listed = []
    except SP.SpecError as exc:
        listed = exc.problems
    unknown = [p for p in listed if 'unknown field' in p]
    check('fields 2.3: both unknown fields are refused', len(unknown) == 2,
          str(listed))
    check('fields 2.3: the switched-off fill is not offered',
          unknown and not any(' fill' in p for p in unknown), str(unknown))
    check('fields 2.3: chart_title on chart-cards says the slide title '
          'names the chart', any('chart_title' in p and 'slide title' in p
                                 for p in unknown), str(unknown))


def test_final_and_title_2_3(out_dir):
    """2.3.0, the designers: the closing slide keeps its last line where
    «за внимание» stands and grows upward, in the HTML and in PowerPoint;
    the title slide without an author is centred under the logo, not on
    the slide, and the logo follows it part of the way. The closing text
    holds three lines at most: a fourth steps the size down, and one that
    keeps four at the smallest step is an error."""
    from pptx import Presentation
    deck = SP.deck_from_spec({'slides': [
        {'layout': 'title', 'text': 'Стратегия роста', 'subtitle': 'Итоги',
         'author': 'А. С. Пушкин'},
        {'layout': 'title', 'text': 'Стратегия роста', 'subtitle': 'Итоги'},
        {'layout': 'final', 'text': 'Вопросы?'},
        {'layout': 'final'},
        {'layout': 'final', 'text': 'Спасибо за внимание! Вопросы?'},
        {'layout': 'final', 'text': 'Спасибо за внимание! Жду ваших '
                                    'вопросов'},
    ]}, skill_dir=SKILL)
    result = deck.build(os.path.join(out_dir, 'final23'), strict=False,
                        keep_html=True)
    errors = [str(i) for i in result.issues if i.level == 'error']
    check('final 2.3: up to three lines build clean', not errors,
          str(errors))
    long_text = SP.deck_from_spec({'slides': [
        {'layout': 'title', 'text': 'Проверка'},
        {'layout': 'final', 'text': 'Спасибо за внимание! Вопросы, '
                                    'предложения и замечания пишите в чат'},
    ]}, skill_dir=SKILL).build(os.path.join(out_dir, 'final23-long'),
                               strict=False, pptx=False)
    errors = [i for i in long_text.issues if i.level == 'error']
    check('final 2.3: a text that keeps four lines at 112 is refused',
          [i.slide for i in errors] == [2]
          and 'more than 3 lines' in str(errors[0]), str(errors))
    document = Document.open(result.html_path, extra_dirs=[SKILL])

    def first(index, name):
        return [b for b in document.box(index).walk()
                if name in b.classes() and b.kind == 'text'][0]

    bottoms, tops = [], []
    for index in (3, 4, 5, 6):
        box = first(index, 'title-xlarge')
        bottoms.append(round(box.y + box.h))
        tops.append(round(box.y))
    check('final 2.3: the last line stays at 936, one line or three',
          all(abs(b - 936) <= 1 for b in bottoms), str(bottoms))
    lines = [len(first(i, 'title-xlarge').lines) for i in (3, 4, 5, 6)]
    sizes = [round(first(i, 'title-xlarge').font_size) for i in (3, 4, 5, 6)]
    check('final 2.3: three lines at most, a fourth steps the size down',
          lines == [1, 2, 3, 3] and sizes[3] < sizes[2], '%s %s'
          % (lines, sizes))
    check('final 2.3: «за внимание» in two lines keeps its place at 634',
          abs(tops[1] - 634) <= 1, str(tops))
    check('final 2.3: a longer text grows upward',
          tops[0] > tops[1] > tops[2], str(tops))

    slide = Presentation(result.pptx_path).slides[3]
    anchors = [sh.text_frame._txBody.bodyPr.get('anchor')
               for sh in slide.shapes if sh.has_text_frame
               and 'Спасибо' in sh.text_frame.text]
    check('final 2.3: PowerPoint anchors the text at the bottom',
          anchors == ['b'], str(anchors))

    def centre(index):
        title = first(index, 'title-large')
        box = [b for b in document.box(index).walk()
               if title in b.children][0]
        return round(box.y + box.h / 2.0)
    check('title 2.3: with an author the block stays centred on the slide',
          abs(centre(1) - 540) <= 1, str(centre(1)))
    check('title 2.3: without one it is centred under the logo, at 651',
          abs(centre(2) - 651) <= 1, str(centre(2)))
    logos = [round(first_logo.y) for first_logo in
             [[b for b in document.box(i).walk() if 'logo' in b.classes()][0]
              for i in (1, 2)]]
    check('title 2.3: the logo goes down with the block, 146 -> 200',
          logos == [146, 200], str(logos))


def test_title_two_lines(out_dir):
    """P14: two opening headline lines, with the existing composition and fit."""
    from pptx import Presentation
    long_title = 'Заголовок презентации\nочень длинный'
    spec = {'slides': [
        {'layout': 'title', 'text': 'Стратегия роста', 'author': 'Автор'},
        {'layout': 'title', 'text': 'Стратегия роста'},
        {'layout': 'title', 'text': 'Развиваем платформу\nдля новых продуктов',
         'subtitle': 'Планы команды', 'author': 'Автор'},
        {'layout': 'title', 'text': 'Развиваем платформу\nдля новых продуктов',
         'subtitle': 'Планы команды'},
        {'layout': 'title', 'text': long_title, 'subtitle': 'Короткое описание'},
        {'layout': 'title', 'text': long_title, 'author': 'Автор'},
        {'layout': 'title', 'text': 'Стратегия роста',
         'subtitle': 'Первая строка\nВторая строка\nТретья строка'},
    ]}
    result = SP.deck_from_spec(spec, skill_dir=SKILL).build(
        os.path.join(out_dir, 'title-two-lines'), strict=True, keep_html=True)
    doc = Document.open(result.html_path, extra_dirs=[SKILL])
    headings, logos, centres = [], [], []
    for i in range(1, 8):
        nodes = list(doc.box(i).walk())
        head = next(b for b in nodes if 'title-large' in b.classes())
        parent = next(b for b in nodes if head in b.children)
        headings.append((len(head.lines), head.font_size))
        logos.append(next(b.y for b in nodes if 'logo' in b.classes()))
        centres.append(parent.y + parent.h / 2.0)
    check('title two-lines: long headings step down to two lines at 128',
          headings == [(1, 200), (1, 200), (2, 144), (2, 144),
                       (2, 128), (2, 128), (1, 200)], str(headings))
    check('title two-lines: existing author and no-author composition',
          logos == [146, 200, 146, 200, 200, 146, 200]
          and centres == [540, 651, 540, 651, 651, 540, 651],
          '%s %s' % (logos, centres))
    subtitle = next(b for b in doc.box(7).walk()
                    if 'subtitle-large' in b.classes())
    check('title two-lines: the cap does not apply to subtitle lines',
          len(subtitle.lines) == 3, str(len(subtitle.lines)))
    native = []
    for slide in Presentation(result.pptx_path).slides:
        heads = [shape for shape in slide.shapes if shape.has_text_frame
                 and any(run.font.bold for paragraph in shape.text_frame.paragraphs
                         for run in paragraph.runs)]
        native.append((len(heads[0].text_frame.paragraphs),
                       {run.font.size.pt for paragraph in heads[0].text_frame.paragraphs
                        for run in paragraph.runs}))
    check('title two-lines: native paragraphs and editable point sizes',
          native == [(1, {150}), (1, {150}), (2, {108}), (2, {108}),
                     (2, {96}), (2, {96}), (1, {150})], str(native))
    api = Deck(skill_dir=SKILL)
    api.title(long_title, subtitle='Короткое описание')
    built = api.build(os.path.join(out_dir, 'title-two-lines-api'), strict=True,
                      pptx=False, keep_html=True)
    check('title two-lines: the Python helper follows the same ladder',
          built.sizes[0].headline == 128 and built.sizes[0].headline_fits)
    for author in (None, 'Автор'):
        data = {'layout': 'title', 'text': 'Первая строка\nВторая строка\nТретья строка'}
        if author:
            data['author'] = author
        failed = SP.deck_from_spec({'slides': [data]}, skill_dir=SKILL).build(
            os.path.join(out_dir, 'title-three-lines'), strict=False, pptx=False)
        errors = [i for i in failed.issues if i.level == 'error']
        check('title two-lines: three explicit lines are refused (%s)' % author,
              any(i.code == 'OVERFLOW' and i.slide == 1
                  and '2-line region even at 96px' in i.message
                  and 'shorten the title' in i.message for i in errors), str(errors))
    filler = 'обслуживание клиентов и партнёров банка в едином окне '
    for author in (None, 'Имя Фамилия'):
        boundaries = []
        for chars in (55, 56):
            boundary = Deck(skill_dir=SKILL)
            boundary.title((filler * 3)[:chars], subtitle='Подзаголовок', author=author)
            found = boundary.build(os.path.join(out_dir, 'title-boundary'),
                                   strict=False, pptx=False, keep_html=True)
            boundary_doc = Document.open(found.html_path, extra_dirs=[SKILL])
            head = next(b for b in boundary_doc.box(1).walk()
                        if 'title-large' in b.classes())
            boundaries.append((len(head.lines), head.font_size,
                               any(i.code == 'OVERFLOW' and i.level == 'error'
                                   for i in found.issues)))
        check('title two-lines: measured 55/56-char boundary (%s)' % author,
              boundaries == [(2, 96, False), (3, 96, True)], str(boundaries))
    strict = Deck(skill_dir=SKILL)
    strict.title('Первая строка\nВторая строка\nТретья строка')
    try:
        strict.build(os.path.join(out_dir, 'title-three-lines-strict'),
                     strict=True, pptx=False)
    except BuildError as exc:
        check('title two-lines: strict builds stop on the line limit',
              any(i.code == 'OVERFLOW' for i in exc.issues))
    else:
        check('title two-lines: strict builds stop on the line limit', False)
    from deckkit import autofit as A, typography as T
    subtitle_doc = Document.open(result.html_path, extra_dirs=[SKILL])
    subtitle_box = next(b for b in subtitle_doc.box(7).walk()
                        if 'subtitle-large' in b.classes())
    # Put only the subtitle outside the slide. The headline stays clear,
    # so a scope that accidentally omits subtitle geometry would fit it.
    subtitle_doc.set_style(subtitle_box.el, 'position', 'absolute')
    subtitle_doc.set_style(subtitle_box.el, 'top', '1200px')
    verdict = A._fit_headline(subtitle_doc, T.load(SKILL),
                              subtitle_doc.elements[6], 'title')
    check('title two-lines: subtitle geometry remains bounded',
          verdict == (96, False), str(verdict))
    loud = Deck(skill_dir=SKILL)
    loud.title('Стратегия роста', subtitle=('Обслуживание клиентов банка ' * 100))
    overflow = loud.build(os.path.join(out_dir, 'title-subtitle-bounds'),
                          strict=False, pptx=False)
    check('title two-lines: subtitle overflow still reports an error',
          not overflow.sizes[0].headline_fits
          and any(i.code == 'OVERFLOW' and i.level == 'error' for i in overflow.issues),
          str([str(i) for i in overflow.issues]))


def test_short_title(out_dir):
    """P15: cover-only short pair, exact input boundary and measured fallback."""
    from pptx import Presentation
    cases = [
        {'text': 'AI'},
        {'text': 'AI', 'subtitle': 'Описание', 'author': 'Автор'},
        {'text': 'Заголовок 12345', 'subtitle': 'Описание'},
        {'text': 'i' * 14, 'subtitle': 'Описание'},
        {'text': 'i' * 15, 'subtitle': 'Описание'},
        {'text': 'i' * 16, 'subtitle': 'Описание'},
        {'text': 'iiiiiii iiiiiii', 'subtitle': 'Описание'},
        {'text': 'iiiiiii iiiiiiii', 'subtitle': 'Описание'},
        {'text': 'iiiiiii\u00a0iiiiiii', 'subtitle': 'Описание'},
        {'text': 'iiiiiii\u00a0iiiiiiii', 'subtitle': 'Описание'},
        {'text': 'AI\nИИ', 'subtitle': 'Описание'},
        {'text': 'Ш' * 14, 'subtitle': 'Описание'},
        {'text': 'ШШШШШШШ ШШШШШШШ', 'subtitle': 'Описание', 'author': 'Автор'},
        {'text': 'AI', 'subtitle': 'Описание процессов команды и результатов работы. ' * 12,
         'author': 'Автор'},
        {'text': 'Заголовок презентации\nочень длинный', 'subtitle': 'Описание'},
        {'text': 'i' * 14 + ' ', 'subtitle': 'Описание'},
        {'text': 'i' * 15 + ' ', 'subtitle': 'Описание'},
    ]
    slides = [dict(case, layout='title') for case in cases]
    slides.extend([
        {'layout': 'statement', 'text': 'AI'},
        {'layout': 'timeline', 'title': 'AI', 'points': [
            {'title': 'Первый', 'text': 'Начало работы'},
            {'title': 'Второй', 'text': 'Проверка данных'},
            {'title': 'Третий', 'text': 'Результат команды'}]},
        {'layout': 'final', 'text': 'AI'},
    ])
    result = SP.deck_from_spec({'slides': slides}, skill_dir=SKILL).build(
        os.path.join(out_dir, 'short-title'), strict=True, keep_html=True)
    doc = Document.open(result.html_path, extra_dirs=[SKILL])
    headings, subtitles, centres, logos, lines = [], [], [], [], []
    for i in range(1, 18):
        boxes = list(doc.box(i).walk())
        head = next(b for b in boxes if 'title-large' in b.classes())
        subtitle = next(b for b in boxes if 'subtitle-large' in b.classes())
        parent = next(b for b in boxes if head in b.children)
        headings.append(head.font_size)
        subtitles.append(subtitle.font_size)
        centres.append(parent.y + parent.h / 2)
        logos.append(next(b.y for b in boxes if 'logo' in b.classes()))
        lines.append(len(head.lines))
    check('short title: <=15 only, spaces and NBSP count one each',
          headings == [200, 200, 200, 200, 200, 144, 200, 144, 200, 144,
                       144, 112, 200, 144, 128, 200, 144], str(headings))
    check('short title: 50px subtitle only when the enlarged pair fits',
          subtitles == [0, 50, 50, 50, 50, 40, 50, 40, 50, 40,
                        40, 40, 50, 40, 40, 50, 40], str(subtitles))
    check('short title: width and subtitle height fall back to standard',
          (headings[11], subtitles[11], headings[13], subtitles[13])
          == (112, 40, 144, 40), str((headings[11], subtitles[11], headings[13], subtitles[13])))
    check('short title: explicit breaks use standard; measured wrapping allows two',
          (lines[10], headings[10], lines[12], headings[12]) == (2, 144, 2, 200), str(lines))
    check('short title: the author/no-author composition is preserved',
          centres == [651, 540, 651, 651, 651, 651, 651, 651, 651, 651,
                      651, 651, 540, 540, 651, 651, 651]
          and logos == [200, 146, 200, 200, 200, 200, 200, 200, 200, 200,
                        200, 200, 146, 146, 200, 200, 200])
    other = [next(b.font_size for b in doc.box(i).walk()
                  if role in b.classes())
             for i, role in ((18, 'title-large'), (19, 'title-large'), (20, 'title-xlarge'))]
    check('short title: statements, timeline and final retain their scales',
          other == [144, 144, 168], str(other))
    native = []
    for slide in list(Presentation(result.pptx_path).slides)[:17]:
        heads = [s for s in slide.shapes if s.has_text_frame and any(
            run.font.bold for p in s.text_frame.paragraphs for run in p.runs)]
        native.append({r.font.size.pt for p in heads[0].text_frame.paragraphs for r in p.runs})
    check('short title: native editable headline sizes match the accepted pair',
          native == [{150}, {150}, {150}, {150}, {150}, {108}, {150}, {108},
                     {150}, {108}, {108}, {84}, {150}, {108}, {96}, {150}, {108}], str(native))
    for path in ('helper', 'add'):
        api = Deck(skill_dir=SKILL)
        if path == 'helper':
            api.title('AI', subtitle='Описание', author='Автор')
        else:
            api.add('title', {'text': 'AI', 'subtitle': 'Описание', 'author': 'Автор'})
        built = api.build(os.path.join(out_dir, 'short-title-' + path),
                          strict=True, pptx=False, keep_html=True)
        api_doc = Document.open(built.html_path, extra_dirs=[SKILL])
        sub = next(b for b in api_doc.box(1).walk() if 'subtitle-large' in b.classes())
        check('short title: JSON and %s agree' % path,
              built.sizes[0].headline == 200 and sub.font_size == 50)


def test_statement_looks(out_dir):
    """2.4.0, the designers' dividers: one `statement`, two looks.

    `look` picks the picture and nothing else - `glass` (the default) and
    `cards`, the designers' PNGs; the yellow pattern was retired. The cards look holds two
    lines, not three, and offers glass when the text needs a third. Two
    statements in a row are an error whatever their looks (the author,
    2026-10-04)."""
    def statement(look, text='Технологии должны быть невидимыми'):
        slide = {'layout': 'statement', 'text': text}
        if look:
            slide['look'] = look
        return slide

    def deck(middle):
        return SP.deck_from_spec({'slides': [
            {'layout': 'title', 'text': 'Проверка'}] + middle
            + [{'layout': 'final'}]}, skill_dir=SKILL)

    looks = deck([statement(None), _BETWEEN, statement('glass'), _BETWEEN,
                  statement('cards')])
    physical = [s.layout for s in looks.slides][1:-1:2]
    check('statement looks: each look is its own fragment',
          physical == ['statement-glass', 'statement-glass',
                       'statement-cards'], str(physical))
    check('statement looks: separated statements are no run',
          [i.code for i in VD.check_deck(looks)
           if i.code == 'STATEMENT_RUN'] == [])
    try:
        deck([statement('neon')])
        refused = ''
    except SP.SpecError as exc:
        refused = str(exc)
    check('statement looks: an unknown look is refused with the two',
          '"glass", "cards", not "neon"' in refused, refused)
    try:
        deck([statement('pattern')])
        refused = ''
    except SP.SpecError as exc:
        refused = str(exc)
    check('statement looks: the retired pattern look names its replacement',
          'retired in 2.4.0' in refused and '"glass"' in refused, refused)

    pair = [(i.code, i.level, i.slide)
            for i in VD.check_deck(deck([statement('glass'),
                                         statement('cards')]))
            if i.code == 'STATEMENT_RUN']
    check('statement looks: two in a row are an error, different looks or not',
          pair == [('STATEMENT_RUN', 'error', 3)], str(pair))

    # The designers' own text sets on two lines; a third line is refused and
    # the message offers glass. The background is one full-slide picture.
    codes = _codes_of(out_dir, 'statement-looks', [
        statement('cards', 'Основная мысль вашего слайда'), _BETWEEN,
        statement('cards'), _BETWEEN,
        statement('glass', '«Клиент видит результат, сложность остаётся '
                           'внутри»')])
    check('statement looks: cards hold two lines, glass three',
          [c for c, _ in codes] == ['STATEMENT_TOO_LONG'], str(codes))
    check('statement looks: the refusal offers glass',
          codes and 'here holds 2' in codes[0][1]
          and '"look": "glass"' in codes[0][1], str(codes))
    from pptx import Presentation
    result = deck([statement('cards', 'Растём вдвое')]).build(
        os.path.join(out_dir, 'statement-cards'), strict=False)
    shapes = Presentation(result.pptx_path).slides[1].shapes
    pictures = [sh for sh in shapes if sh.shape_type == 13
                and sh.left == 0 and sh.width == shapes[0].part.package
                .presentation_part.presentation.slide_width]
    check('statement looks: the cards background covers the slide',
          len(pictures) == 1, str(len(pictures)))


def test_card_glow(out_dir):
    """2.4.0, the designers' cards: an inner shadow on both - white on the
    yellow card (the glow), #C3C3C3 at 30 % on a grey one - written as the
    shape's own `a:innerShdw`, so it follows the card when resized. A
    translucent fill (the title's glass panel) keeps the image, since
    DrawingML would derive its shadow from the fill's alpha. Body text on a
    grey card is #444444, on the yellow one #333333."""
    from pptx import Presentation
    from pptx.oxml.ns import qn
    from deckkit.html2pptx import values as V
    result = SP.deck_from_spec({'slides': [
        {'layout': 'title', 'text': 'Проверка'},
        {'layout': 'cards', 'title': 'Карточки', 'cards': [
            {'title': 'Первая', 'text': 'Серая карточка', 'icon': 'звезда'},
            {'title': 'Вторая', 'text': 'Серая карточка', 'icon': 'рост'},
            {'title': 'Третья', 'text': 'Жёлтая карточка', 'icon': 'цель'}]},
    ]}, skill_dir=SKILL).build(os.path.join(out_dir, 'glow24'), strict=False)
    prs = Presentation(result.pptx_path)
    title, cards = prs.slides[0]._element, prs.slides[1]._element

    shadows = []
    for spPr in cards.iter(qn('p:spPr')):
        if spPr.find(qn('a:gradFill')) is None:
            continue
        found = [(s.get('blurRad'), s[0].get('val'),
                  [a.get('val') for a in s[0].findall(qn('a:alpha'))])
                 for s in spPr.iter(qn('a:innerShdw'))]
        shadows.append(found)
    blur = str(V.px_to_emu(56))
    grey, glow = (blur, 'C3C3C3', ['30000']), (blur, 'FFFFFF', [])
    check('card glow: every card carries one native inner shadow, the '
          'yellow last one white', shadows == [[grey], [grey], [glow]],
          str(shadows))
    pictures = len(list(cards.iter(qn('p:pic'))))
    check('card glow: no shadow images on the cards slide, only the icons',
          pictures == 3, str(pictures))
    check('card glow: the glass panel keeps its raster shadow',
          not list(title.iter(qn('a:innerShdw'))), 'innerShdw on the title')

    colours = {}
    for para in cards.iter(qn('a:p')):
        text = ''.join(t.text or '' for t in para.iter(qn('a:t')))
        if 'карточка' in text:
            colours[text] = sorted({c.get('val') for r in para.iter(qn('a:r'))
                                    for c in r.iter(qn('a:srgbClr'))})
    check('card glow: body text #444444 on grey cards, #333333 on yellow',
          colours == {'Серая карточка': ['444444'],
                      'Жёлтая карточка': ['333333']}, str(colours))


_VERSUS_TEXT = ('С другой стороны рамки и место обучения кадров требуют от нас '
                'анализа систем массового участия. С другой стороны '
                'консультация широким активом позволяет оценить значение')


def _versus(left, right, subtitles=True):
    """A versus slide from two texts, titled and (optionally) subtitled."""
    sides = []
    for title, text in (('Слева', left), ('Справа', right)):
        side = {'title': title, 'text': text}
        if subtitles:
            side['subtitle'] = 'Подзаголовок'
        sides.append(side)
    return {'layout': 'versus', 'sides': sides}


def test_versus(out_dir):
    """2.4.0, the designers' contrast slide. Both cards are native shapes of
    their own outline - `clip-path: path()` as a:custGeom with real curves -
    and so is the VS badge's glow: nothing on the slide is a picture. The
    yellow side is the left one, its gradient light at the top left (the
    angle python-pptx mirrored until 2.4.0). A side's text takes 3 to 6
    lines, the two differ by one at most, the title holds 3, and the
    subtitle is on both sides or neither (the author, on the gate deck)."""
    from pptx import Presentation
    from pptx.oxml.ns import qn
    result = SP.deck_from_spec({'slides': [
        {'layout': 'title', 'text': 'Проверка'},
        _versus(_VERSUS_TEXT, _VERSUS_TEXT),
        _BETWEEN,
        _versus(_VERSUS_TEXT, _VERSUS_TEXT, subtitles=False),
        {'layout': 'final'},
    ]}, skill_dir=SKILL).build(os.path.join(out_dir, 'versus24'))
    prs = Presentation(result.pptx_path)
    slide = prs.slides[1]._element

    outlines = [sp for sp in slide.iter(qn('p:spPr'))
                if sp.find(qn('a:custGeom')) is not None]
    check('versus: both cards are custom shapes with curves, not rectangles',
          len(outlines) == 2 and all(
              len(sp.findall('.//' + qn('a:cubicBezTo'))) >= 8
              and sp.find(qn('a:prstGeom')) is None for sp in outlines),
          str(len(outlines)))
    fills = [sp.find(qn('a:gradFill')) for sp in outlines]
    firsts = [f.find('.//' + qn('a:srgbClr')).get('val') if f is not None
              else None for f in fills]
    check('versus: yellow on the left, grey on the right',
          firsts == ['FFDD2D', 'EDEDED'], str(firsts))
    angle = fills[0].find(qn('a:lin')).get('ang') if fills[0] is not None else None
    check('versus: the yellow gradient runs to the bottom right, as in CSS '
          '(141.09deg = a:lin 51.09 deg clockwise)', angle == '3065400',
          str(angle))
    glows = len(list(slide.iter(qn('a:innerShdw'))))
    check('versus: the two cards and the badge glow natively',
          glows == 3, str(glows))
    check('versus: nothing on the slide is a picture',
          not list(slide.iter(qn('p:pic'))), 'p:pic found')
    texts = [''.join(t.text or '' for t in p.iter(qn('a:t')))
             for p in prs.slides[3]._element.iter(qn('a:p'))]
    check('versus: a side without a subtitle drops the subtitle',
          'Подзаголовок' not in texts and 'VS' in texts, str(texts))

    short = 'Сверка руками раз в неделю'
    codes = _codes_of(out_dir, 'versus-short', [_versus(short, _VERSUS_TEXT)])
    check('versus: a one-line side is VERSUS_SHORT, and so too far from '
          'the other side', sorted(c for c, _ in codes)
          == ['VERSUS_SHORT', 'VERSUS_SKEW'], str(codes))
    long_text = ' '.join([_VERSUS_TEXT] * 2)
    codes = _codes_of(out_dir, 'versus-long', [_versus(long_text, long_text)])
    check('versus: past six lines is VERSUS_TOO_LONG on each side',
          [c for c, _ in codes] == ['VERSUS_TOO_LONG'] * 2, str(codes))
    three = 'Аналитик сверяет выгрузки руками раз в неделю и пишет отчёт ' \
            'для команды, а расхождения разбирает уже потом'
    # 106 characters set on three lines, _VERSUS_TEXT on four, the longer
    # one on five: one line apart is allowed, two is not.
    five = _VERSUS_TEXT + '. Дополнительно постоянные расходы на найм и удержание'
    codes = _codes_of(out_dir, 'versus-skew', [
        _versus(three, five), _BETWEEN, _versus(three, _VERSUS_TEXT)])
    check('versus: sides two lines apart are VERSUS_SKEW, one line apart pass',
          [(c, m.split(';')[0]) for c, m in codes] == [
              ('VERSUS_SKEW', 'the left text takes 3 lines and the right 5')],
          str(codes))
    titled = _versus(_VERSUS_TEXT, _VERSUS_TEXT)
    titled['sides'][0]['title'] = ('Очень длинный заголовок левой стороны '
                                   'на много строк')
    codes = _codes_of(out_dir, 'versus-title', [titled])
    check('versus: a title past three lines is VERSUS_TOO_LONG',
          [c for c, _ in codes] == ['VERSUS_TOO_LONG'], str(codes))
    lopsided = _versus(_VERSUS_TEXT, _VERSUS_TEXT)
    del lopsided['sides'][1]['subtitle']
    try:
        SP.deck_from_spec({'slides': [{'layout': 'title', 'text': 'T'},
                                      lopsided]}, skill_dir=SKILL)
        refused = ''
    except SP.SpecError as exc:
        refused = str(exc)
    check('versus: a subtitle on one side only is refused by the spec',
          'both sides have a "subtitle"' in refused, refused)


def _plates_slide(look=None, chart_type='bar'):
    slide = {'layout': 'chart', 'title': 'Заголовок', 'chart_type': chart_type,
             'chart_title': 'Подзаголовок',
             'data': {'categories': ['Янв', 'Фев', 'Мар', 'Апр'],
                      'series': [{'name': 'Ряд %d' % i, 'values': v}
                                 for i, v in enumerate(
                                     ([4.3, 2.5, 3.5, 4.5],
                                      [2.4, 4.4, 1.8, 2.8],
                                      [2, 2, 3, 5]))]},
             'points': [{'text': 'Первый вывод', 'icon': 'галочка'},
                        {'text': 'Второй вывод', 'icon': 'галочка'}]}
    if chart_type == 'doughnut':
        slide['data'] = {'categories': ['A', 'B', 'C'],
                         'series': [{'name': 'Доля', 'values': [3, 2, 1]}]}
    if look:
        slide['look'] = look
    return slide


def test_charts_new_2_4(out_dir):
    """2.4.0, the designers' charts_new: `look: "plates"` on a chart (three
    plates, the chart on the front one); the first yellow a gradient on bars
    and the doughnut only; clusters at the designers' c:gapWidth 80 and
    c:overlap -5; the points' text #676767."""
    from lxml import etree
    from pptx import Presentation
    from pptx.oxml.ns import qn
    ns = {'c': 'http://schemas.openxmlformats.org/drawingml/2006/chart',
          'a': 'http://schemas.openxmlformats.org/drawingml/2006/main'}
    three = {'categories': ['A', 'B'],
             'series': [{'name': 'Ряд %d' % i, 'values': [1, 2]}
                        for i in range(3)]}
    ring = {'categories': ['A', 'B', 'C'],
            'series': [{'name': 'Доля', 'values': [1, 2, 3]}]}

    def xml(kind, data=three, mode=None):
        return etree.fromstring(_chart_render_xml(
            out_dir, kind, data, mode).encode('utf-8'))

    def gradient(root, path):
        stops = [(g.get('pos'), g.find('a:srgbClr', ns).get('val'))
                 for g in root.xpath(path + '/a:gradFill/a:gsLst/a:gs',
                                     namespaces=ns)]
        lin = root.xpath(path + '/a:gradFill/a:lin/@ang', namespaces=ns)
        return stops, lin

    bar = [('16000', 'FFDD2C'), ('100000', 'FFCB2C')]
    for kind, angle in (('bar', '5400000'), ('stacked', '5400000'),
                        ('bar_h', '10800000')):
        root = xml(kind)
        got = gradient(root, '//c:barChart/c:ser[1]/c:spPr')
        check('charts_new: %s starts with the yellow gradient' % kind,
              got == (bar, [angle]), str(got))
        check('charts_new: %s keeps the other series solid' % kind,
              len(root.xpath('//c:barChart//a:gradFill',
                             namespaces=ns)) == 1)
    got = gradient(xml('doughnut', ring), '//c:dPt[1]/c:spPr')
    check('charts_new: the doughnut\'s first slice is the yellow gradient',
          got == ([('0', 'FFDD2C'), ('88000', 'FFCB2C')], ['2700000']),
          str(got))
    check('charts_new: the line stays solid',
          not xml('line').xpath('//a:gradFill', namespaces=ns)
          and all(G.load_palette().gradient(kind, 'FFDD2D') is None
                  for kind in ('line', 'area'))
          and G.load_palette().gradient('bar', 'FFEE96') is None)
    check('charts_new: value mode stays solid',
          not xml('bar', {'categories': ['A', 'B'], 'series': [
              {'name': 's', 'values': [3, -2]}]}, 'value').xpath(
                  '//a:gradFill', namespaces=ns))

    root = xml('bar')
    check('charts_new: clusters at gapWidth 80, overlap -5',
          root.xpath('//c:gapWidth/@val', namespaces=ns) == ['80']
          and root.xpath('//c:overlap/@val', namespaces=ns) == ['-5'],
          str(root.xpath('//c:gapWidth/@val | //c:overlap/@val',
                         namespaces=ns)))
    root = xml('bar', {'categories': ['A', 'B'],
                       'series': [{'name': 's', 'values': [1, 2]}]})
    check('charts_new: one column per category keeps the px gap',
          root.xpath('//c:gapWidth/@val', namespaces=ns) != ['80'])
    from deckkit.html2pptx.textmeasure import FontBook
    crowded = CD.from_inline({
        'categories': ['К%d' % i for i in range(4)],
        'series': [{'name': 's%d' % i, 'values': [1, 2, 3, 4]}
                   for i in range(7)]})
    placed = G.place(G.ChartBox('bar_h', crowded),
                     G.Rect(100.0, 100.0, 800.0, 500.0), FontBook(SKILL))
    check('charts_new: a crowded bar_h gives the cluster gaps up',
          placed.geometry.overlap == 0
          and placed.geometry.gap_width != 80,
          '%r %r' % (placed.geometry.overlap, placed.geometry.gap_width))
    roomy = G.place(G.ChartBox('bar_h', CD.from_inline(three)),
                    G.Rect(100.0, 100.0, 800.0, 500.0), FontBook(SKILL))
    check('charts_new: a roomy bar_h takes them',
          roomy.geometry.overlap is None
          and roomy.geometry.gap_width == 80,
          '%r %r' % (roomy.geometry.overlap, roomy.geometry.gap_width))

    plain = SP.deck_from_spec({'slides': [
        {'layout': 'title', 'text': 'T'}, _plates_slide(),
        _plates_slide('plate'), _plates_slide('plates'),
        _plates_slide('plates', 'doughnut'), {'layout': 'final'}]},
        skill_dir=SKILL)
    physical = [s.layout for s in plain.slides][1:-1]
    check('charts_new: look picks the fragment, plate by default',
          physical == ['chart-points', 'chart-points',
                       'chart-points-plates', 'chart-points-plates'],
          str(physical))
    try:
        SP.deck_from_spec({'slides': [_plates_slide('stack')]},
                          skill_dir=SKILL)
        refused = ''
    except SP.SpecError as exc:
        refused = str(exc)
    check('charts_new: an unknown look is refused with the two',
          '"plate", "plates", not "stack"' in refused, refused)
    result = plain.build(os.path.join(out_dir, 'charts-new'), strict=False)
    long_series = dict(_plates_slide('plates'), data={
        'categories': ['К%d' % i for i in range(10)],
        'series': [{'name': 's', 'values': list(range(1, 11))}]})
    wide = [(i.code, i.slide) for i in VD.check_deck(SP.deck_from_spec(
        {'slides': [{'layout': 'title', 'text': 'T'}, long_series,
                    dict(long_series, look='plate'), {'layout': 'final'}]},
        skill_dir=SKILL)) if i.code == 'CHART_WIDTH']
    check('charts_new: CHART_WIDTH watches the plates look as well',
          wide == [('CHART_WIDTH', 2), ('CHART_WIDTH', 3)], str(wide))
    check('charts_new: the deck builds without errors',
          not [i for i in result.issues if i.level == 'error'],
          str([(i.code, i.message[:60]) for i in result.issues]))
    prs = Presentation(result.pptx_path)

    def plates(index):
        # The plates are native rounded rectangles, not pictures; the two
        # behind the chart are white at 60 % (the shadow under them is the
        # boxdeco raster, so it is not on the shape).
        out = []
        for sp in prs.slides[index]._element.iter(qn('p:sp')):
            geom = sp.find(qn('p:spPr') + '/' + qn('a:prstGeom'))
            if geom is None or geom.get('prst') != 'roundRect':
                continue
            colour = sp.find('.//' + qn('a:solidFill') + '/' + qn('a:srgbClr'))
            alpha = sp.find('.//' + qn('a:solidFill') + '//' + qn('a:alpha'))
            out.append((colour.get('val') if colour is not None else None,
                        alpha.get('val') if alpha is not None else None))
        return out
    behind = ('FFFFFF', '60000')
    check('charts_new: plates put two translucent plates behind the plate',
          plates(3).count(behind) == 2 and plates(1).count(behind) == 0,
          '%r vs %r' % (plates(3), plates(1)))
    check('charts_new: the plate holding the chart stays opaque',
          ('FFFFFF', None) in plates(3), str(plates(3)))
    for index in (1, 3):
        colours = set(
            c.get('val') for r in prs.slides[index]._element.iter(
                qn('a:rPr')) for c in r.findall(qn('a:solidFill')
                                                + '/' + qn('a:srgbClr')))
        check('charts_new: slide %d points are #676767' % index,
              '676767' in colours, str(sorted(colours)))


def _numbered(count, layout='grid', **card):
    return {'layout': layout, 'numbered': True, 'title': 'Этапы',
            'cards': [dict({'title': 'Этап', 'text': 'Короткое описание'},
                           **card) for _ in range(count)]}


def test_numbered_cards(out_dir):
    """2.4.0, the designers' numberd_cards: `"numbered": true` on a row or a
    grid. Every card is grey (no yellow last one) and a native shape with
    the notch - `clip-path: shape()` tied to the corner, as a:custGeom with
    curves - and its number sits in a glowing circle in the notch, where
    the icon would be: no pictures, no icon. A numbered card with an icon,
    an off count, a non-bool and the field on other layouts are refused."""
    from pptx import Presentation
    from pptx.oxml.ns import qn
    result = SP.deck_from_spec({'slides': [
        {'layout': 'title', 'text': 'Проверка'},
        _numbered(2, 'cards'), _numbered(3, 'cards'),
        _numbered(4, 'cards'), _numbered(4), _numbered(6), _numbered(8),
        dict(_numbered(3, 'cards'), numbered=False, cards=[
            {'title': 'Этап', 'text': 'Короткое описание', 'icon': icon}
            for icon in ('цель', 'рост', 'звезда')]),
        {'layout': 'final'},
    ]}, skill_dir=SKILL).build(os.path.join(out_dir, 'numbered24'),
                              keep_html=True)
    check('numbered: the deck builds without issues', not result.issues,
          str([(i.code, i.message[:60]) for i in result.issues]))
    prs = Presentation(result.pptx_path)
    for index, count in enumerate((2, 3, 4, 4, 6, 8), 1):
        slide = prs.slides[index]._element
        groups = [sh for sh in prs.slides[index].shapes
                  if getattr(sh, 'shapes', None) is not None]
        check('numbered %d: the disc and editable digit move together'
              % count,
              len(groups) == count and all(
                  len(group.shapes) == 2
                  and sum(bool(child.has_text_frame and
                               child.text.strip().isdigit())
                          for child in group.shapes) == 1
                  for group in groups),
              str([(len(group.shapes), [child.text if child.has_text_frame
                                        else '' for child in group.shapes])
                   for group in groups]))
        outlines = [sp for sp in slide.iter(qn('p:spPr'))
                    if sp.find(qn('a:custGeom')) is not None]
        check('numbered %d: each card is a custom shape with the notch' % count,
              len(outlines) == count and all(
                  len(sp.findall('.//' + qn('a:cubicBezTo'))) == 6
                  for sp in outlines), str(len(outlines)))
        firsts = set(sp.find('.//' + qn('a:srgbClr')).get('val')
                     for sp in outlines)
        check('numbered %d: every card is grey' % count,
              firsts == {'EDEDED'}, str(firsts))
        texts = [''.join(t.text or '' for t in p.iter(qn('a:t')))
                 for p in slide.iter(qn('a:p'))]
        digits = [t for t in texts if t.isdigit()]
        check('numbered %d: the cards are numbered 1 to N in order' % count,
              digits == [str(n) for n in range(1, count + 1)], str(digits))
        glows = len(list(slide.iter(qn('a:innerShdw'))))
        check('numbered %d: each card and each circle glow natively' % count,
              glows == 2 * count, str(glows))
        check('numbered %d: no icon, nothing is a picture' % count,
              not list(slide.iter(qn('p:pic'))), 'p:pic found')

    def body_sizes(slide):
        return set(r.find(qn('a:rPr')).get('sz')
                   for p in slide.iter(qn('a:p'))
                   if 'описание' in ''.join(t.text or '' for t in p.iter(qn('a:t')))
                   for r in p.iter(qn('a:r')))
    numbered, with_icons = (body_sizes(prs.slides[i]._element) for i in (2, 7))
    check('numbered: the text is set as large as beside an icon (the digit '
          'is not measured against the band)',
          len(numbered) == 1 and numbered == with_icons,
          '%s vs %s' % (numbered, with_icons))

    # The font metrics and box centre alone do not say where the ink lands.
    # Check the actual T-Sans glyph pixels for every supported digit on the
    # eight-card grid. The yellow disc contains no other dark content.
    from deckkit.preview import Preview
    document = Document.open(result.html_path, extra_dirs=[SKILL])
    cache_dir = tempfile.mkdtemp(prefix='decknumbered-')
    try:
        grid = document.box(7)
        image = Preview(document.assets(cache_dir), document.fonts).render(grid)
    finally:
        shutil.rmtree(cache_dir, ignore_errors=True)
    circles = [box for box in grid.walk()
               if 'card-number-circle' in box.classes()]
    offsets = []
    for circle in circles:
        x = int(round(circle.x))
        y = int(round(circle.y))
        ink_y = [py for py in range(y + 10, y + 90)
                 for px in range(x + 10, x + 90)
                 if max(image.getpixel((px, py))[:3]) < 105]
        if ink_y:
            offsets.append((min(ink_y) + max(ink_y)) / 2.0 -
                           (circle.y + circle.h / 2.0))
    check('numbered: all eight digits are optically centred in the preview',
          len(circles) == 8 and len(offsets) == 8
          and all(abs(offset) <= 0.5 for offset in offsets),
          str(offsets))

    def refusal(slide):
        try:
            SP.deck_from_spec({'slides': [{'layout': 'title', 'text': 'T'},
                                          slide]}, skill_dir=SKILL)
            return ''
        except SP.SpecError as exc:
            return str(exc)
    message = refusal(_numbered(4, icon='цель'))
    check('numbered: an icon on a numbered card is refused with the reason',
          'carries its number where the icon would be' in message, message)
    message = refusal(_numbered(1, 'cards'))
    check('numbered: a row of one is refused',
          'a numbered row takes 2 to 4 cards, got 1' in message, message)
    message = refusal(_numbered(5))
    check('numbered: a grid of five is refused',
          'a numbered grid takes' in message and 'got 5' in message, message)
    for count in (4, 6, 8):
        check('numbered: a grid of %d is accepted' % count,
              refusal(_numbered(count)) == '', refusal(_numbered(count)))
    bad = _numbered(2, 'cards')
    bad['numbered'] = 'yes'
    message = refusal(bad)
    check('numbered: a non-bool is refused',
          '"numbered" is true or false' in message, message)
    message = refusal(dict(_numbered(5, 'complex', icon='цель')))
    check('numbered: complex has no such field',
          'unknown field "numbered"' in message, message)
    plain = _numbered(2, 'cards')
    plain['numbered'] = False
    message = refusal(plain)
    check('numbered: false keeps the icon required',
          '"icon" field is required' in message, message)


def _series_slide(layout, count, **options):
    """Small, valid series content shared by the option and output checks."""
    if layout == 'timeline':
        data = {'points': [{'text': 'Короткое описание'} for _ in range(count)]}
    else:
        data = {'steps': [{'icon': icon, 'text': 'Короткое описание'}
                          for icon in ('щит', 'люди', 'ракета',
                                       'портфель', 'огонь')[:count]]}
    data.update(layout=layout, title='Этапы запуска')
    data.update(options)
    return data


# ------------------------------------------------------------------ tables

_TABLE_SLIDE = {
    'layout': 'table', 'title': 'Итоги квартала',
    'header': ['Показатель', 'Описание', 'Q1', 'Q2', 'Итог'],
    'rows': [['Выручка', 'Все каналы', {'text': '+1 000', 'tone': 'positive'},
              '1 200', '2 200'],
             ['Расходы', 'Операционные', '900',
              {'text': '−1 600', 'tone': 'negative'}, '−700'],
             ['Клиенты', 'Активные', '25 000', '26 000', '51 000']],
    'label_column': True, 'total_column': True}
_COMPARE_SLIDE = {
    'layout': 'table-compare', 'title': 'Два сегмента',
    'tables': [{'title': 'Розница', 'rows': [
                   {'label': 'Клиенты', 'value': '1 000'},
                   {'label': 'Доля', 'value': '25%'},
                   {'label': 'Рост', 'value': '+12%', 'tone': 'positive'}]},
               {'title': 'Бизнес', 'rows': [
                   {'label': 'Клиенты', 'value': '100'},
                   {'label': 'Доля', 'value': '5%'},
                   {'label': 'Рост', 'value': '−3%', 'tone': 'negative'}]}]}


def _spec_problems(slide):
    try:
        SP.deck_from_spec({'slides': [slide]}, skill_dir=SKILL,
                          _allow_draft=True)
    except SpecError as exc:
        return str(exc)
    return ''


def test_table_options():
    """Public tables: the spec's shape, `tone` on table cells only."""
    for slide in (_TABLE_SLIDE, _COMPARE_SLIDE):
        name = slide['layout']
        public = SP.deck_from_spec({'slides': [slide]}, skill_dir=SKILL)
        check('%s: accepted by ordinary specs' % name,
              public.slides[0].layout == name)

    deck = SP.deck_from_spec({'slides': [_TABLE_SLIDE]}, skill_dir=SKILL,
                             _allow_draft=True)
    data = deck.slides[0].data
    check('table: figure columns are found by their cells',
          data['numeric'] == [False, False, True, True, True],
          data['numeric'])
    check('table: label and total columns are Medium',
          data['strong'] == [True, False, False, False, True], data['strong'])
    check('table: a string cell becomes text with no tone',
          data['rows'][2][0] == {'text': 'Клиенты', 'tone': None})
    api = Deck(SKILL).table(_TABLE_SLIDE['title'], _TABLE_SLIDE['header'],
                            _TABLE_SLIDE['rows'], label_column=True,
                            total_column=True)
    check('table: spec and API give the same data',
          api.slides[0].data['numeric'] == data['numeric']
          and api.slides[0].layout == deck.slides[0].layout == 'table')

    for text, numeric in [('25 000', True), ('−1 600', True), ('+12%', True),
                          ('48 %', True), ('3,5 млн', True), ('120 ₽', True),
                          ('—', True), ('Q1', False), ('Выручка', False),
                          ('2024 год и далее', False), ('', False)]:
        check('table: %r reads as %s' % (text, 'a figure' if numeric
                                         else 'text'),
              E.TABLE.numeric(text) == numeric)

    bad = [
        ('a row shorter than the header',
         dict(_TABLE_SLIDE, rows=[['a', 'b']]), 'every row has a cell'),
        ('one column', dict(_TABLE_SLIDE, header=['a'], rows=[['x']]),
         '2 to 6 columns'),
        ('seven columns', dict(_TABLE_SLIDE, header=list('abcdefg'),
                               rows=[list('abcdefg')]), '2 to 6 columns'),
        ('nine rows', dict(_TABLE_SLIDE, rows=[_TABLE_SLIDE['rows'][2]] * 9),
         '8 rows at most'),
        ('an unknown tone', dict(_TABLE_SLIDE, rows=[
            ['a', 'b', {'text': '1', 'tone': 'green'}, '2', '3']]),
         '"tone" is "positive"'),
        ('a list in a cell', dict(_TABLE_SLIDE, rows=[
            ['a', 'b', ['1', '2'], '2', '3']]), 'a cell is a string'),
        ('a stray cell field', dict(_TABLE_SLIDE, rows=[
            ['a', 'b', {'text': '1', 'color': 'red'}, '2', '3']]),
         'unknown field "color"'),
        ('a non-boolean label_column', dict(_TABLE_SLIDE, label_column='yes'),
         '"label_column" is true or false'),
        ('one compare table', dict(_COMPARE_SLIDE,
                                   tables=_COMPARE_SLIDE['tables'][:1]),
         'exactly two'),
        ('a compare table of one row', dict(_COMPARE_SLIDE, tables=[
            dict(_COMPARE_SLIDE['tables'][0],
                 rows=_COMPARE_SLIDE['tables'][0]['rows'][:1]),
            _COMPARE_SLIDE['tables'][1]]), '2 to 6 rows'),
        ('a compare row without a value', dict(_COMPARE_SLIDE, tables=[
            {'title': 'a', 'rows': [{'label': 'x'}, {'label': 'y',
                                                     'value': '1'}]},
            _COMPARE_SLIDE['tables'][1]]), '"value" field is required'),
    ]
    for name, slide, expected in bad:
        problems = _spec_problems(slide)
        check('table: %s is refused' % name, expected in problems, problems)
        for route in ('add', 'method'):
            data = {k: v for k, v in slide.items() if k != 'layout'}
            try:
                api = Deck(SKILL)
                if route == 'add':
                    api.add(slide['layout'], data)
                elif slide['layout'] == 'table':
                    api.table(**data)
                else:
                    api.table_compare(**data)
                check('table: %s refused via %s' % (name, route), False)
            except ValueError as exc:
                check('table: %s refused via %s' % (name, route),
                      expected in str(exc), str(exc))

    for field, value in [('surprise', True), ('title', 5), ('notes', 17)]:
        slide = dict(_TABLE_SLIDE, **{field: value})
        check('table: invalid %s refused by spec' % field,
              bool(_spec_problems(slide)))
        payload = {k: v for k, v in slide.items() if k not in ('layout', 'notes')}
        try:
            Deck(SKILL).add('table', payload, notes=slide.get('notes'))
            check('table: invalid %s refused by add' % field, False)
        except ValueError:
            check('table: invalid %s refused by add' % field, True)


    # `tone` is a table field: on a card it stays an unknown field.
    problems = _spec_problems({'layout': 'cards', 'title': 'з', 'cards': [
        {'title': 'a', 'icon': 'shield', 'tone': 'positive'}]})
    check('table: tone is refused outside a table',
          'unknown field "tone"' in problems, problems)


def test_table_output(out_dir):
    """Native a:tbl on both layouts: one frame per table, no shapes for the
    cells, explicit plain style, the designers' rules and colours."""
    from pptx import Presentation
    from pptx.oxml.ns import qn
    deck = SP.deck_from_spec({'slides': [_TABLE_SLIDE, _COMPARE_SLIDE]},
                             skill_dir=SKILL, _allow_draft=True)
    result = deck.build(os.path.join(out_dir, 'tables'), strict=False)
    check('tables: the gate pair builds without errors', not result.errors,
          str(result.errors))
    prs = Presentation(result.pptx_path)
    slides = list(prs.slides)
    frames = [[s for s in slide.shapes if s.has_table] for slide in slides]
    check('tables: one native table on table, two on table-compare',
          [len(f) for f in frames] == [1, 2], [len(f) for f in frames])
    texts = [s.text_frame.text for slide in slides for s in slide.shapes
             if s.has_text_frame]
    check('tables: no cell is a text box of its own',
          not any(t in ('Выручка', '+1 000', 'Клиенты') for t in texts), texts)
    grid = frames[0][0].table
    check('tables: 1 header + 3 rows, 5 columns',
          (len(grid.rows), len(grid.columns)) == (4, 5))
    # Typesetting glues the digit groups of a figure, so a space in the data
    # reaches the file as an NBSP: "+1 000" is "+1\xa0000" in the cell.
    cell = lambda r, c: grid.cell(r, c).text.replace('\xa0', ' ')
    check('tables: cell text is the data',
          cell(1, 2) == '+1 000' and cell(0, 4) == 'Итог'
          and cell(3, 0) == 'Клиенты', [cell(1, 2), cell(0, 4), cell(3, 0)])
    tbl = frames[0][0]._element.graphic.graphicData.find(qn('a:tbl'))
    style = tbl.find(qn('a:tblPr')).find(qn('a:tableStyleId'))
    check('tables: No Style, No Grid',
          style is not None
          and style.text == '{2D5ABB26-0587-4C30-8999-92F81FD0307C}')
    xml = etree.tostring(tbl).decode('utf-8')
    check('tables: green and red are the designers\'',
          '8EBE66' in xml and 'FA9174' in xml)
    check('tables: no vertical rules',
          all(tc.find(qn('a:tcPr')).find(qn('a:lnL')).find(qn('a:noFill'))
              is not None for tc in tbl.iter(qn('a:tc'))))
    head = grid.cell(0, 0)._tc.find(qn('a:tcPr')).find(qn('a:lnB'))
    fill = head.find(qn('a:solidFill'))
    check('tables: a dark rule under the header',
          fill is not None and fill[0].get('val') == '333333'
          and int(head.get('w')) > 3 * 9525)
    last = grid.cell(3, 0)._tc.find(qn('a:tcPr')).find(qn('a:lnB'))
    check('tables: no rule under the last row',
          last.find(qn('a:noFill')) is not None)
    right = grid.cell(1, 2).text_frame.paragraphs[0]._p.find(qn('a:pPr'))
    check('tables: figures are set to the right', right.get('algn') == 'r')
    faces = set(r.get('typeface') for r in tbl.iter(qn('a:latin')))
    check('tables: Medium by face name', 'T-Sans Medium' in faces, faces)
    tones = [s for s in E.TABLE.TONES]
    check('tables: two tones only', tones == ['positive', 'negative'])

    compare = frames[1][0].table
    check('tables: compare tables are label + value',
          len(compare.columns) == 2 and compare.cell(2, 1).text == '+12%')
    left = frames[1][0].left
    check('tables: the yellow table is the left one',
          left < frames[1][1].left)


    line_spec = {'layout': 'table', 'title': 'Текст ячеек',
                 'header': ['A', 'B', 'C', 'D', 'E', 'F'],
                 'rows': [['Первая\nВторая', '100', '1', '2', '3', '4'],
                          ['Сверхдлинноесловодляпроверки', '200', '1', '2', '3', '4']]}
    line_deck = SP.deck_from_spec({'slides': [line_spec]}, skill_dir=SKILL,
                                  _allow_draft=True)
    line_result = line_deck.build(os.path.join(out_dir, 'table-lines'),
                                   strict=False, pptx=False)
    # Bypass the deck's deliberate overflow refusal to test writer fidelity.
    from deckkit.html2pptx.convert import write_pptx
    line_pptx = write_pptx(Document.open(line_result.html_path, extra_dirs=[SKILL]),
                          os.path.join(out_dir, 'table-lines-native.pptx'))
    line_frame = next(s for s in Presentation(line_pptx).slides[0].shapes
                      if s.has_table)
    check('tables: newline is preserved as a native soft break',
          line_frame.table.cell(1, 0).text == 'Первая\vВторая',
          repr(line_frame.table.cell(1, 0).text))
    check('tables: a long word preserves every character without inserted spaces',
          line_frame.table.cell(2, 0).text == 'Сверхдлинноесловодляпроверки',
          repr(line_frame.table.cell(2, 0).text))
    check('tables: premeasured lines disable PowerPoint wrapping',
          all(cell.text_frame._txBody.find(qn('a:bodyPr')).get('wrap') == 'none'
              for row in line_frame.table.rows for cell in row.cells))


def test_table_column_gaps(out_dir):
    """One measured/native inset after numbers, except the final column."""
    from pptx import Presentation
    from pptx.oxml.ns import qn
    from deckkit.html2pptx import tables as T
    from deckkit.preview import Preview

    patterns = [(True, False), (False, True), (True, True), (False, False),
                (True, False, True), (False, True, False),
                (True, True, False, True), (False, True, False, True, False),
                (True, False, True, False, True, True)]
    specs = [{'layout': 'table', 'title': 'Расстояние между колонками',
              'header': ['Колонка'] * len(flags),
              'rows': [[{'text': '123' if flag else 'Хорошо',
                         'tone': 'positive' if flag else None}
                        if flag else 'Хорошо' for flag in flags],
                       ['0' if flag else 'Проверить' for flag in flags]],
              'label_column': True, 'total_column': True}
             for flags in patterns]
    specs.append(copy.deepcopy(_COMPARE_SLIDE))
    result = SP.deck_from_spec({'slides': specs}, skill_dir=SKILL).build(
        os.path.join(out_dir, 'table-gaps'), strict=False, keep_html=True)
    check('table gaps: the column matrix builds without errors',
          not result.errors, str(result.errors))
    document = Document.open(result.html_path, extra_dirs=[SKILL])
    prs = Presentation(result.pptx_path)
    for index, flags in enumerate(patterns, 1):
        root = document.box(index)
        model = T.read(next(b for b in root.walk() if T.is_table(b)))
        native = next(s.table for s in prs.slides[index - 1].shapes if s.has_table)
        # 24px is the template's inter-column inset, 24*9525 = 228600 EMU.
        expected = [0 if flag and c == len(flags) - 1 else 24
                    for c, flag in enumerate(flags)]
        label = 'table gaps: pattern %s' % (flags,)
        check(label + ' measured header/body right insets',
              [[cell.margins[2] for cell in row] for row in model.cells]
              == [expected] * 3)
        check(label + ' native header/body right insets',
              [[cell.margin_right for cell in row.cells] for row in native.rows]
              == [[228600 if px else 0 for px in expected]] * 3)
        check(label + ' only final cells carry last-col',
              [[('last-col' in cell.box.classes()) for cell in row]
               for row in model.cells] == [[False] * (len(flags) - 1) + [True]] * 3)
        check(label + ' native numeric alignment retained',
              all(native.cell(r, c)._tc.find('.//' + qn('a:pPr')).get('algn')
                  == ('r' if flag else 'l')
                  for r in range(3) for c, flag in enumerate(flags)))
        check(label + ' following left insets remain zero',
              all(cell.margins[0] == 0 for row in model.cells for cell in row)
              and all(cell.margin_left == 0 for row in native.rows for cell in row.cells))

    compare_models = [T.read(b) for b in document.box(len(specs)).walk() if T.is_table(b)]
    compare_native = [s.table for s in prs.slides[-1].shapes if s.has_table]
    check('table gaps: compare measured label/value insets stay 24/0',
          len(compare_models) == 2 and
          all([cell.margins[2] for cell in row] == [24, 0]
              for model in compare_models for row in model.cells))
    check('table gaps: compare native label/value insets stay 228600/0',
          len(compare_native) == 2 and
          all([cell.margin_right for cell in row.cells] == [228600, 0]
              for table in compare_native for row in table.rows))

    # Actual preview ink: no dark text may enter the 23px band just before
    # the number/text boundary. Crop above the row rule and away from shadows.
    model = T.read(next(b for b in document.box(1).walk() if T.is_table(b)))
    left, right = model.cells[1]
    text = left.paragraphs[0].box
    image = Preview(document.assets(os.path.join(out_dir, 'table-gap-cache')),
                    document.fonts).render(document.box(1), index=1)
    band = image.crop((int(right.box.x) - 23, int(text.y),
                       int(right.box.x), int(text.y + sum(text.line_heights))))
    check('table gaps: preview has clear ink band between 123 and Хорошо',
          all(min(pixel[:3]) >= 150 for pixel in band.getdata()))
    check('table gaps: preview retained visible number and label',
          all(any(min(pixel[:3]) < 150 for pixel in image.crop((
              int(cell.box.x), int(text.y), int(cell.box.x + cell.box.w),
              int(text.y + sum(text.line_heights)))).getdata())
              for cell in (left, right)))

    # Raw generated prototypes must agree even before the public filler runs.
    for filename, count in [('57-table.html', 1), ('58-table-compare.html', 2)]:
        template = Document.open(os.path.join(SKILL, 'assets', 'layouts', filename),
                                 extra_dirs=[SKILL])
        models = [T.read(b) for b in template.box(1).walk() if T.is_table(b)]
        check('table gaps: %s final numeric prototypes stay flush' % filename,
              len(models) == count and all(
                  row[-1].margins[2] == 0 and 'last-col' in row[-1].box.classes()
                  for model in models for row in model.cells))
        check('table gaps: %s interior prototypes retain 24px' % filename,
              all(cell.margins[2] == 24 for model in models
                  for row in model.cells for cell in row[:-1]))


def test_table_limits(out_dir):
    """What a table cell may hold: a figure on one line, a heading in its
    row. Both are reported with the text, never silently shipped."""
    wide = dict(_TABLE_SLIDE, header=['a', 'b', 'c', 'd', 'e', 'f'],
                rows=[['Выручка', 'x', '1 000 000 000 000 000 000 000 000 000 000 000', '1',
                       '2', '3']])
    deck = SP.deck_from_spec({'slides': [wide]}, skill_dir=SKILL,
                             _allow_draft=True)
    result = deck.build(os.path.join(out_dir, 'table-wrap'), strict=False,
                        pptx=False)
    check('tables: a figure on two lines is TABLE_WRAP',
          any(i.code == 'TABLE_WRAP' for i in result.errors),
          str(result.errors))
    long_head = dict(_TABLE_SLIDE, header=[
        'Показатель', 'Очень длинный заголовок колонки, который не помещается '
        'в одну строку шапки таблицы', 'Q1', 'Q2', 'Итог'])
    deck = SP.deck_from_spec({'slides': [long_head]}, skill_dir=SKILL,
                             _allow_draft=True)
    result = deck.build(os.path.join(out_dir, 'table-head'), strict=False,
                        pptx=False)
    check('tables: a heading past its row is TABLE_HEAD_LONG',
          any(i.code == 'TABLE_HEAD_LONG' for i in result.errors),
          str(result.errors))
    full = dict(_TABLE_SLIDE, header=['a', 'b', 'c', 'd', 'e', 'f'],
                rows=[['Ваш текст', 'Текст описания', '+1 000', '25 000',
                       '−1 600', '600']] * 8)
    deck = SP.deck_from_spec({'slides': [full]}, skill_dir=SKILL,
                             _allow_draft=True)
    result = deck.build(os.path.join(out_dir, 'table-full'), strict=False,
                        pptx=False)
    check('tables: the designers\' 6x8 fits', not result.errors,
          str(result.errors))


    # Literal geometry: the 828px background stays fixed; only the table
    # consumes its 756px inner region. Small tables must not stretch rows.
    def white_table_geometry(result):
        document = Document.open(result.html_path, extra_dirs=[SKILL])
        boxes = list(document.boxes()[0].walk())
        card = next(b for b in boxes if 'table-card' in b.classes())
        grid = next(b for b in boxes if 'table-grid' in b.classes())
        region = next(b for b in boxes if 'table-region' in b.classes())
        return card, grid, region, boxes

    full_card, full_grid, full_region, _ = white_table_geometry(result)
    check('tables: full table fixed card and bounded viewport',
          (full_card.y, full_card.h, full_region.h) == (216, 828, 756)
          and full_grid.y == 246
          and full_grid.y + full_grid.h <= 1002.5)
    small = dict(_TABLE_SLIDE, header=['Показатель', 'Итог'],
                 rows=[['Доход', '100']])
    result = SP.deck_from_spec({'slides': [small]}, skill_dir=SKILL,
                               _allow_draft=True).build(
        os.path.join(out_dir, 'table-small-fixed'), strict=False, pptx=False)
    card, grid, region, boxes = white_table_geometry(result)
    check('tables: one-row table stays at top of full white card',
          not result.errors and (card.y, card.h) == (216, 828)
          and grid.y == 246 and grid.h < 200
          and result.sizes[0].pair == (36, 30), str(result.errors))

    dense = dict(_TABLE_SLIDE, header=list('ABCDEF'),
                 rows=[['Обслуживание клиентов и партнёров банка'] * 6] * 8)
    result = SP.deck_from_spec({'slides': [dense]}, skill_dir=SKILL,
                               _allow_draft=True).build(
        os.path.join(out_dir, 'table-dense-fixed'), strict=False, pptx=False)
    card, grid, region, boxes = white_table_geometry(result)
    body_sizes = {float(b.style.get('font-size').replace('px', ''))
                  for b in boxes if b.kind == 'text' and 'table-text' in b.classes()
                  and ''.join(r.text for line in b.lines for r in line) not in list('ABCDEF')}
    check('tables: dense table uses one shared legal body step in fixed card',
          not result.errors and card.h == 828 and grid.h <= 756.5
          and len(body_sizes) == 1
          and body_sizes.issubset({30, 28, 26, 24, 20})
          and result.sizes[0].pair_fits, str((result.errors, body_sizes)))
    # Refit must restore the search ceiling and reach the same result.
    document = Document.open(result.html_path, extra_dirs=[SKILL])
    from deckkit.autofit import fit as refit
    first = refit(document, SKILL, ['table'])[0]
    second = refit(document, SKILL, ['table'])[0]
    check('tables: measured fitting is repeatable',
          first.pair == second.pair == result.sizes[0].pair)
    overloaded = dict(dense, rows=[['Обслуживание клиентов ' * 6] * 6] * 8)
    result = SP.deck_from_spec({'slides': [overloaded]}, skill_dir=SKILL,
                               _allow_draft=True).build(
        os.path.join(out_dir, 'table-overloaded-fixed'), strict=False, pptx=False)
    card, grid, region, boxes = white_table_geometry(result)
    check('tables: overload refused at floor without growing card',
          card.h == 828 and result.sizes[0].pair == (36, 20)
          and not result.sizes[0].pair_fits
          and any(i.code == 'TABLE_HEIGHT' for i in result.errors),
          str(result.errors))

    six = dict(_COMPARE_SLIDE, tables=[
        {'title': 'Сегмент', 'rows': [{'label': 'Показатель', 'value': '100'}] * 6}
        for _ in range(2)])
    deck = SP.deck_from_spec({'slides': [six]}, skill_dir=SKILL,
                             _allow_draft=True)
    result = deck.build(os.path.join(out_dir, 'table-six'), strict=False,
                        pptx=False)
    check('tables: six compare rows fit without shrinking type',
          not result.errors, str(result.errors))
    long_label = dict(_COMPARE_SLIDE, tables=[
        {'title': 'Сегмент', 'rows': [
            {'label': ('Содержание ' * 50)[:200], 'value': '100'},
            {'label': 'Показатель', 'value': '200'}]}
        for _ in range(2)])
    deck = SP.deck_from_spec({'slides': [long_label]}, skill_dir=SKILL,
                             _allow_draft=True)
    result = deck.build(os.path.join(out_dir, 'table-label'), strict=False,
                        pptx=False)
    check('tables: compare label overflowing its row is refused',
          any(i.code == 'TABLE_CELL_LONG' for i in result.errors),
          str(result.errors))


def test_text_slide_options():
    """The prototype stays draft; prose slides are sparse in a deck."""
    text = {'layout': 'text-slide', 'title': 'Решение', 'text': 'Описание решения.'}
    between = {'layout': 'statement', 'text': 'Проверяем результат'}
    try:
        SP.deck_from_spec({'slides': [text]}, skill_dir=SKILL)
    except SpecError as exc:
        check('text-slide: draft excluded from ordinary specs',
              'unknown layout "text-slide"' in str(exc))
    else:
        check('text-slide: draft excluded from ordinary specs', False)
    deck = SP.deck_from_spec({'slides': [text]}, skill_dir=SKILL,
                             _allow_draft=True)
    check('text-slide: draft spec and API choose the same fragment',
          deck.slides[0].layout == Deck(SKILL).text_slide(
              'Решение', 'Описание решения.').slides[0].layout == 'text-slide')
    for count in range(5):
        slides = []
        for _ in range(count):
            slides.extend([text, between])
        deck = SP.deck_from_spec({'slides': slides or [between]},
                                 skill_dir=SKILL, _allow_draft=True)
        limits = [i for i in VD.check_deck(deck) if i.code == 'TEXT_SLIDE_LIMIT']
        check('text-slide: %d separated occurrences' % count,
              [i.slide for i in limits] == [5, 7][:max(0, count - 2)],
              str(limits))
        check('text-slide: separated occurrences do not trigger a run %d' % count,
              not any(i.code == 'TEXT_SLIDE_RUN' for i in VD.check_deck(deck)))
    deck = SP.deck_from_spec({'slides': [text, text]}, skill_dir=SKILL,
                             _allow_draft=True)
    errors = [i for i in VD.check_deck(deck) if i.code == 'TEXT_SLIDE_RUN']
    check('text-slide: two adjacent slides rejected with a remedy',
          len(errors) == 1 and errors[0].level == 'error'
          and errors[0].slide == 2 and 'between' in errors[0].message)
    for field in ('title', 'text'):
        for value in ('', None, 123, ['текст']):
            bad = dict(text, **{field: value})
            try:
                SP.deck_from_spec({'slides': [bad]}, skill_dir=SKILL,
                                  _allow_draft=True)
            except SpecError as exc:
                check('text-slide: invalid %s %r' % (field, value),
                      field in str(exc))
            else:
                check('text-slide: invalid %s %r' % (field, value), False)


def test_text_slide_output(out_dir):
    """Bottom growth, measured arrow fallback and native panel/text output."""
    from pptx import Presentation
    from pptx.oxml.ns import qn
    phrase = 'Обслуживание клиентов и партнёров банка в едином окне. '
    cases = [
        ('Проверка', 'Короткое описание.', True),
        ('Заголовок слайда вашей презентации', phrase * 6, True),
        ('Следующий этап\nРезультат', 'Первый этап.\nВторой этап.\nТретий этап.', True),
        ('Объединяем обслуживание клиентов и партнёров банка', phrase * 20, True),
        ('Улучшаем обслуживание корпоративных клиентов банка', phrase * 6, True),
        ('Первый\nВторой\nТретий', phrase, False),
        ('Ш' * 150, phrase, False),
        ('Результат', phrase * 150, False),
        ('Результат', 'Ш' * 200, False),
        ('Результат', '\n'.join(['Этап'] * 30), False),
    ]
    arrows = []
    for index, (title, text, fits) in enumerate(cases):
        deck = Deck(SKILL).text_slide(title, text)
        result = deck.build(os.path.join(out_dir, 'text-slide-%d' % index),
                            strict=False, pptx=index == 0, keep_html=True)
        overflow = [i for i in result.errors if i.code == 'OVERFLOW']
        check('text-slide: fit case %d' % index, bool(overflow) != fits,
              str(result.errors))
        if not fits:
            check('text-slide: remedies address prose case %d' % index,
                  bool(overflow) and all('farewell' not in i.message
                                        and 'metrics' not in i.message
                                        for i in overflow))
            continue
        root = Document.open(result.html_path, extra_dirs=[SKILL]).box(1)
        body = next(b for b in root.walk() if 'text-body' in b.classes())
        region = next(b for b in root.walk() if 'text-body-region' in b.classes())
        head = next(b for b in root.walk()
                    if b.kind == 'text' and 'title-large' in b.classes())
        arrow = next(b for b in root.walk() if 'text-arrow' in b.classes())
        check('text-slide: body bottom fixed at 934px case %d' % index,
              abs(body.y + body.h - 934) < 0.01)
        check('text-slide: body fits the expanded explicit region case %d' % index,
              region.style.get('height', '').endswith('px')
              and region.h > 334 and body.y >= region.y - 0.5
              and body.font_size >= 32)
        check('text-slide: body upper edge clears the headline case %d' % index,
              region.y >= head.y + head.h + 48 - 0.01)
        check('text-slide: arrow within panel case %d' % index,
              arrow.x >= 40 and arrow.x + arrow.w <= 1880
              and arrow.y >= 40 and arrow.y + arrow.h <= 1040)
        check('text-slide: arrow clears body horizontally or vertically case %d'
              % index,
              arrow.x >= region.x + region.w + 40 - 0.01
              or arrow.x + arrow.w <= region.x - 40 + 0.01
              or region.y >= arrow.y + arrow.h + 32 - 0.01)
        y = head.y
        clear = True
        for width, height in zip(head.line_widths, head.line_heights):
            clear = clear and (arrow.x >= head.x + width or arrow.y >= y + height
                               or arrow.y + arrow.h <= y)
            y += height
        check('text-slide: arrow clears every heading line case %d' % index, clear)
        arrows.append((arrow.x, arrow.y))
        if index == 0:
            prs = Presentation(result.pptx_path)
            body_shape = next(s for s in prs.slides[0].shapes
                              if s.has_text_frame and 'Короткое' in s.text)
            props = body_shape.text_frame._txBody.find(qn('a:bodyPr'))
            check('text-slide: native bottom anchor and wrapping disabled',
                  props.get('anchor') == 'b' and props.get('wrap') == 'none')
            check('text-slide: native body bottom matches shared layout',
                  abs(body_shape.top + body_shape.height - 8896350) <= 1)
            panel = next(s for s in prs.slides[0].shapes
                         if s.width == 17526000 and s.height == 9525000)
            shadow = next(panel._element.iter(qn('a:innerShdw')), None)
            check('text-slide: native shared white card glow',
                  shadow is not None and shadow.get('blurRad') == '533400'
                  and shadow.find(qn('a:srgbClr')).get('val') == 'FFFFFF')
            gradient = panel._element.find('.//' + qn('a:gradFill'))
            check('text-slide: native shared yellow card gradient',
                  gradient is not None
                  and [s[0].get('val') for s in gradient.find(qn('a:gsLst'))]
                  == ['FFDD2D', 'FDBD24'])
            check('text-slide: arrow is included in the PPTX',
                  any(s.shape_type == 13 for s in prs.slides[0].shapes))
    check('text-slide: arrow follows measured heading geometry',
          len(set(arrows)) >= 4, str(arrows))
    # A one-line 144px headline with an arrow above the prose leaves
    # 508.4px: 14 lines at the 32px floor need 537.6px and must be refused.
    boundary = Deck(SKILL).text_slide('Рост', '\n'.join(['Этап'] * 14))
    result = boundary.build(os.path.join(out_dir, 'text-slide-boundary'),
                            strict=False, pptx=False)
    check('text-slide: body does not shrink below 32px to fit extra lines',
          result.sizes[0].pair == (32, 32) and not result.sizes[0].pair_fits
          and any(i.code == 'OVERFLOW' and i.level == 'error'
                  and 'above' in i.message for i in result.issues))


def test_text_slide_ladder(out_dir):
    """Each readable step is selected after expanding the available region."""
    from pptx import Presentation
    from pptx.oxml.ns import qn
    from deckkit import autofit as AF
    from deckkit import typography as TP
    check('text-slide: four prose steps only',
          TP.load(SKILL).candidates('text-slide')
          == [(44, 44), (40, 40), (36, 36), (32, 32)])
    # The one-line 144px headline and its arrow leave 508.4px. At 120%
    # leading, 9/10/11/12 explicit lines first fit at 44/40/36/32px.
    for lines, size, native in ((9, 44, '3300'), (10, 40, '3000'),
                                (11, 36, '2700'), (12, 32, '2400')):
        deck = Deck(SKILL).text_slide('Рост', '\n'.join(['Этап'] * lines))
        result = deck.build(os.path.join(out_dir, 'text-ladder-%d' % size),
                            strict=False, keep_html=True)
        check('text-slide: %d lines select %dpx' % (lines, size),
              not result.errors and result.sizes[0].pair == (size, size)
              and result.sizes[0].pair_fits, str(result.issues))
        doc = Document.open(result.html_path, extra_dirs=[SKILL])
        root = doc.box(1)
        region = next(b for b in root.walk() if 'text-body-region' in b.classes())
        check('text-slide: measured upper bound at 425.6px for %dpx' % size,
              abs(region.y - 425.6) < 0.01 and abs(region.h - 508.4) < 0.01)
        prs = Presentation(result.pptx_path)
        body = next(s for s in prs.slides[0].shapes
                    if s.has_text_frame and 'Этап' in s.text)
        props = list(body._element.iter(qn('a:rPr')))
        check('text-slide: actual PPTX font is %dpx' % size,
              bool(props) and all(p.get('sz') == native for p in props))
        again = AF.fit(doc, SKILL, ['text-slide'])
        check('text-slide: refitting the saved document is stable for %dpx' % size,
              again[0].headline == result.sizes[0].headline
              and again[0].pair == result.sizes[0].pair
              and again[0].fits == result.sizes[0].fits)


def test_series_options():
    """Series options preserve the old defaults and reject invalid choices.

    Keep expected slugs and refusal strings literal: mutating the count
    table, default, summary guard or boolean check must fail this test.
    """
    for count in (3, 4, 5):
        for look in (None, 'grey'):
            slide = _series_slide('timeline', count, look=look)
            deck = SP.deck_from_spec({'slides': [slide]}, skill_dir=SKILL)
            check('series: grey timeline %d, look=%s' % (count, look),
                  deck.slides[0].layout == 'timeline-%d' % count)
    for count, slug in ((4, 'timeline-4-yellow'), (5, 'timeline-5-yellow')):
        deck = SP.deck_from_spec({'slides': [
            _series_slide('timeline', count, look='yellow')]}, skill_dir=SKILL)
        check('series: yellow timeline %d' % count,
              deck.slides[0].layout == slug)

    summary = {'title': 'Итог', 'text': 'Готово'}
    for count in (4, 5):
        for look in (None, 'line', 'zigzag'):
            for focus in (False, True):
                slide = _series_slide('flow', count, look=look,
                                      highlight_last=focus)
                deck = SP.deck_from_spec({'slides': [slide]}, skill_dir=SKILL)
                picked = deck.slides[0]
                expected = 'flow-%d%s' % (count, '-zigzag'
                                          if look == 'zigzag' else '')
                check('series: flow %d %s focus=%s selects its fragment'
                      % (count, look, focus), picked.layout == expected)
                node = S.render(deck.fragments, picked.layout, picked.data,
                                deck.icons, '')
                steps = F.by_class(node, 'flow-step')
                focuses = [i for i, step in enumerate(steps)
                           if 'focus' in step.get('class', '').split()]
                into = [i for i, step in enumerate(steps)
                        if 'into-focus' in step.get('class', '').split()]
                check('series: only the last flow step and its incoming '
                      'connector are highlighted (%d %s %s)'
                      % (count, look, focus),
                      focuses == ([count - 1] if focus else [])
                      and into == ([count - 2] if focus else []),
                      '%s %s' % (focuses, into))
        deck = SP.deck_from_spec({'slides': [
            _series_slide('flow', count, look='line', summary=summary,
                          highlight_last=True)]}, skill_dir=SKILL)
        check('series: linear flow %d keeps its summary' % count,
              deck.slides[0].layout == 'flow-%d-summary' % count)

    bad = [
        (_series_slide('timeline', 3, look='yellow'), '4 or 5 points'),
        (_series_slide('flow', 4, look='zigzag', summary=summary),
         'omit "summary" or use "look": "line"'),
        (_series_slide('flow', 5, look='zigzag', summary=summary),
         'takes no summary'),
        (_series_slide('flow', 3), '4 or 5 steps'),
        (_series_slide('timeline', 6), '3 to 5 points'),
    ]
    for layout, count, choices in (('timeline', 4, '"grey", "yellow"'),
                                    ('flow', 4, '"line", "zigzag"')):
        for look in ('neon', 'pattern', '', False, [], {}):
            bad.append((_series_slide(layout, count, look=look),
                        'must be a string' if not isinstance(look, str)
                        else choices))
    for value in ('true', 1, 0, [], {}):
        bad.append((_series_slide('flow', 4, highlight_last=value),
                    '"highlight_last" is true or false'))
    for slide, hint in bad:
        try:
            SP.deck_from_spec({'slides': [slide]}, skill_dir=SKILL)
            refused = ''
        except SpecError as exc:
            refused = str(exc)
        check('series: rejects %s with a useful hint' % repr(slide),
              hint in refused and 'retired' not in refused, refused)

    # Invalid look/count combinations must be refused before icon lookup.
    bad_icons = _series_slide('flow', 4, look='zigzag', summary=summary)
    bad_icons['steps'] = [{'icon': 'no-such-icon', 'text': 'X'}] * 4
    try:
        Deck(SKILL).add('flow', {k: v for k, v in bad_icons.items()
                                if k != 'layout'})
        refused = ''
    except ValueError as exc:
        refused = str(exc)
    check('series: variant constraints precede icon allocation',
          'takes no summary' in refused, refused)

    api = Deck(SKILL)
    points = _series_slide('timeline', 4)['points']
    steps = _series_slide('flow', 4)['steps']
    api.timeline('Этапы', points)
    api.timeline('Этапы', points, look='yellow')
    api.flow('Шаги', steps, summary)
    api.flow('Шаги', steps, look='zigzag', highlight_last=True)
    check('series: old positional API and new keyword options',
          [s.layout for s in api.slides] == [
              'timeline-4', 'timeline-4-yellow', 'flow-4-summary',
              'flow-4-zigzag'])
    for options, hint in (({'look': 'neon'}, '"line", "zigzag"'),
                          ({'look': []}, '"line", "zigzag"'),
                          ({'highlight_last': 1}, 'true or false')):
        try:
            api.flow('Шаги', steps, **options)
            refused = ''
        except ValueError as exc:
            refused = str(exc)
        check('series: direct API refuses %s' % repr(options),
              hint in refused, refused)


def test_series_output(out_dir):
    """The new fragments fit and their gradients reach the actual PPTX.

    Preview geometry alone cannot prove native gradient and inner-shadow
    properties. Inspect the emitted DrawingML as well as the shared boxes.
    """
    from pptx import Presentation
    from pptx.oxml.ns import qn
    cases = [_series_slide('timeline', 4, look='yellow'),
             _series_slide('timeline', 5, look='yellow'),
             _series_slide('flow', 4, look='zigzag'),
             _series_slide('flow', 5, look='zigzag', highlight_last=True),
             _series_slide('flow', 4, look='line', highlight_last=True),
             _series_slide('flow', 5, summary={'title': 'Итог', 'text': 'Готово'},
                           highlight_last=True)]
    deck = SP.deck_from_spec({'slides': cases}, skill_dir=SKILL)
    result = deck.build(os.path.join(out_dir, 'series24'),
                        strict=False, keep_html=True)
    check('series: representative deck has no errors',
          not result.errors, str(result.errors))
    prs = Presentation(result.pptx_path)
    doc = Document.open(result.html_path, extra_dirs=[SKILL])
    designer = [('0', 'FC8A17', ['80000']), ('19000', '333333', []),
                ('74000', '333333', []), ('100000', 'FC8A17', ['80000'])]
    for index in (0, 1):
        root = prs.slides[index]._element
        fills = list(root.iter(qn('a:rPr')))
        gradients = [r.find(qn('a:gradFill')) for r in fills]
        gradients = [g for g in gradients if g is not None]
        actual = [[(s.get('pos'), s[0].get('val'),
                    [a.get('val') for a in s[0].findall(qn('a:alpha'))])
                   for s in g.find(qn('a:gsLst'))] for g in gradients]
        check('series: yellow timeline %d title uses the designer gradient'
              % (index + 4), bool(actual) and all(s == designer for s in actual),
              str(actual))
        check('series: title gradient order and direction %d' % index,
              all([c.tag for c in g] == [qn('a:gsLst'), qn('a:lin')]
                  and g.find(qn('a:lin')).get('ang') == '2700000'
                  for g in gradients) and bool(gradients))
        check('series: yellow timeline has a full-slide background %d' % index,
              any(sh.shape_type == 13 and sh.left == 0 and sh.top == 0
                  and sh.width == prs.slide_width and sh.height == prs.slide_height
                  for sh in prs.slides[index].shapes))

    for index in (2, 3):
        boxes = doc.box(index + 1)
        icons = [b for b in boxes.walk() if 'flow-icon' in b.classes()]
        captions = [b for b in boxes.walk() if 'flow-caption' in b.classes()]
        check('series: zigzag %d icons share a row' % len(icons),
              len(icons) == index + 2 and max(b.y for b in icons)
              - min(b.y for b in icons) < 1)
        check('series: zigzag captions alternate above and below',
              [b.y < icons[i].y for i, b in enumerate(captions)]
              == ([True, False, True, False] if index == 2
                  else [True, False, True, False, True]))
        check('series: zigzag captions have explicit 210 px fit bounds',
              all('fit-box' in b.classes() and abs(b.h - 210) < 1
                  for b in captions) and len(captions) == len(icons))

    for index, focused in ((2, False), (3, True), (4, True), (5, True)):
        root = prs.slides[index]._element
        shapes = list(root.iter(qn('p:spPr')))
        circles, connectors, regular_lines = [], [], []
        for shape in shapes:
            grad = shape.find(qn('a:gradFill'))
            if grad is None:
                continue
            stops = [(s.get('pos'), s[0].get('val'),
                      [a.get('val') for a in s[0].findall(qn('a:alpha'))])
                     for s in grad.find(qn('a:gsLst'))]
            if stops == [('0', 'FFDD2C', []), ('80000', 'FFCB2C', []),
                         ('100000', 'FFCB2C', [])]:
                circles.append(shape)
            if stops == [('0', 'FFCB2C', ['0']),
                         ('100000', 'FFCB2C', [])]:
                connectors.append(shape)
            if stops == [('0', 'EFEFEF', ['0']),
                         ('25000', 'EFEFEF', ['35000']),
                         ('40000', 'EFEFEF', [])]:
                regular_lines.append(shape)
        check('series: focus writes one yellow circle and incoming gradient %d'
              % index, len(circles) == int(focused)
              and len(connectors) == int(focused))
        check('series: regular connectors remain grey %d' % index,
              len(regular_lines) == ((4 if index in (2, 4) else 5)
                                     - 1 - int(focused)),
              str(len(regular_lines)))
        check('series: focused connector fades yellow alpha, not grey %d'
              % index,
              not connectors or all(
                  sh.find(qn('a:gradFill')).find(qn('a:lin')).get('ang') == '0'
                  for sh in connectors))
        if focused and circles:
            shadow = circles[0].find('.//' + qn('a:innerShdw'))
            # 18 px * 9525 EMU/px = 171450, independent of the CSS.
            check('series: focused circle keeps its native white inner glow',
                  shadow is not None and shadow.get('blurRad') == '171450'
                  and shadow[0].get('val') == 'FFFFFF')

    long = _series_slide('flow', 4, look='zigzag')
    long['steps'][0]['text'] = 'Подробное описание процесса ' * 120
    codes = _codes_of(out_dir, 'series24-overflow', [long])
    check('series: long zigzag caption reports overflow at the bottom step',
          any(c == 'OVERFLOW' for c, _ in codes), str(codes))


def test_final_2_4(out_dir):
    """2.4.0, the designers: the closing slide stands on their PNG - the
    glass panel over a glass heart - and its letters carry their gradient,
    #333333 to 66 % and then into #FC8A17 at 80 % opacity at 45 degrees.
    In the PPTX that is an `a:gradFill` in every run, `a:gsLst` before
    `a:lin` (the other order PowerPoint refuses); in the preview the same
    gradient through a mask of the glyphs. The bottom line keeps the original
    stops; the shorter upper line receives less orange from the bottom-right
    light source."""
    from pptx import Presentation
    from pptx.oxml.ns import qn
    from deckkit.preview import Preview
    result = SP.deck_from_spec({'slides': [
        {'layout': 'title', 'text': 'Проверка'},
        {'layout': 'final'},
    ]}, skill_dir=SKILL).build(os.path.join(out_dir, 'final24'),
                               strict=False, keep_html=True)
    slide = Presentation(result.pptx_path).slides[1]
    runs = [r for sh in slide.shapes if sh.has_text_frame
            for p in sh.text_frame.paragraphs for r in p.runs
            if r.text.strip()]
    check('final 2.4: the closing text is there', len(runs) == 2,
          str([r.text for r in runs]))
    fills = []
    for r in runs:
        rPr = r._r.find(qn('a:rPr'))
        grad = rPr.find(qn('a:gradFill'))
        if grad is None or rPr.find(qn('a:solidFill')) is not None:
            fills.append(None)
            continue
        stops = [(gs.get('pos'), gs[0].get('val'),
                  [a.get('val') for a in gs[0].findall(qn('a:alpha'))])
                 for gs in grad.find(qn('a:gsLst'))]
        lin = grad.find(qn('a:lin'))
        fills.append(([child.tag.split('}')[1] for child in grad],
                      stops, lin.get('ang'), lin.get('scaled')))
    designer = (['gsLst', 'lin'],
                [('19000', '333333', []), ('66000', '333333', []),
                 ('100000', 'FC8A17', ['80000'])], '2700000', '0')
    upper = fills[0]
    check('final 2.4: both runs keep native gradients and ordering',
          all(fill is not None and fill[0] == ['gsLst', 'lin']
              and fill[2:] == ('2700000', '0') for fill in fills), str(fills))
    check('final 2.4: the bottom line keeps the designers\' gradient',
          fills[-1] == designer, str(fills[-1]))
    check('final 2.4: the shorter upper line has less orange at its end',
          upper is not None and upper[1][:2] == designer[1][:2]
          and int(upper[1][-1][1][0:2], 16) < 252
          and int(upper[1][-1][1][2:4], 16) < 138,
          str(upper))
    pictures = [sh for sh in slide.shapes if sh.shape_type == 13
                and sh.width == slide.part.package.presentation_part
                .presentation.slide_width]
    check('final 2.4: the heart background covers the slide',
          len(pictures) == 1, str(len(pictures)))

    document = Document.open(result.html_path, extra_dirs=[SKILL])
    cache_dir = tempfile.mkdtemp(prefix='deckfinal24-')
    try:
        image = Preview(document.assets(cache_dir), document.fonts).render(
            document.box(2))
    finally:
        shutil.rmtree(cache_dir, ignore_errors=True)
    box = [b for b in document.box(2).walk()
           if 'title-xlarge' in b.classes() and b.kind == 'text'][0]
    last_top = box.y + sum(box.line_heights[:-1])

    def darkest(x0, x1):
        """The darkest pixel of the last line between two x - the ink."""
        pixels = [image.getpixel((x, y)) for x in range(int(x0), int(x1), 2)
                  for y in range(int(last_top), int(box.y + box.h), 2)]
        return min(pixels, key=lambda p: sum(p[:3]))
    start = darkest(box.x, box.x + 150)
    end = darkest(box.x + box.line_widths[-1] - 150,
                  box.x + box.line_widths[-1])
    check('final 2.4: preview - «за» is #333333, «ие» turns orange',
          max(start[:3]) < 70 and end[0] - end[2] > 60, '%s %s'
          % (start, end))


def _walk_boxes(box, out):
    out.append(box)
    for child in box.children:
        _walk_boxes(child, out)
    return out


def _agenda_list_bottom(html_path):
    """Bottom edge (y+h) of the .agenda-list box on the agenda slide."""
    document = Document.open(html_path, extra_dirs=[SKILL])
    for root in document.boxes():
        lst = next((b for b in _walk_boxes(root, [])
                    if 'agenda-list' in b.classes()), None)
        if lst is not None:
            return lst.y + lst.h
    raise AssertionError('no agenda-list box found')


def test_agenda_bottom_anchored(out_dir):
    """Пункты повестки привязаны к низу: последний пункт стоит на одном
    уровне независимо от их числа, а не всплывает вверх из-за схлопывания
    контейнера (см. template.html, .agenda-list)."""
    def bottom_for(n):
        deck = Deck(skill_dir=SKILL)
        deck.title('Проверка')
        deck.agenda('Повестка', ['Пункт %d' % i for i in range(1, n + 1)])
        deck.final()
        result = deck.build(os.path.join(out_dir, 'agenda%d' % n),
                            strict=False, pptx=False)
        return _agenda_list_bottom(result.html_path)
    six = bottom_for(6)
    two = bottom_for(2)
    check('низ списка повестки одинаков при 6 и 2 пунктах',
          abs(six - two) < 1.0, '6 пунктов → %.1f, 2 пункта → %.1f'
          % (six, two))


def test_pptx_roundtrip(out_dir):
    """Example from assets builds to complete PPTX."""
    path = os.path.join(SKILL, 'assets', 'example-deck.json')
    if not os.path.isfile(path):
        return
    deck = SP.deck_from_spec(SP.load_spec(path), skill_dir=SKILL)
    result = deck.build(os.path.join(out_dir, 'example'), strict=True)
    check('example builds to PPTX',
          result.pptx_path and os.path.isfile(result.pptx_path))
    check('intermediate HTML removed', result.html_path is None)
    check('example builds without warnings', not result.warnings,
          '; '.join(str(i) for i in result.warnings))

    from pptx import Presentation
    count = len(Presentation(result.pptx_path).slides)
    check('PPTX slide count matches spec',
          count == len(deck), '%d vs %d' % (count, len(deck)))

    # A dangling relationship is "PowerPoint found a problem with content",
    # and the file does not open at all. Neither python-pptx nor unpacking
    # the archive notices it: parts are in place, XML is valid, only the
    # path is wrong. That is how font embedding broke —
    # `../fonts/font1.fntdata` from `ppt/_rels/presentation.xml.rels` points
    # to the package root because the base is already `ppt/`. All checks were
    # green, but the presentation would not open.
    with zipfile.ZipFile(result.pptx_path) as archive:
        parts = set(archive.namelist())
        dangling = []
        for name in sorted(parts):
            if not name.endswith('.rels'):
                continue
            base = posixpath.dirname(posixpath.dirname(name))
            body = archive.read(name).decode('utf-8')
            for tag in re.findall(r'<Relationship\b[^>]*>', body):
                if 'TargetMode="External"' in tag:
                    continue
                found = re.search(r'Target="([^"]+)"', tag)
                if not found:
                    continue
                target = found.group(1)
                resolved = (target.lstrip('/') if target.startswith('/')
                            else posixpath.normpath(
                                posixpath.join(base, target)))
                if resolved not in parts:
                    dangling.append('%s -> %s' % (name, target))
    check('every relationship in the PPTX resolves to a real part',
          not dangling,
          '%d dangling: %s' % (len(dangling), '; '.join(dangling[:5])))

    # The one invariant that ties the two font axes together, and the only one
    # that is not true by construction: whatever name ended up in a text run
    # has to be in the embedded list. It fails if the embed side and the naming
    # side ever drift apart, and it fails if a box quietly fell back to Arial —
    # a deck that opens fine here and loses its weights on someone else's
    # machine. Slides AND native chart parts: a chart left in Calibri (e.g. a
    # new chart part a filler forgets to style) would otherwise pass every
    # gate. `theme1.xml` legitimately names Calibri Light for the built-in
    # styles nothing in the deck uses.
    with zipfile.ZipFile(result.pptx_path) as archive:
        used = set()
        for name in archive.namelist():
            if ((name.startswith('ppt/slides/slide')
                 or name.startswith('ppt/charts/')) and name.endswith('.xml')):
                body = archive.read(name).decode('utf-8')
                used.update(re.findall(r'<a:latin[^>]*typeface="([^"]+)"',
                                       body))
        presentation = archive.read('ppt/presentation.xml').decode('utf-8')
        embedded = set(re.findall(r'<p:font typeface="([^"]+)"', presentation))
    check('the PPTX embeds a font list', bool(embedded))
    check('every typeface used on a slide is embedded',
          bool(used) and not (used - embedded),
          'used %s, embedded %s' % (sorted(used), sorted(embedded)))

    # The theme is the one part of the package nothing on a slide reads, so
    # nothing else here would notice it reverting to python-pptx's Office 2007
    # scheme — an upgrade of the library is enough to do it, silently, and the
    # only symptom is a colour dropdown in PowerPoint that belongs to someone
    # else. Checked against the palette file, not against a copy of the values.
    from deckkit.html2pptx import theme as TH
    expected_name, expected = TH.load_palette(SKILL)
    with zipfile.ZipFile(result.pptx_path) as archive:
        theme_parts = [n for n in archive.namelist()
                       if n.startswith('ppt/theme/') and n.endswith('.xml')]
        wrong = []
        for name in sorted(theme_parts):
            body = archive.read(name).decode('utf-8')
            block = re.search(r'<a:clrScheme\b.*?</a:clrScheme>', body, re.S)
            if not block:
                wrong.append('%s: no clrScheme' % name)
                continue
            found = dict(re.findall(
                r'<a:(\w+)><a:srgbClr val="([0-9A-Fa-f]{6})"/></a:\1>',
                block.group(0)))
            for slot, value in sorted(expected.items()):
                if found.get(slot) != value:
                    wrong.append('%s: %s is %s, expected %s'
                                 % (name, slot, found.get(slot), value))
            if 'name="%s"' % expected_name not in block.group(0):
                wrong.append('%s: scheme is not named %s'
                             % (name, expected_name))
    check('the PPTX carries the brand colour scheme',
          bool(theme_parts) and not wrong,
          '%d theme parts, %s' % (len(theme_parts),
                                  '; '.join(wrong[:4]) or 'ok'))


def test_document_title_and_slide_count(out_dir):
    """Titles stay text; structural mismatches never shift speaker notes."""
    import importlib
    from unittest.mock import patch
    from lxml import html as lhtml
    from pptx import Presentation
    from deckkit import build as B
    from deckkit import autofit as A
    C = importlib.import_module('deckkit.html2pptx.convert')
    from deckkit.html2pptx.document import find_slides

    work = os.path.join(out_dir, 'document-title')
    os.makedirs(work, exist_ok=True)

    def fixture():
        return SP.deck_from_spec({'slides': [
            {'layout': 'title', 'text': 'Title', 'notes': 'Opening note'},
            {'layout': 'final', 'notes': 'Closing note'},
        ]}, skill_dir=SKILL)

    def count_error(label, call):
        try:
            call()
        except BuildError as exc:
            check(label, len(exc.issues) == 1
                  and exc.issues[0].code == 'SLIDE_COUNT'
                  and 'deck has 2' in str(exc))
        except Exception as exc:
            check(label, False, 'unexpected %s: %s' % (type(exc).__name__, exc))
        else:
            check(label, False, 'no error')

    payload = '</title></head><body><div class="slide">Injected</div>'
    special = 'R&D <growth> "quotes" \'apostrophe\' &amp;'
    for source in ('argument', 'spec', 'guessed'):
        for index, value in enumerate((payload, special)):
            deck = fixture()
            title = None
            if source == 'argument':
                title = value
            elif source == 'spec':
                deck = SP.deck_from_spec({'title': value, 'slides': [
                    {'layout': 'title', 'text': 'Title', 'notes': 'Opening note'},
                    {'layout': 'final', 'notes': 'Closing note'},
                ]}, skill_dir=SKILL)
            else:
                deck.slides[0].data['text'] = value
            path = os.path.join(work, '%s-%d' % (source, index))
            doc = lhtml.fromstring(B.render_html(deck, path, title=title))
            check('document title: %s %d stays literal with two slides'
                  % (source, index),
                  doc.find('.//title').text == value
                  and len(find_slides(doc)) == 2)
            result = deck.build(path, title=title, keep_html=True)
            slides = Presentation(result.pptx_path).slides
            check('document title: %s %d preserves notes and slide count'
                  % (source, index),
                  result.slides == len(slides) == 2 and not result.errors
                  and slides[0].notes_slide.notes_text_frame.text == 'Opening note'
                  and slides[1].notes_slide.notes_text_frame.text == 'Closing note')

    for value in (None, False, 0, 12, [], {}):
        _raises('document title: spec rejects %r' % value, SpecError,
                '"title" must be a string', lambda: SP.deck_from_spec(
                    {'title': value, 'slides': [{'layout': 'final'}]}, skill_dir=SKILL))
        if value is not None:
            for source in ('argument', 'doc_title'):
                deck = fixture()
                argument = value if source == 'argument' else None
                if source == 'doc_title':
                    deck.doc_title = value
                _raises('document title: API rejects %s %r' % (source, value),
                        ValueError, 'document title must be a string',
                        lambda: B.render_html(deck, os.path.join(work, 'invalid'),
                                              title=argument))
    for value in (None, ''):
        deck = fixture()
        doc = lhtml.fromstring(B.render_html(deck, work, title=value))
        check('document title: API fallback for %r' % value,
              doc.find('.//title').text == 'Title')

    original_open = Document.open
    for delta in (-1, 1):
        def mismatched_html(*args, **kwargs):
            doc = original_open(*args, **kwargs)
            doc.elements = doc.elements[:1] if delta < 0 else doc.elements + [doc.elements[0]]
            return doc

        for strict in (True, False):
            path = os.path.join(work, 'html-count-%d-%s' % (delta, strict))
            with patch.object(Document, 'open', mismatched_html), \
                    patch.object(A, 'fit') as fit:
                count_error('slide count: HTML delta %d strict %s' % (delta, strict),
                            lambda: fixture().build(path, strict=strict))
                check('slide count: HTML mismatch stops before autofit %d %s'
                      % (delta, strict), not fit.called
                      and not os.path.exists(path + '.pptx'))

    for count in (1, 3):
        path = os.path.join(work, 'notes-count-%d.pptx' % count)
        prs = Presentation()
        for i in range(count):
            slide = prs.slides.add_slide(prs.slide_layouts[6])
            slide.notes_slide.notes_text_frame.text = 'Original %d' % i
        prs.save(path)
        with open(path, 'rb') as handle:
            original = handle.read()
        for notes in (True, False):
            deck = fixture()
            if not notes:
                for slide in deck.slides:
                    slide.notes = None
            count_error('slide count: PPTX count %d notes %s' % (count, notes),
                        lambda: B._write_notes(path, deck))
            with open(path, 'rb') as handle:
                check('slide count: mismatch preserves notes archive %d %s'
                      % (count, notes), handle.read() == original)

    def mismatched_writer(document, path, **kwargs):
        prs = Presentation()
        prs.slides.add_slide(prs.slide_layouts[6])
        prs.save(path)

    path = os.path.join(work, 'publication-count')
    fixture().build(path)
    with open(path + '.pptx', 'rb') as handle:
        original = handle.read()
    with patch.object(C, 'write_pptx', mismatched_writer):
        count_error('slide count: PPTX mismatch prevents publication',
                    lambda: fixture().build(path, strict=False))
    with open(path + '.pptx', 'rb') as handle:
        check('slide count: failed writer preserves completed deck',
              handle.read() == original
              and not any(name.startswith('.deck-build-') for name in os.listdir(work)))


def test_notes_reach_pptx(out_dir):
    """Speaker notes on a slide land in that slide's PPTX notes pane."""
    spec = {'title': 't', 'slides': [
        {'layout': 'title', 'text': 'A', 'notes': 'первая заметка'},
        {'layout': 'statement', 'text': 'B'},
        {'layout': 'final', 'notes': 'заметка на закрывающем слайде'},
    ]}
    deck = SP.deck_from_spec(spec, skill_dir=SKILL)
    result = deck.build(os.path.join(out_dir, 'notes'), strict=True)

    from pptx import Presentation
    slides = Presentation(result.pptx_path).slides
    check('notes on slide 1 reach the PPTX',
          slides[0].notes_slide.notes_text_frame.text == 'первая заметка')
    check('slide without notes has no notes slide',
          not slides[1].has_notes_slide)
    check('notes on the final slide reach the PPTX',
          slides[2].notes_slide.notes_text_frame.text
          == 'заметка на закрывающем слайде')

    # notes is the one text field with no box and therefore no measured limit,
    # which makes it the obvious place for an agent to park whatever did not
    # fit on the slide. A warning, not an error: the deck is fine, the writing
    # is not. `strict=True` above must keep working with a long note present,
    # so this half also proves the level is right.
    essay = {'title': 't', 'slides': [
        {'layout': 'title', 'text': 'A', 'notes': 'Очень подробно. ' * 50},
        {'layout': 'final', 'notes': 'Коротко и по делу.'},
    ]}
    long_deck = SP.deck_from_spec(essay, skill_dir=SKILL)
    long_result = long_deck.build(os.path.join(out_dir, 'notes-long'), strict=True)
    hits = [i for i in long_result.issues if i.code == 'NOTES_TOO_LONG']
    check('an essay in notes raises NOTES_TOO_LONG', hits,
          str([str(i) for i in long_result.issues]))
    check('NOTES_TOO_LONG is a warning, not an error',
          hits and all(i.level == 'warning' for i in hits))
    check('NOTES_TOO_LONG names the offending slide',
          hits and hits[0].slide == 1, str([i.slide for i in hits]))
    check('a normal-length note stays silent', len(hits) == 1, str(len(hits)))


def test_glass_shadows(out_dir):
    """Glass panel shadows reach PPTX as images.

    Panel visibility comes not from 20% fill but two shadows: inset ring
    via `box-shadow: inset` and orange nimbus outside. Previously inset
    was silently dropped, outer used native `a:outerShdw` — that paints
    full blurred silhouette behind shape, showing through translucent fill
    and muddying glass. Both shadows are baked as images.
    """
    from pptx import Presentation
    from pptx.util import Emu

    from deckkit.html2pptx import values as V
    from deckkit.html2pptx.boxdeco import inset_shadow_layer, outer_shadow_layer

    with open(os.path.join(SKILL, 'assets', 'base.css'), 'r', encoding='utf-8') as f:
        css = f.read()
    rule = re.search(r'\.glass-panel\s*\{(.*?)\}', css, re.S)
    declaration = re.search(r'box-shadow\s*:([^;]+);', rule.group(1) if rule else '', re.S)
    shadows = V.box_shadows(declaration.group(1)) if declaration else []
    check('glass panel has two shadows, inset and outer',
          len([s for s in shadows if s.inset]) == 1
          and len([s for s in shadows if not s.inset]) == 1,
          'shadows parsed: %d' % len(shadows))
    if len(shadows) != 2:
        return

    alpha = inset_shadow_layer(1840, 1000, 46, shadows).getchannel('A')
    edge, inward, middle = (alpha.getpixel((1, 500)), alpha.getpixel((10, 500)),
                            alpha.getpixel((920, 500)))
    # Blurred step at edge gives about half alpha, fades to center.
    check('ring glows at edge', edge > 90, 'alpha at edge: %d' % edge)
    check('ring fades to center', middle == 0 and inward < edge,
          'alpha 10px inward: %d, center: %d' % (inward, middle))
    check('no ring beyond rounding', alpha.getpixel((2, 2)) == 0,
          'alpha at corner: %d' % alpha.getpixel((2, 2)))

    layer, pad = outer_shadow_layer(1840, 1000, 46, shadows)
    check('outer shadow extends beyond box', pad > 40, 'padding: %dpx' % pad)
    outer = layer.getchannel('A')
    # Just outside box edge shadow is brightest and fades to padding: at 5px outside
    # edge about 0.3 x 0.4 of full alpha, at 33px — single digits.
    near = outer.getpixel((pad - 5, layer.height // 2))
    check('outer shadow glows at edge', near > 20, 'alpha at 5px: %d' % near)
    check('outer shadow fades to padding',
          outer.getpixel((2, layer.height // 2)) < near,
          'alpha at layer boundary: %d' % outer.getpixel((2, layer.height // 2)))
    # Key point: outer shadow must not reach inside box — would muddy glass.
    check('outer shadow does not reach inside box',
          outer.getpixel((layer.width // 2, layer.height // 2)) == 0
          and outer.getpixel((pad + 60, layer.height // 2)) == 0,
          'alpha inside: %d' % outer.getpixel((layer.width // 2, layer.height // 2)))

    deck = Deck(skill_dir=SKILL)
    deck.title('Проверка стекла')
    deck.final()
    result = deck.build(os.path.join(out_dir, 'glass'), strict=True)
    slide = Presentation(result.pptx_path).slides[0]
    widths = sorted(round(Emu(s.width).inches * 96) for s in leaf_shapes(slide.shapes)
                    if s.shape_type is not None and 'PICTURE' in str(s.shape_type)
                    and Emu(s.height).inches * 96 > 900)
    # Pattern fills the slide (1920), ring follows the panel (1840), nimbus wider.
    check('both glass shadows reach PPTX', len(widths) == 3
          and 1840 in widths and max(widths) > 1920,
          'widths of large images: %s' % widths)

    shapes_xml = slide.shapes._spTree.xml
    check('no native PPTX shadow on the panel', 'outerShdw' not in shapes_xml)


def test_shape_grouping(out_dir):
    """The layers of one design object arrive as one PowerPoint group.

    A glass panel is three shapes, a ring two, a numbered circle two, a bullet
    a marker plus its line. Flat, each layer is separately selectable and
    dragging one produces something nobody drew. Grouped, they move as the one
    object they are.

    The z-order half of this is the part worth pinning. `add_group_shape`
    appends the group at the END of the shape tree, and the glass panel is
    drawn FIRST with the logo and the headline on top of it — so the naive call
    buries them under the panel and turns the title slide into a blank
    rectangle. `grouping.apply_groups` puts the group back where its first
    member was; nothing else here can see whether it did, because no .pptx
    renders in this environment and the PNG preview never goes through
    grouping.
    """
    from pptx import Presentation

    from deckkit.layouts import GROUP_ROOTS

    deck = Deck(skill_dir=SKILL)
    deck.title('Группировка слоёв', subtitle='Проверка', author='Отдел')
    deck.cards('Список', [{'title': 'Что сделали', 'icon': 'список',
                           'items': ['Первое дело', 'Второе дело',
                                     'Третье дело']}])
    deck.timeline('Этапы', [{'title': 'Q1', 'text': 'Начали'},
                            {'title': 'Q2', 'text': 'Продолжили'},
                            {'title': 'Q3', 'text': 'Закончили'}])
    deck.flow('Процесс', [{'icon': 'рост', 'text': 'Шаг один'},
                          {'icon': 'команда', 'text': 'Шаг два'},
                          {'icon': 'щит', 'text': 'Шаг три'},
                          {'icon': 'цель', 'text': 'Шаг четыре'}])
    deck.columns('Колонки', [{'title': 'Первая', 'text': 'Текст'},
                             {'title': 'Вторая', 'text': 'Текст'},
                             {'title': 'Третья', 'text': 'Текст'}])
    deck.final()
    result = deck.build(os.path.join(out_dir, 'groups'), strict=True)
    slides = list(Presentation(result.pptx_path).slides)

    def groups(slide):
        return [s for s in slide.shapes if getattr(s, 'shapes', None) is not None]

    # title, one-card list, timeline, flow, columns, final. The closing
    # slide has no group since 2.4.0: its glass panel is in the designers'
    # background picture.
    counts = [len(groups(s)) for s in slides]
    check('grouping: one group per composite object',
          counts == [1, 3, 3, 4, 3, 0], 'groups per slide: %s' % counts)

    sizes = sorted(len(g.shapes) for g in groups(slides[0]))
    check('grouping: the glass panel is one group of three layers',
          sizes == [3], 'members: %s' % sizes)

    pairs = [len(g.shapes) for s in slides[1:5] for g in groups(s)]
    check('grouping: every other group is a pair',
          pairs and set(pairs) == {2}, 'members: %s' % sorted(set(pairs)))

    # The title slide, in drawing order: background, pattern, THEN the panel,
    # and only then the logo and the three text blocks. If the group drifted to
    # the end, the panel covers all of them.
    tree = list(slides[0].shapes)
    kinds = [('group' if getattr(s, 'shapes', None) is not None else
              'picture' if 'PICTURE' in str(s.shape_type) else 'other')
             for s in tree]
    # `in` before `index`: if grouping stops happening altogether this check
    # must report a failure like every other one, not raise ValueError and
    # abort the rest of the test — which is exactly what it did until a
    # mutation run showed three failures where five were due.
    check('grouping: the glass panel keeps its place under the logo',
          'group' in kinds and 'picture' in kinds[kinds.index('group') + 1:],
          'top-level order: %s' % kinds)

    # Grouping must not lose or duplicate anything: the leaves are the shapes
    # the flat render produced, no more and no fewer.
    # Background, pattern, three panel layers, logo, headline, subtitle, author.
    leaves = len(leaf_shapes(slides[0].shapes))
    check('grouping: no shape is lost inside a group', leaves == 9,
          'leaves on the title slide: %d' % leaves)

    check('grouping: the rule covers exactly the composite objects',
          GROUP_ROOTS == frozenset(['card-number-circle', 'circle-badge',
                                    'gallery-badge', 'glass-panel', 'flow-icon',
                                    'timeline-circle', 'columns-dot',
                                    'bullet-item', 'agenda-item',
                                    'legend-item', 'chart-point',
                                    'chart-note-row']),
          'roots: %s' % sorted(GROUP_ROOTS))

    # Cards, grids and metrics are several distinct objects that merely sit
    # together, and editing one alone is legitimate — they stay flat on
    # purpose. Grouping them would also make the unit resizable, and
    # PowerPoint rescales a group's text frames without rescaling the type.
    # A list in a narrower card, and one under a sentence, go down the same
    # path as the full-width list above but through other fragments.
    items_deck = Deck(skill_dir=SKILL)
    items_deck.cards('Списки внутри карточек', [
        {'title': 'Раз', 'icon': 'список',
         'items': ['Первое', 'Второе', 'Третье']},
        {'title': 'Два', 'icon': 'документ', 'text': 'Вводная фраза',
         'items': ['Ещё одно', 'И ещё']}])
    items_result = items_deck.build(os.path.join(out_dir, 'items'), strict=True)
    items_groups = groups(list(Presentation(items_result.pptx_path).slides)[0])
    check('grouping: a list inside a card is grouped too',
          [len(g.shapes) for g in items_groups] == [2] * 5,
          'groups: %s' % [len(g.shapes) for g in items_groups])

    flat_deck = Deck(skill_dir=SKILL)
    flat_deck.cards('Карточки', [
        {'title': 'Раз', 'text': 'Описание', 'icon': 'рост'},
        {'title': 'Два', 'text': 'Описание', 'icon': 'команда'}])
    flat_deck.metrics('Итоги', None, [{'value': '+38%', 'text': 'Конверсия'},
                                      {'value': '174', 'text': 'Выручка'}])
    flat_result = flat_deck.build(os.path.join(out_dir, 'flat'), strict=True)
    flat_slides = Presentation(flat_result.pptx_path).slides
    check('grouping: cards and metrics stay separately editable',
          all(not groups(s) for s in flat_slides),
          'groups: %s' % [len(groups(s)) for s in flat_slides])

    # An agenda item is a number plus the line it labels — the same pair as a
    # bullet marker plus its line. Reached through its own fragment, so it is
    # checked separately like the in-card list above.
    agenda_deck = Deck(skill_dir=SKILL)
    agenda_deck.title('Проверка')
    agenda_deck.agenda('Повестка', ['Первое', 'Второе', 'Третье'])
    agenda_deck.final()
    agenda_result = agenda_deck.build(os.path.join(out_dir, 'agenda-groups'),
                                      strict=True)
    agenda_slides = list(Presentation(agenda_result.pptx_path).slides)
    agenda_groups = groups(agenda_slides[1])  # the agenda slide
    check('grouping: an agenda item is number + text as one group',
          [len(g.shapes) for g in agenda_groups] == [2] * 3,
          'groups: %s' % [len(g.shapes) for g in agenda_groups])

    # A legend item is a swatch plus the label it names — the same pair as a
    # bullet marker plus its line (I3). Each item must arrive as one linked
    # object so a swatch cannot be dragged off its label in PowerPoint.
    chart_deck = Deck(skill_dir=SKILL)
    chart_deck.title('Легенда')
    chart_deck.chart('Выручка', chart_type='stacked',
                     points=[{'text': 'Вывод', 'icon': 'рост'}],
                     data={'categories': ['A', 'B', 'C'],
                           'series': [{'name': 'Ряд %d' % i, 'values': [1, 2, 3]}
                                      for i in range(4)]})
    chart_deck.final()
    chart_result = chart_deck.build(os.path.join(out_dir, 'legend-groups'),
                                    strict=True)
    chart_slide = list(Presentation(chart_result.pptx_path).slides)[1]
    legend_groups = [g for g in groups(chart_slide) if len(g.shapes) == 2]
    # 4 legend entries, each a (swatch, label) pair, and the one point (its
    # icon and text, test_chart_groups) - five 2-shape groups, and no
    # leftover flat swatch or label on the slide.
    check('grouping: a legend item is swatch + label as one group',
          [len(g.shapes) for g in legend_groups] == [2] * 5,
          'legend groups: %s' % [len(g.shapes) for g in legend_groups])

    # The contiguity guard. Nothing in the current template can trip it, so
    # without this the guard is unpinned — mutation-testing it away changed
    # nothing anywhere else. Exercised directly instead: a group whose members
    # have stopped being neighbours must be left flat, because pulling them
    # together would reorder them against whatever now sits between them.
    from deckkit.html2pptx.document import Document
    from deckkit.html2pptx.grouping import apply_groups, parent_map
    from deckkit.html2pptx.paint import paint_slide
    from deckkit.html2pptx.render import Renderer, _Shapes

    guard = Deck(skill_dir=SKILL)
    guard.title('Разрыв непрерывности', subtitle='Проверка охраны')
    guard.final()
    built = guard.build(os.path.join(out_dir, 'guard'), strict=True,
                        pptx=False, keep_html=True)
    document = Document.open(built.html_path, extra_dirs=[SKILL])
    renderer = Renderer(document.assets(os.path.join(out_dir, 'guard-cache')),
                        document.fonts)
    root = document.box(1)
    slide = renderer.prs.slides.add_slide(renderer.blank)
    target = _Shapes(renderer, slide, 1)
    paint_slide(root, target)

    intact = apply_groups(slide, target.painted, parent_map(root), 1,
                          L.GROUP_ROOTS)
    check('grouping: an intact run is grouped', len(intact) == 1,
          'groups: %s' % intact)

    slide2 = renderer.prs.slides.add_slide(renderer.blank)
    target2 = _Shapes(renderer, slide2, 1)
    paint_slide(root, target2)
    panel = [s for b, s in target2.painted if 'glass-panel' in b.classes()]
    slide2.shapes._spTree.append(panel[0]._element)     # break the run
    grouping_log = logging.getLogger('deckkit.html2pptx.grouping')
    grouping_log.disabled = True
    try:
        broken = apply_groups(slide2, target2.painted, parent_map(root), 1,
                              L.GROUP_ROOTS)
    finally:
        grouping_log.disabled = False
    check('grouping: a broken run is left flat, not reordered', broken == [],
          'grouped anyway: %s' % broken)


def test_font_set(out_dir):
    """One font table, PPTX names derived from the files, brand faces fail loudly.

    The whole seam used to be unpinned: nothing asserted that the embedded
    family names match the ones written into `a:latin`, and nothing noticed
    when a requested face quietly became Arial.

    The `FontBook`s built here are probes of the resolver, not a second
    measurement pass — no `Document` and no box tree is involved, so the
    "one `Document` per build" invariant is not in play.
    """
    from deckkit.html2pptx import fonts as FT                    # noqa: PLC0415
    from deckkit.html2pptx.textmeasure import FontBook           # noqa: PLC0415

    font_dir = os.path.join(SKILL, 'assets', 'fonts', FT.FONT_DIR_NAME)
    check('font directory exists where fonts.py says', os.path.isdir(font_dir),
          font_dir)

    check('font table is exactly the three shipped weights',
          sorted(FT.FILE_BY_WEIGHT) == [('t-sans', 400), ('t-sans', 500),
                                        ('t-sans', 700)],
          str(sorted(FT.FILE_BY_WEIGHT)))

    missing = sorted(name for name in set(FT.FILE_BY_WEIGHT.values())
                     if not os.path.isfile(os.path.join(font_dir, name)))
    check('every file in the font table exists', not missing, str(missing))

    # Ground truth for the "weight 500 travels by typeface name" trap. Written
    # out by hand, so it is an assertion about the shipped fonts rather than a
    # restatement of whatever the code computes.
    faces_seen = dict((name, FT.face_info(os.path.join(font_dir, name)))
                      for name in sorted(set(FT.FILE_BY_WEIGHT.values())))
    check('weight 500 is a PPTX family of its own',
          faces_seen == {'T-Sans_Regular.ttf': ('T-Sans', False),
                         'T-Sans_Bold.ttf': ('T-Sans', True),
                         'T-Sans_Medium.ttf': ('T-Sans Medium', False)},
          str(faces_seen))

    derived = [(face['family'], face['slot'], os.path.basename(face['path']))
               for face in FT.embed_faces(font_dir)]
    check('embed list derived from the files keeps the shipped grouping',
          derived == [('T-Sans', 'regular', 'T-Sans_Regular.ttf'),
                      ('T-Sans', 'bold', 'T-Sans_Bold.ttf'),
                      ('T-Sans Medium', 'regular', 'T-Sans_Medium.ttf')],
          str(derived))

    book = FontBook(SKILL)
    check('font directory resolved from the skill root', book.dir is not None)

    # A brand face that never reached the table used to ship as Arial: measured
    # with Arial widths, named Arial in `a:latin`, not embedded, and different
    # on every build machine depending on what is installed.
    raised = None
    try:
        book.face('T-Sans Condensed', 400)
    except FT.FontSetError as exc:                               # noqa: BLE001
        raised = str(exc)
    check('an unwired brand face stops the build', raised is not None,
          'no exception raised')

    # Scoped to the brand on purpose: a family we do not ship could not be
    # embedded even if we recognised it, so it keeps the old fallback.
    for family in ('Inter, sans-serif', 'Arial', 'Helvetica'):
        try:
            name = book.face(family, 400)[0]
        except FT.FontSetError as exc:                           # noqa: BLE001
            name = None
            check('a non-brand family still falls back: %s' % family, False,
                  str(exc))
            continue
        check('a non-brand family still falls back: %s' % family, bool(name),
              repr(name))

    # No font set at all is graceful degradation, not a mistake — the warning
    # about diverging line wraps is already there.
    homeless = FontBook(out_dir)
    check('a missing font set degrades rather than raising',
          homeless.dir is None and bool(homeless.face('T-Sans', 500)[0]))

    # `stylesheet.css` is a third (family, weight) → file table, in designer-
    # owned assets. A face added only there would be measured with the wrong
    # metrics and never embedded, and nothing else would notice.
    sheet = os.path.join(font_dir, 'stylesheet.css')
    with open(sheet, encoding='utf-8') as handle:
        css = handle.read()
    declared = {}
    for block in re.findall(r'@font-face\s*\{([^}]*)\}', css):
        family = re.search(r"font-family:\s*['\"]([^'\"]+)['\"]", block)
        source = re.search(r"src:\s*url\(['\"]([^'\"]+)['\"]", block)
        weight = re.search(r'font-weight:\s*(\d+)', block)
        if family and source and weight:
            declared[(family.group(1).lower(), int(weight.group(1)))] = \
                source.group(1)
    check('stylesheet.css declares the same faces as fonts.FILE_BY_WEIGHT',
          declared == FT.FILE_BY_WEIGHT,
          'css %s vs table %s' % (sorted(declared.items()),
                                  sorted(FT.FILE_BY_WEIGHT.items())))

    base_css = os.path.join(SKILL, 'assets', 'base.css')
    with open(base_css, encoding='utf-8') as handle:
        imported = re.search(r"@import\s+url\(['\"]([^'\"]+)['\"]",
                             handle.read())
    check('base.css imports the directory fonts.py names',
          imported is not None
          and FT.FONT_DIR_NAME in imported.group(1).split('/'),
          imported.group(1) if imported else 'no @import')

    # The basename used to be spelled out in five places. The CSS side above is
    # designer-owned and only compared; the Python side must derive it.
    spelled_out = []
    for root, _dirs, files in os.walk(os.path.join(HERE, 'deckkit')):
        for name in files:
            if not name.endswith('.py') or name == 'fonts.py':
                continue
            path = os.path.join(root, name)
            with open(path, encoding='utf-8') as handle:
                if FT.FONT_DIR_NAME in handle.read():
                    spelled_out.append(os.path.relpath(path, HERE))
    check('the font directory name is a literal only in fonts.py',
          not spelled_out, str(spelled_out))


def _raises(label, exc_type, fragment, call):
    """One error path: the right exception, naming the right thing."""
    try:
        call()
    except exc_type as exc:
        check(label, fragment in str(exc), str(exc)[:200])
    except Exception as exc:                    # noqa: BLE001
        check(label, False, 'raised %s instead: %s' % (type(exc).__name__, exc))
    else:
        check(label, False, 'no error')



def test_build_transaction(out_dir):
    """Only a complete deck replaces the deliverable, even on partial writes."""
    from unittest.mock import patch
    from pptx import Presentation
    from deckkit import build as B
    from deckkit.html2pptx import font_embed as FE, theme as TH
    from deckkit.html2pptx.render import Renderer

    work = os.path.join(out_dir, 'build-transaction')
    os.makedirs(work, exist_ok=True)
    target = os.path.join(work, 'result.pptx')

    def contents(path):
        with open(path, 'rb') as handle:
            return handle.read()

    def deck():
        return SP.deck_from_spec({'slides': [
            {'layout': 'title', 'text': 'Transaction', 'notes': 'Opening note'},
            {'layout': 'final', 'notes': 'Closing note'},
        ]}, SKILL)

    real_replace = os.replace
    published = []

    def inspect_publish(source, destination):
        if os.path.abspath(destination) == target:
            check('build transaction: publication source is on target filesystem',
                  os.path.dirname(os.path.dirname(source)) == work
                  and source != destination)
            with zipfile.ZipFile(source) as archive:
                check('build transaction: published archive is complete',
                      archive.testzip() is None
                      and len([n for n in archive.namelist()
                               if n.startswith('ppt/fonts/')]) == 3
                      and 'ppt/notesSlides/notesSlide2.xml' in archive.namelist()
                      and json.loads(read_text(TH.palette_path(SKILL)))['name'] in
                      archive.read('ppt/theme/theme1.xml').decode('utf-8'))
            published.append(destination)
        return real_replace(source, destination)

    for attempt in range(2):
        path = os.path.relpath(target) if attempt == 0 else target
        with patch.object(B.os, 'replace', inspect_publish):
            result = deck().build(path, strict=True)
        check('build transaction: success returns requested path %d' % attempt,
              result.pptx_path == path and result.html_path is None
              and not result.errors)
        prs = Presentation(target)
        check('build transaction: notes reach both slides %d' % attempt,
              len(prs.slides) == 2
              and prs.slides[0].notes_slide.notes_text_frame.text == 'Opening note'
              and prs.slides[1].notes_slide.notes_text_frame.text == 'Closing note')
        check('build transaction: success leaves only deliverable %d' % attempt,
              sorted(os.listdir(work)) == ['result.pptx'])
    check('build transaction: exactly one final replacement per build',
          len(published) == 2)
    approved = contents(target)

    def partial_save(renderer, path):
        with open(path, 'wb') as handle:
            handle.write(b'partial renderer output')
        raise OSError('transaction fault: save')

    def partial_notes(path, current_deck):
        with open(path, 'wb') as handle:
            handle.write(b'partial notes output')
        raise OSError('transaction fault: notes')

    def partial_editor(stage):
        def fail(path, skill):
            with open(path, 'wb') as handle:
                handle.write(('partial ' + stage).encode('ascii'))
            raise OSError('transaction fault: ' + stage)
        return fail

    def failed_publish(source, destination):
        if os.path.abspath(destination) == target:
            raise PermissionError('transaction fault: replace')
        return real_replace(source, destination)

    faults = [
        ('save', Renderer, 'save', partial_save),
        ('notes', B, '_write_notes', partial_notes),
        ('theme', TH, 'apply_theme_colors', partial_editor('theme')),
        ('fonts', FE, 'embed_fonts', partial_editor('fonts')),
        ('replace', B.os, 'replace', failed_publish),
    ]
    for existing in (True, False):
        for label, owner, attribute, failure in faults:
            if existing:
                with open(target, 'wb') as handle:
                    handle.write(approved)
            elif os.path.exists(target):
                os.remove(target)
            with patch.object(owner, attribute, failure):
                _raises('build transaction: %s existing=%s' % (label, existing),
                        OSError, 'transaction fault: ' + label,
                        lambda: deck().build(target, strict=True))
            check('build transaction: %s preserves destination existing=%s'
                  % (label, existing),
                  contents(target) == approved if existing
                  else not os.path.exists(target))
            # Failed builds retain fitted HTML as diagnostic evidence. No
            # staging directory or editor archive may remain beside it.
            expected = ['result.html', 'result.pptx'] if existing else ['result.html']
            check('build transaction: %s cleans staging existing=%s'
                  % (label, existing), sorted(os.listdir(work)) == expected,
                  repr(sorted(os.listdir(work))))


def test_font_embed_transaction(out_dir):
    """Font archive writes preserve the source and close handles before publish."""
    from unittest.mock import patch
    from pptx import Presentation
    from deckkit.html2pptx import font_embed as FE

    work = os.path.join(out_dir, 'font-transaction')
    os.makedirs(work, exist_ok=True)
    target = os.path.join(work, 'bare.pptx')
    Presentation().save(target)
    with open(target, 'rb') as handle:
        original = handle.read()
    real_zip = zipfile.ZipFile
    real_replace = os.replace
    opened = []

    class TrackedZip(real_zip):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            opened.append(self)

    def inspect_replace(source, destination):
        check('font transaction: both ZIP handles closed at replace',
              len(opened) == 2 and all(z.fp is None for z in opened))
        check('font transaction: unique temp next to destination',
              os.path.dirname(source) == work and source != destination)
        return real_replace(source, destination)

    for attempt in range(2):
        with open(target, 'wb') as handle:
            handle.write(original)
        opened.clear()
        with patch.object(FE.zipfile, 'ZipFile', TrackedZip), \
                patch.object(FE.os, 'replace', inspect_replace):
            families = FE.embed_fonts(target, SKILL)
        with zipfile.ZipFile(target) as archive:
            check('font transaction: complete embedded archive %d' % attempt,
                  len(families) == 2 and archive.testzip() is None
                  and len([n for n in archive.namelist()
                           if n.startswith('ppt/fonts/')]) == 3)
        check('font transaction: successful cleanup %d' % attempt,
              os.listdir(work) == ['bare.pptx'])

    class FailedWriteZip(real_zip):
        def writestr(self, *args, **kwargs):
            super().writestr(*args, **kwargs)
            raise OSError('font transaction fault: partial write')

    def fail_replace(source, destination):
        raise PermissionError('font transaction fault: replace')

    for label, owner, attribute, failure in [
            ('partial write', FE.zipfile, 'ZipFile', FailedWriteZip),
            ('replace', FE.os, 'replace', fail_replace)]:
        with open(target, 'wb') as handle:
            handle.write(original)
        with patch.object(owner, attribute, failure):
            _raises('font transaction: ' + label, OSError,
                    'font transaction fault: ' + label,
                    lambda: FE.embed_fonts(target, SKILL))
        with open(target, 'rb') as handle:
            check('font transaction: %s preserves original bytes' % label,
                  handle.read() == original)
        check('font transaction: %s cleans temporary archive' % label,
              os.listdir(work) == ['bare.pptx'])


def test_theme_and_font_embed_errors(out_dir):
    """The two surgical zip editors fail loudly, and clean up after themselves.

    Both rewrite the finished .pptx as text against its XML, and both are the
    last thing to touch the file. Until now neither was called by a test other
    than through a successful build, so every one of their refusals was
    untested code on the path that produces the deliverable — and a theme that
    silently did not apply leaves a file that looks intact while handing the
    reader another company's colour gallery.
    """
    from deckkit.html2pptx import font_embed as FE
    from deckkit.html2pptx import theme as TH

    work = os.path.join(out_dir, 'theme-errors')
    os.makedirs(work, exist_ok=True)

    def palette(label, fragment, payload):
        skill = os.path.join(work, 'skill-%s' % label)
        os.makedirs(os.path.join(skill, 'assets'), exist_ok=True)
        if payload is not None:
            with open(TH.palette_path(skill), 'w', encoding='utf-8') as f:
                f.write(payload)
        _raises('theme: %s' % label, TH.ThemeError, fragment,
                lambda: TH.load_palette(skill))

    good = json.load(open(TH.palette_path(SKILL), encoding='utf-8'))
    palette('missing file', 'cannot read', None)
    palette('invalid json', 'not valid JSON', '{')
    palette('no name', 'no "name"', json.dumps({'scheme': good['scheme']}))
    palette('no scheme', 'no "scheme" object', json.dumps({'name': 'X'}))
    short = dict(good['scheme'])
    del short['accent3']
    palette('missing slot', 'missing: accent3',
            json.dumps({'name': 'X', 'scheme': short}))
    extra = dict(good['scheme'], accent7='000000')
    palette('unknown slot', 'unknown: accent7',
            json.dumps({'name': 'X', 'scheme': extra}))
    bad_hex = dict(good['scheme'], accent1='#FFDD2C')
    palette('colour is not six hex digits', 'six uppercase hex digits',
            json.dumps({'name': 'X', 'scheme': bad_hex}))

    def package(name, parts):
        path = os.path.join(work, name)
        with zipfile.ZipFile(path, 'w') as z:
            for member, body in parts.items():
                z.writestr(member, body)
        return path

    def contents(path):
        with open(path, 'rb') as handle:
            return handle.read()

    def no_temporary_files(label):
        leftovers = [n for n in sorted(os.listdir(work))
                     if n.endswith('.tmp') or n.endswith('.themetmp')]
        check('theme: %s leaves no temporary file' % label,
              not leftovers, '; '.join(leftovers))

    def refused_unchanged(label, path, exc_type, fragment):
        before = contents(path)
        _raises('theme: %s' % label, exc_type, fragment,
                lambda: TH.apply_theme_colors(path, SKILL))
        check('theme: %s preserves the original bytes' % label,
              contents(path) == before)
        no_temporary_files(label)

    no_theme = package('no-theme.pptx', {'ppt/presentation.xml': '<p/>'})
    refused_unchanged('package carries no theme part', no_theme,
                      TH.ThemeError, 'no theme part')
    no_scheme = package('no-scheme.pptx',
                        {'ppt/theme/theme1.xml': '<a:theme/>'})
    refused_unchanged('theme part carries no clrScheme', no_scheme,
                      TH.ThemeError, 'no a:clrScheme')
    invalid = os.path.join(work, 'invalid.pptx')
    with open(invalid, 'wb') as handle:
        handle.write(b'not a ZIP archive')
    refused_unchanged('invalid archive', invalid, zipfile.BadZipFile,
                      'not a zip file')

    # The temporary archive now exists before source validation. Check both
    # those early refusals and failures after writing has started below.
    parts = {
        'ppt/presentation.xml': '<p/>',
        'ppt/theme/theme1.xml':
            '<a:theme><a:clrScheme name="Office">'
            '<a:dk1><a:srgbClr val="000000"/></a:dk1>'
            '</a:clrScheme></a:theme>',
        'ppt/slides/slide1.xml': '<p:sld/>',
    }
    real = package('rewritable.pptx', parts)
    rewritten = package('successful-rewrite.pptx', parts)
    saved_zip = TH.zipfile.ZipFile
    saved_replace = TH.os.replace
    opened = []
    replacements = []

    class TrackedZip(saved_zip):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            opened.append(self)

    def replace_closed(source, target):
        replacements.append((source, target))
        # POSIX permits replacing an open source; inspect handles at the call
        # itself so the original Windows regression fails on every platform.
        check('theme: both ZIP handles are closed before replace',
              len(opened) == 2 and all(z.fp is None for z in opened),
              'open archive modes: %s' %
              [z.mode for z in opened if z.fp is not None])
        check('theme: temporary archive is next to the replacement target',
              os.path.dirname(source) == os.path.dirname(target)
              and source != target and target == rewritten)
        return saved_replace(source, target)

    for attempt in range(2):
        opened.clear()
        replacements.clear()
        TH.zipfile.ZipFile = TrackedZip
        TH.os.replace = replace_closed
        try:
            theme_name = TH.apply_theme_colors(rewritten, SKILL)
        finally:
            TH.zipfile.ZipFile = saved_zip
            TH.os.replace = saved_replace
        check('theme: rewrite %d replaces the existing archive once' % attempt,
              len(replacements) == 1)
        with zipfile.ZipFile(rewritten, 'r') as archive:
            theme_xml = archive.read('ppt/theme/theme1.xml').decode('utf-8')
            preserved = all(archive.read(part) == body.encode('utf-8')
                            for part, body in parts.items()
                            if part != 'ppt/theme/theme1.xml')
        check('theme: rewrite %d applies the scheme and preserves other parts'
              % attempt,
              theme_name == good['name']
              and '<a:dk1><a:srgbClr val="%s"/></a:dk1>'
              % good['scheme']['dk1'] in theme_xml and preserved,
              'name=%s, theme=%s, preserved=%s'
              % (theme_name, theme_xml[:160], preserved))
        no_temporary_files('successful rewrite %d' % attempt)

    def fail_replace(*args, **kwargs):
        raise PermissionError('simulated replacement failure')

    TH.os.replace = fail_replace
    try:
        refused_unchanged('failed replacement', real, PermissionError,
                          'simulated replacement failure')
    finally:
        TH.os.replace = saved_replace

    class FailedWriteZip(saved_zip):
        def writestr(self, *args, **kwargs):
            super().writestr(*args, **kwargs)
            raise OSError('simulated partial archive write failure')

    TH.zipfile.ZipFile = FailedWriteZip
    try:
        refused_unchanged('failed archive write', real, OSError,
                          'simulated partial archive write failure')
    finally:
        TH.zipfile.ZipFile = saved_zip

    _raises('font embed: package is missing a required part',
            FE.FontEmbedError, 'is missing from the pptx',
            lambda: FE.embed_fonts(no_theme, SKILL))
    _raises('font embed: no </Types> to extend', FE.FontEmbedError,
            'no </Types>', lambda: FE._add_content_type('<Types>'))
    _raises('font embed: no </Relationships> to extend', FE.FontEmbedError,
            'no </Relationships>',
            lambda: FE._add_relationships('<Relationships>', []))
    _raises('font embed: nowhere in schema order to place the list',
            FE.FontEmbedError, 'schema order',
            lambda: FE._add_embedded_font_list('<p:presentation/>', []))


def _svg_pixels(body, size=100):
    """Rasterise a `size`-square SVG body; returns a function (x, y) -> RGBA."""
    from deckkit.html2pptx.svgraster import rasterize
    markup = ('<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" '
              'viewBox="0 0 %d %d">%s</svg>' % (size, size, size, size, body))
    image = rasterize(markup, out_width=size, out_height=size).convert('RGBA')
    return lambda x, y: image.getpixel((x, y))


def test_svg_raster_geometry():
    """The SVG rasteriser draws paths, gradients, clips and colours as SVG does.

    The icons, the backgrounds and the chart point badges all go through
    `svgraster` - it replaces cairosvg, which cannot be installed here - and
    until 2.1 only its blur had a direct check. Each case is one small SVG and
    a few pixels whose colour follows from the SVG rules, not a stored hash,
    so a legitimate antialiasing change does not fail them.
    """
    def ok(name, condition, detail):
        check(name, condition, repr(detail))

    def filled(rgba):
        return rgba[3] > 200

    def empty(rgba):
        return rgba[3] < 40

    at = _svg_pixels('<path d="M10 10 L90 10 L90 90 L10 90 Z" fill="#ff0000"/>')
    ok('svg: a closed line path fills its inside',
       at(50, 50)[:3] == (255, 0, 0) and filled(at(50, 50)), at(50, 50))
    ok('svg: and nothing outside it', empty(at(5, 5)), at(5, 5))

    # The sweep flag picks the side the arc bulges to: 1 runs clockwise on
    # screen, so from the left point to the right one it passes over the top.
    at = _svg_pixels('<path d="M10 50 A40 40 0 0 1 90 50 Z" fill="#000"/>')
    ok('svg: arc with sweep=1 bulges up',
       filled(at(50, 20)) and empty(at(50, 80)), (at(50, 20), at(50, 80)))
    at = _svg_pixels('<path d="M10 50 A40 40 0 0 0 90 50 Z" fill="#000"/>')
    ok('svg: arc with sweep=0 bulges down',
       filled(at(50, 80)) and empty(at(50, 20)), (at(50, 80), at(50, 20)))
    # The large-arc flag picks the long way round: from the top of a circle
    # centred at (50, 50) to its right-hand point, the short arc stays in the
    # top-right quarter and the long one (anticlockwise, sweep=0) covers the
    # other three.
    at = _svg_pixels('<path d="M50 10 A40 40 0 1 0 90 50 Z" fill="#000"/>')
    ok('svg: arc with large-arc=1 takes the long way',
       filled(at(30, 70)) and empty(at(78, 22)), (at(30, 70), at(78, 22)))
    at = _svg_pixels('<path d="M50 10 A40 40 0 0 1 90 50 Z" fill="#000"/>')
    ok('svg: arc with large-arc=0 takes the short way',
       empty(at(30, 70)) and filled(at(78, 22)), (at(30, 70), at(78, 22)))

    # Bezier peaks: the cubic's midpoint is at y = 30, the quadratic's at 50.
    at = _svg_pixels('<path d="M10 90 C10 10 90 10 90 90 Z" fill="#000"/>')
    ok('svg: cubic bezier reaches its midpoint',
       filled(at(50, 36)) and empty(at(50, 24)), (at(50, 36), at(50, 24)))
    at = _svg_pixels('<path d="M10 90 Q50 10 90 90 Z" fill="#000"/>')
    ok('svg: quadratic bezier reaches its midpoint',
       filled(at(50, 56)) and empty(at(50, 44)), (at(50, 56), at(50, 44)))

    at = _svg_pixels(
        '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="0">'
        '<stop offset="0" stop-color="#ff0000"/>'
        '<stop offset="1" stop-color="#0000ff"/></linearGradient></defs>'
        '<rect width="100" height="100" fill="url(#g)"/>')
    left, right = at(3, 50), at(96, 50)
    ok('svg: linear gradient runs from its first stop to its last',
       left[0] > 230 and left[2] < 25 and right[2] > 230 and right[0] < 25,
       (left, right))
    at = _svg_pixels(
        '<defs><clipPath id="c"><circle cx="50" cy="50" r="20"/></clipPath></defs>'
        '<rect width="100" height="100" fill="#00ff00" clip-path="url(#c)"/>')
    ok('svg: clipPath keeps the inside', filled(at(50, 50))
       and at(50, 50)[1] == 255, at(50, 50))
    ok('svg: clipPath drops the outside', empty(at(10, 10)), at(10, 10))

    # Colour syntax SVG allows; one parser serves SVG and CSS since 2.1, and
    # these pin what it has to keep reading on the SVG side.
    for spelling, want in (('#ff0000', (255, 0, 0, 255)),
                           ('#f00', (255, 0, 0, 255)),
                           ('#ff000080', (255, 0, 0, 128)),
                           ('#f008', (255, 0, 0, 136)),
                           ('rgb(0, 0, 255)', (0, 0, 255, 255)),
                           ('rgb(100%, 0%, 0%)', (255, 0, 0, 255)),
                           ('rgba(0, 0, 255, 0.5)', (0, 0, 255, 128)),
                           ('red', (255, 0, 0, 255))):
        got = _svg_pixels('<rect width="100" height="100" fill="%s"/>'
                          % spelling)(50, 50)
        ok('svg: fill="%s" reads as %s' % (spelling, want),
           all(abs(a - b) <= 1 for a, b in zip(got, want)), got)
    got = _svg_pixels('<rect width="100" height="100" fill="transparent"/>')(50, 50)
    ok('svg: fill="transparent" paints nothing', got[3] == 0, got)

    # The stylesheet reads colours through the same parser, in 0..1 alpha.
    from deckkit.html2pptx import values as V
    for spelling, want in (('rgb(50%, 0%, 100%)', (128, 0, 255, 1.0)),
                           ('rgb(255 0 0 / 50%)', (255, 0, 0, 0.5)),
                           ('#f008', (255, 0, 0, 136 / 255.0)),
                           ('orange', (255, 165, 0, 1.0))):
        ok('css: %s reads as %s' % (spelling, want), V.color(spelling) == want,
           V.color(spelling))


def test_blur_is_premultiplied():
    """Blur in the rasterizer is computed on premultiplied color.

    The layer stores color separately from alpha, and outside the shape RGB
    is zero, i.e. black. Blurring channels independently, PIL dragged that
    black into the translucent halo: a light spot was surrounded by dark,
    not light smear. On black slides this extinguished grey spots from
    `black-pattern.svg`, and the background looked flat black.

    We check the invariant on a light circle over a grey background: the halo
    must lie between the background and the circle color, and with the bug
    it goes darker than the background.
    """
    import numpy as np

    from deckkit.html2pptx.svgraster import rasterize

    markup = (
        '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" '
        'viewBox="0 0 200 200">'
        '<defs><filter id="f" x="-50%" y="-50%" width="200%" height="200%">'
        '<feGaussianBlur stdDeviation="12"/></filter></defs>'
        '<rect width="200" height="200" fill="#808080"/>'
        '<g filter="url(#f)"><circle cx="100" cy="100" r="55" fill="#FFFFFF"/></g>'
        '</svg>')
    lum = np.asarray(rasterize(markup, out_width=200, out_height=200)
                     .convert('L')).astype(int)
    check('blurred halo not darker than background', lum.min() >= 128,
          'min luminance %d on background 128' % lum.min())
    check('blurred spot lighter than background', lum.max() > 250,
          'max luminance %d' % lum.max())

    # Same invariant on a live asset: with the bug the mean background
    # luminance was 20.2 out of 255 and grey spots barely read, now about 24.
    path = os.path.join(SKILL, 'assets', 'images', 'black-pattern.svg')
    dark = np.asarray(rasterize(path, out_width=960, out_height=540)
                      .convert('L')).astype(float)
    check('grey spots readable on black background', dark.mean() > 22.0,
          'mean luminance %.1f' % dark.mean())


def test_inline_svg_cache_stamp(out_dir):
    """Warm inline caches follow drawing changes, while stable inputs reuse PNGs."""
    from unittest.mock import patch
    from deckkit.html2pptx import assets as A
    cache = os.path.join(out_dir, 'inline-stamp-cache')
    svg = etree.fromstring(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 6">'
        '<rect width="8" height="6" fill="#ff0000"/></svg>')
    original = etree.tostring(svg)

    def pixels(path):
        with Image.open(path) as image:
            return image.size, image.convert('RGBA').getpixel((4, 3))

    # Literal colours simulate two rasterizer revisions. The expected pixels
    # and call counts do not depend on the digest or stamp implementation.
    with patch.object(A, '_RASTER_STAMP', 'drawing-revision-a'):
        with patch.object(A, 'rasterize', return_value=Image.new(
                'RGBA', (8, 6), (255, 0, 0, 255))) as draw:
            first = A.AssetResolver(out_dir, cache)._raster_inline_svg(svg, 8, 6)
        check('inline cache: first revision draws once with exact pixels',
              draw.call_count == 1 and pixels(first) == ((8, 6), (255, 0, 0, 255)))
        with patch.object(A, 'rasterize', side_effect=AssertionError('warm redraw')):
            warm = A.AssetResolver(out_dir, cache)._raster_inline_svg(svg, 8, 6)
        check('inline cache: unchanged stamp reuses a PNG across resolvers', warm == first)

    with patch.object(A, '_RASTER_STAMP', 'drawing-revision-b'):
        with patch.object(A, 'rasterize', return_value=Image.new(
                'RGBA', (8, 6), (0, 0, 255, 255))) as draw:
            second = A.AssetResolver(out_dir, cache)._raster_inline_svg(svg, 8, 6)
        check('inline cache: changed drawing stamp invokes rasterizer again',
              draw.call_count == 1)
        check('inline cache: changed stamp publishes fresh pixels at a new path',
              second != first and pixels(second) == ((8, 6), (0, 0, 255, 255)))
        check('inline cache: old revision remains intact',
              pixels(first) == ((8, 6), (255, 0, 0, 255)))
        with patch.object(A, 'rasterize', side_effect=AssertionError('warm redraw')):
            warm = A.AssetResolver(out_dir, cache)._raster_inline_svg(svg, 8, 6)
        check('inline cache: new revision also reuses its PNG', warm == second)
    check('inline cache: caller SVG remains unchanged', etree.tostring(svg) == original)


def _icon_cache_fixture(out_dir, label, payload):
    """Small deterministic archives; payload length controls equal ZIP sizes."""
    base = os.path.join(out_dir, label)
    directory = os.path.join(base, 'icons')
    os.makedirs(directory, exist_ok=True)
    archive_path = os.path.join(directory, 'icons.zip')
    with zipfile.ZipFile(archive_path, 'w', compression=zipfile.ZIP_STORED) as archive:
        for name, data in [('icon.png', payload), ('unused.png', b'NOT-REQUESTED')]:
            archive.writestr(zipfile.ZipInfo(name, (2020, 1, 1, 0, 0, 0)), data)
    os.utime(archive_path, (1700000000, 1700000000))
    return base, archive_path


def test_icon_archive_cache_identity(out_dir):
    """Persistent extraction caches distinguish bytes, not ZIP metadata."""
    from deckkit.html2pptx.assets import AssetResolver
    from unittest.mock import patch
    first_base, first_zip = _icon_cache_fixture(out_dir, 'archive-first', b'ICON-A')
    second_base, second_zip = _icon_cache_fixture(out_dir, 'archive-second', b'ICON-B')
    first_info, second_info = os.stat(first_zip), os.stat(second_zip)
    check('archive cache: fixture ZIP size and whole-second mtime are equal',
          first_info.st_size == second_info.st_size
          and int(first_info.st_mtime) == int(second_info.st_mtime))
    cache = os.path.join(out_dir, 'archive-identity-cache')
    first = AssetResolver(first_base, cache).resolve('icons/icon.png')
    second = AssetResolver(second_base, cache).resolve('icons/icon.png')
    check('archive cache: first payload is exact', open(first, 'rb').read() == b'ICON-A')
    check('archive cache: equal-metadata ZIP returns its own bytes',
          open(second, 'rb').read() == b'ICON-B')
    check('archive cache: different archives have different destinations', first != second)
    with patch('zipfile.ZipFile.read', side_effect=AssertionError('unexpected extraction')):
        reused = AssetResolver(second_base, cache).resolve('icons/icon.png')
    check('archive cache: identical archive reuses the extracted member', reused == second)
    for path in (first, second):
        check('archive cache: unused members stay unextracted at %s' % os.path.basename(
            os.path.dirname(path)), os.listdir(os.path.dirname(path)) == ['icon.png'])
    os.utime(first_zip, (1700000010, 1700000010))
    same_content = AssetResolver(first_base, cache).resolve('icons/icon.png')
    check('archive cache: unchanged bytes reuse cache after mtime changes',
          same_content == first)
    shutil.copyfile(second_zip, first_zip)
    os.utime(first_zip, (1700000000, 1700000000))
    replaced = AssetResolver(first_base, cache).resolve('icons/icon.png')
    check('archive cache: a new resolver notices same-path replacement',
          open(replaced, 'rb').read() == b'ICON-B' and replaced == second)


def test_icon_archive_parallel_extraction(out_dir):
    """Two writers publish complete bytes through separate temporary files."""
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier
    from unittest.mock import patch
    from deckkit.html2pptx.assets import AssetResolver
    base, _archive = _icon_cache_fixture(out_dir, 'archive-parallel', b'ICON-A')
    cache = os.path.join(out_dir, 'archive-parallel-cache')
    resolvers = [AssetResolver(base, cache) for _ in range(2)]
    ready = Barrier(2)
    partials = []
    real_replace = os.replace

    def publish(source, target):
        partials.append(source)
        # Both writers have finished their temporary files before either rename.
        ready.wait(timeout=5)
        return real_replace(source, target)

    with patch('deckkit.html2pptx.assets.os.replace', side_effect=publish):
        with ThreadPoolExecutor(max_workers=2) as workers:
            futures = [workers.submit(resolver._from_icon_archive,
                       [os.path.join(base, 'icons', 'icon.png')]) for resolver in resolvers]
            paths = [future.result(timeout=10) for future in futures]
    check('archive cache: concurrent writers use distinct temporary files',
          len(partials) == 2 and len(set(partials)) == 2)
    check('archive cache: both concurrent extractions return complete icons',
          all(path and open(path, 'rb').read() == b'ICON-A' for path in paths)
          and paths[0] == paths[1])
    check('archive cache: successful extraction leaves no temporary files',
          all(not os.path.exists(path) for path in partials))


def test_icon_archive_failed_extraction(out_dir):
    """Failed publication leaves neither a partial icon nor orphaned files."""
    from unittest.mock import patch
    from deckkit.html2pptx.assets import AssetResolver
    base, _archive = _icon_cache_fixture(out_dir, 'archive-failure', b'ICON-A')
    cache = os.path.join(out_dir, 'archive-failure-cache')
    resolver = AssetResolver(base, cache)
    with patch('deckkit.html2pptx.assets.os.replace', side_effect=OSError('publish failed')):
        path = resolver._from_icon_archive([os.path.join(base, 'icons', 'icon.png')])
    check('archive cache: failed publication returns no asset', path is None)
    files = [name for _directory, _children, names in os.walk(cache) for name in names]
    check('archive cache: failed publication cleans temporary files', files == [], str(files))
    recovered = AssetResolver(base, cache).resolve('icons/icon.png')
    check('archive cache: retry after publication failure succeeds',
          recovered is not None and open(recovered, 'rb').read() == b'ICON-A')


def test_icon_pack_transaction(out_dir):
    """A rejected or interrupted pack preserves the published archive exactly."""
    import pack_icons as P
    from unittest.mock import patch

    def fixture(label):
        root = os.path.join(out_dir, 'pack-' + label)
        icons = os.path.join(root, 'assets', 'icons')
        source = os.path.join(root, 'source')
        os.makedirs(icons)
        os.makedirs(source)
        with open(os.path.join(icons, 'INDEX.json'), 'w', encoding='utf-8') as f:
            json.dump({'icons': [{'file': 'a.png'}, {'file': 'b.png'}]}, f)
        path = os.path.join(icons, 'icons.zip')
        with zipfile.ZipFile(path, 'w') as archive:
            archive.writestr('a.png', b'OLD-A')
            archive.writestr('b.png', b'OLD-B')
        for name, data in [('b.png', b'NEW-B'), ('a.png', b'NEW-A')]:
            with open(os.path.join(source, name), 'wb') as f:
                f.write(data)
        return root, icons, source, path, open(path, 'rb').read()

    def invoke(root, source):
        out, err = io.StringIO(), io.StringIO()
        try:
            code = P.do_pack(root, source, out, err)
        except (OSError, zipfile.BadZipFile, RuntimeError, AssertionError) as error:
            code = 'raised %s' % type(error).__name__
            err.write(str(error))
        return code, out.getvalue(), err.getvalue()

    for label in ['missing', 'unlisted']:
        root, icons, source, path, original = fixture(label)
        if label == 'missing':
            os.unlink(os.path.join(source, 'b.png'))
        else:
            with open(os.path.join(source, 'extra.png'), 'wb') as f:
                f.write(b'EXTRA')
        with patch('tempfile.mkstemp', side_effect=AssertionError('unexpected staging')), \
                patch.object(zipfile, 'ZipFile', side_effect=AssertionError('unexpected ZIP open')):
            code, out, err = invoke(root, source)
        check('icon pack: %s source is rejected before staging' % label,
              code == 1 and ('b.png' if label == 'missing' else 'extra.png') in err)
        check('icon pack: %s source preserves original ZIP bytes' % label,
              open(path, 'rb').read() == original)
        check('icon pack: %s rejection leaves no temporary files or success message' % label,
              sorted(os.listdir(icons)) == ['INDEX.json', 'icons.zip'] and 'packed ' not in out)

    # Each fault fires after validation of the source, at a different stage.
    for label in ['read', 'write', 'directory', 'members', 'crc', 'bad-zip', 'replace']:
        root, icons, source, path, original = fixture(label)
        real_open, real_write = open, zipfile.ZipFile.writestr
        if label == 'directory':
            os.unlink(os.path.join(source, 'b.png'))
            os.makedirs(os.path.join(source, 'b.png'))

        def read_fail(name, *args, **kwargs):
            if os.fspath(name) == os.path.join(source, 'b.png'):
                raise OSError('injected read failure')
            return real_open(name, *args, **kwargs)

        def write_fail(archive, info, data, *args, **kwargs):
            if info.filename == 'b.png':
                raise OSError('injected write failure')
            return real_write(archive, info, data, *args, **kwargs)

        guards = {
            'read': patch('builtins.open', side_effect=read_fail),
            'write': patch.object(zipfile.ZipFile, 'writestr', write_fail),
            'directory': patch.object(os, 'replace', wraps=os.replace),
            'members': patch.object(P, '_members', return_value=['a.png']),
            'crc': patch.object(zipfile.ZipFile, 'testzip', return_value='b.png'),
            'bad-zip': patch.object(zipfile.ZipFile, 'testzip',
                                   side_effect=zipfile.BadZipFile('injected corrupt ZIP')),
            'replace': patch.object(os, 'replace', side_effect=OSError('injected replace failure')),
        }
        with guards[label]:
            code, out, err = invoke(root, source)
        check('icon pack: %s failure reports a failed operation' % label,
              code == 1 and bool(err))
        check('icon pack: %s failure preserves original ZIP bytes' % label,
              open(path, 'rb').read() == original)
        check('icon pack: %s failure cleans staging and never reports success' % label,
              sorted(os.listdir(icons)) == ['INDEX.json', 'icons.zip'] and 'packed ' not in out)

    root, icons, source, path, original = fixture('success')
    publications = []
    real_replace = os.replace

    def publish(staged, target):
        with zipfile.ZipFile(staged) as archive:
            complete = (archive.namelist() == ['a.png', 'b.png']
                        and archive.read('a.png') == b'NEW-A'
                        and archive.read('b.png') == b'NEW-B'
                        and archive.testzip() is None
                        and all(info.date_time == (1980, 1, 1, 0, 0, 0)
                                for info in archive.infolist()))
        publications.append((staged, target, complete, open(path, 'rb').read()))
        return real_replace(staged, target)

    with patch.object(os, 'replace', side_effect=publish):
        first_code, first_out, first_err = invoke(root, source)
        first_bytes = open(path, 'rb').read()
        second_code, _, second_err = invoke(root, source)
    check('icon pack: valid sources publish and report success',
          first_code == second_code == 0 and not first_err and not second_err
          and 'packed 2 icons' in first_out)
    check('icon pack: publication receives complete deterministic ZIPs',
          len(publications) == 2 and all(entry[2] for entry in publications))
    check('icon pack: live ZIP is unchanged until atomic replacement',
          len(publications) == 2 and publications[0][3] == original
          and publications[1][3] == first_bytes)
    check('icon pack: staging uses unique paths on the target filesystem',
          len(publications) == 2 and publications[0][0] != publications[1][0]
          and all(os.path.dirname(entry[0]) == icons and entry[0] != path
                  and entry[1] == path for entry in publications))
    check('icon pack: identical repacks produce identical bytes',
          first_bytes == open(path, 'rb').read() and first_bytes != original)
    check('icon pack: successful packing leaves only the index and live ZIP',
          sorted(os.listdir(icons)) == ['INDEX.json', 'icons.zip'])

    root, icons, source, path, _ = fixture('first-failure')
    os.unlink(path)
    with patch.object(os, 'replace', side_effect=OSError('first publication failure')):
        code, out, err = invoke(root, source)
    check('icon pack: first publication failure leaves no archive or staging file',
          code == 1 and bool(err) and 'packed ' not in out
          and os.listdir(icons) == ['INDEX.json'])
    code, _, err = invoke(root, source)
    with zipfile.ZipFile(path) as archive:
        members = {name: archive.read(name) for name in archive.namelist()}
    check('icon pack: retry creates a complete first archive',
          code == 0 and not err and members == {'a.png': b'NEW-A', 'b.png': b'NEW-B'}
          and sorted(os.listdir(icons)) == ['INDEX.json', 'icons.zip'])

    class BrokenOutput(io.StringIO):
        def write(self, text):
            raise BrokenPipeError('closed output stream')

    root, icons, source, path, _ = fixture('output-failure')
    err = io.StringIO()
    reported_failure = None
    try:
        reported_failure = P.do_pack(root, source, BrokenOutput(), err)
    except BrokenPipeError:
        pass
    with zipfile.ZipFile(path) as archive:
        members = {name: archive.read(name) for name in archive.namelist()}
    check('icon pack: output failure after publication is not a packing rejection',
          reported_failure is None and not err.getvalue()
          and members == {'a.png': b'NEW-A', 'b.png': b'NEW-B'}
          and sorted(os.listdir(icons)) == ['INDEX.json', 'icons.zip'])


def test_asset_paths_from_any_dir(out_dir):
    """Assets reach PPTX no matter where the presentation is built from.

    The path to the skill is computed from the output directory, and earlier
    it was appended twice. When building to a distant directory the extra
    `../` segments cancelled out and it worked; when building next door —
    icons silently disappeared. So we check both cases, not one.
    """
    from pptx import Presentation
    from pptx.util import Emu

    near = os.path.join(os.path.dirname(SKILL), 'deckselftest-near')
    places = [('distant directory', out_dir), ('directory next to skill', near)]
    try:
        for label, place in places:
            deck = Deck(skill_dir=SKILL)
            deck.title('Проверка путей')
            # Agenda and metrics take background from image in base.css, and
            # paths in CSS are computed from the CSS itself. Without these
            # slides the loss of background would go unnoticed.
            deck.agenda('Повестка', ['Раз', 'Два', 'Три'])
            deck.cards('Иконки', [Card('Раз', 'Текст', icon='щит'),
                                  Card('Два', 'Текст', icon='ракета')])
            deck.metrics('Итоги', 'Подзаголовок',
                         [Metric('+38%', 'Рост'), Metric('6 мин', 'Время')])
            deck.final()
            result = deck.build(os.path.join(place, 'paths'), strict=True,
                                keep_html=True)

            with open(result.html_path, 'r', encoding='utf-8') as f:
                markup = f.read()
            html_dir = os.path.dirname(os.path.abspath(result.html_path))
            broken = [url for url in re.findall(r'(?:src|href)="([^"]+)"', markup)
                      if not url.startswith(('http', 'data:', '#'))
                      and not asset_exists(os.path.normpath(
                          os.path.join(html_dir, url)))]
            check('%s: all asset paths lead to existing files' % label,
                  not broken, '; '.join(broken[:3]))

            pictures, backgrounds = 0, 0
            for slide in Presentation(result.pptx_path).slides:
                # Through groups: the title and closing slides put two of their
                # pictures — the panel's shadows — inside a `glass-panel` group,
                # and a top-level walk would quietly count fewer than the build
                # produced. The assertions below are lower bounds, so that
                # undercount would weaken the check instead of failing it.
                for shape in leaf_shapes(slide.shapes):
                    if shape.shape_type is None \
                            or 'PICTURE' not in str(shape.shape_type):
                        continue
                    pictures += 1
                    if Emu(shape.width).inches * 96 > 1900:
                        backgrounds += 1
            check('%s: icons reach PPTX' % label, pictures >= 2,
                  'images in file: %d' % pictures)
            check('%s: background images reach PPTX' % label,
                  backgrounds >= 3, 'backgrounds in file: %d' % backgrounds)
    finally:
        shutil.rmtree(near, ignore_errors=True)


def test_typography_scale():
    """assets/typography.json and the markup must not drift apart.

    The numbers live in one place but land in two: Python reads the JSON,
    while template.html carries the same values inline, so that the template,
    opened on its own, still looks like the layout. That's exactly how the
    layout set fell apart last time — two sources of truth that nobody
    cross-checked.
    """
    from deckkit import typography as T

    scale = T.load(SKILL)
    registry = json.loads(read_text(os.path.join(
        SKILL, 'assets', 'layouts', 'layouts.json')))['layouts']
    template = read_text(os.path.join(SKILL, 'assets', 'layouts', 'template.html'))
    blocks = cut_template_slides(template)
    css = read_text(os.path.join(SKILL, 'assets', 'base.css'))

    check('typography: scale loads',
          scale.layouts and scale.tiers and scale.ladders)

    # The ladder must be monotonic in both coordinates: otherwise a slide with
    # longer text ends up with a title LARGER than its neighbor's.
    for layout in sorted(scale.layouts):
        steps = scale.candidates(layout)
        check('typography: %s has steps' % layout, len(steps) >= 2,
              '%d' % len(steps))
        drops = [(steps[i][0] >= steps[i + 1][0] and steps[i][1] >= steps[i + 1][1])
                 for i in range(len(steps) - 1)]
        check('typography: %s ladder is monotonic' % layout, all(drops),
              '%s' % (steps,))
        pair = scale.pair_of(layout)
        low, high = pair['min_gap'], pair['max_gap']
        window = [low <= t - b <= high for t, b in steps]
        check('typography: %s gap stays inside the window' % layout, all(window),
              '%s' % ([(t, b) for t, b in steps if not low <= t - b <= high],))

    # Line height lives in CSS, sizes live in JSON. We check that the CSS
    # carries the same line height the ladder declares for its role. The
    # role-to-class map is read from the ladder data rather than listed here,
    # so a ladder added without its CSS counterpart fails instead of being
    # skipped - which is how v1.4's second pair gets covered for free.
    for role in sorted(scale.ladders):
        want = scale.line_height(role)
        for css_class in scale.classes(role):
            found = re.search(
                r'\.%s\s*\{[^}]*?line-height:\s*([^;]+);' % css_class, css)
            check('typography: line-height .%s == %s' % (css_class, want),
                  found is not None and found.group(1).strip() == want,
                  found.group(1).strip() if found else 'not found')

    # The inline size in the template is the top step of that layout's ladder.
    for layout, block in zip([entry['slug'] for entry in registry], blocks):
        ceiling = scale.ceiling_of(layout)
        if ceiling is None:
            continue
        for role, want in sorted(ceiling.items()):
            for css_class in scale.classes(role):
                found = set(int(m) for m in re.findall(
                    r'class="%s" style="font-size: (\d+)px;"' % css_class, block))
                if not found:
                    continue
                check('typography: %s .%s == %d in the template'
                      % (layout, css_class, want),
                      found == set([want]), '%s' % sorted(found))
        # A figure already present in a template has the matching default.
        # Optional value heads inserted by the filler are verified on actual
        # fitted documents in test_card_value_output, not against base CSS.
        figure = scale.figure_of(layout)
        if figure:
            top = ceiling[scale.pair_of(layout)['title']]
            want = int(round(top * figure['per_title']))
            for css_class in figure['classes']:
                if not re.search(r'class="[^"]*\b%s\b' % css_class, block):
                    continue
                found = re.search(
                    r'\.%s\s*\{[^}]*?font-size:\s*(\d+)px;' % css_class, css)
                check('typography: %s .%s == %d in the CSS (%s x %s)'
                      % (layout, css_class, want, top, figure['per_title']),
                      found is not None and int(found.group(1)) == want,
                      found.group(1) if found else 'not found')

        tier = scale.tier_of(layout)
        pads = set(re.findall(r'padding: ([^;]+); gap: (\d+)px;', block))
        check('typography: %s padding/gap == %s / %dpx'
              % (layout, tier.padding, tier.item_gap),
              pads == set([(tier.padding, str(tier.item_gap))]),
              '%s' % sorted(pads))

    # Every layout in the builder must be card-based, headline-based, or listed
    # as `unfitted` with its reason - and `typography.load` refuses the file
    # otherwise, so this is checked on every build, not only here.
    physical = list(L.physical(SKILL))
    check('typography: all layouts are accounted for',
          scale.check_layouts(physical) == [], scale.check_layouts(physical))
    check('typography: every unfitted layout says why',
          all(isinstance(why, str) and why.strip()
              for why in scale.unfitted.values()), sorted(scale.unfitted))
    with open(T.default_path(SKILL), encoding='utf-8') as handle:
        data = json.load(handle)
    broken = json.loads(json.dumps(data))
    del broken['unfitted']['agenda']
    problems = T.Scale(broken).check_layouts(physical)
    check('typography: a layout in none of the tables is refused by name',
          len(problems) == 1 and 'agenda' in problems[0], problems)
    broken = json.loads(json.dumps(data))
    broken['layouts']['cards-9'] = broken['layouts']['cards-4']
    problems = T.Scale(broken).check_layouts(physical)
    check('typography: an entry for a layout that does not exist is refused',
          len(problems) == 1 and 'cards-9' in problems[0], problems)
    broken = json.loads(json.dumps(data))
    broken['unfitted']['cards-3'] = 'a mistake'
    problems = T.Scale(broken).check_layouts(physical)
    check('typography: a layout cannot both ride a ladder and be unfitted',
          len(problems) == 1 and 'cards-3' in problems[0], problems)


def test_engine_imports_nothing_of_deckkit():
    """`html2pptx` is the engine and `deckkit` sits on top of it, one way.

    Until 2.1 the engine reached up four times - the layout into `chartgeom`
    and `model`, the writer into `formula`, the text measure into `model` -
    and the package only imported because of the order modules happened to
    load in. Read from the syntax tree, not grepped: a relative import that
    climbs out of the package (`from .. import x`, level 2 or more) or an
    absolute one naming `deckkit` is the leak.
    """
    import ast
    engine = os.path.join(SKILL, 'scripts', 'deckkit', 'html2pptx')
    leaks = []
    for name in sorted(os.listdir(engine)):
        if not name.endswith('.py'):
            continue
        with open(os.path.join(engine, name), encoding='utf-8') as handle:
            tree = ast.parse(handle.read(), name)
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom):
                if node.level >= 2 or (node.module or '').startswith('deckkit'):
                    leaks.append('%s:%d' % (name, node.lineno))
            elif isinstance(node, ast.Import):
                leaks.extend('%s:%d' % (name, node.lineno) for alias in node.names
                             if alias.name.startswith('deckkit'))
    check('the engine imports nothing from deckkit', not leaks, ', '.join(leaks))


def test_one_layout_pass(out_dir):
    """The deck is laid out once and the result is handed on.

    Not a matter of taste. Before v1.5 the size search, the validator and the
    PPTX writer each opened the file and built their own Stylesheet, LayoutEngine
    and FontBook, so "the layout the validator approved" and "the layout that
    shipped" were two separate computations that were only ever expected to
    agree. The checks below pin the seam — one `Document`, its box trees reused
    — because putting a re-parse back would restore that gap without a symptom.
    """
    deck = Deck(skill_dir=SKILL)
    deck.title('Заголовок', subtitle='Подзаголовок', author='Имя Фамилия')
    deck.cards('Заголовок слайда',
               [{'title': 'Карточка', 'text': 'Короткий текст', 'icon': 'рост'}
                for _ in range(3)])
    result = deck.build(os.path.join(out_dir, 'onepass'), strict=False,
                        pptx=False, keep_html=True)

    check('layout pass: the build reports a size for every slide',
          len(result.sizes) == len(deck.slides),
          '%d reported, %d slides' % (len(result.sizes), len(deck.slides)))

    document = Document.open(result.html_path, extra_dirs=[SKILL])
    check('layout pass: every slide is found once',
          len(document.elements) == len(deck.slides),
          '%d elements, %d slides' % (len(document.elements), len(deck.slides)))
    check('layout pass: a measured slide is kept, not measured again',
          document.box(1) is document.box(1))
    # The other direction, and the one that matters more: the ladder search
    # asks the same slide the same question at every step, so `measure` must
    # never hand back a remembered tree.
    check('layout pass: measure() stays uncached for the ladder search',
          document.measure(document.elements[0]) is not document.box(1))
    # A style edit reaches the next measurement by itself: set_style clears
    # the stylesheet's entry for the node and drops the kept trees. Until 2.1
    # the caller had to do both, and one missed call meant a stale layout.
    kept = document.box(1)
    heading = [b for b in kept.walk() if b.kind == 'text' and b.lines][0]
    document.set_style(heading.el, 'font-size', '%dpx' % (heading.font_size / 2))
    fresh = document.box(1)
    fresh_heading = [b for b in fresh.walk() if b.el is heading.el][0]
    check('layout pass: set_style drops the kept trees', fresh is not kept)
    check('layout pass: the next layout is at the new size',
          abs(fresh_heading.font_size - heading.font_size / 2) < 0.5,
          '%s -> %s' % (heading.font_size, fresh_heading.font_size))

    # Deleting the HTML before validating is the only way to be sure the
    # validator reads the document it was handed rather than quietly reopening
    # the file, which is exactly what it used to do.
    os.remove(result.html_path)
    issues = VD.check(deck, document)
    check('layout pass: the validator reads the document, not the file',
          not [i for i in issues if i.level == 'error'],
          '; '.join(str(i) for i in issues))


def test_complex_card_order(out_dir):
    """The fifth complete input card owns the tall yellow conclusion."""
    from pptx import Presentation

    positions = [(56, 278, 592, 361), (668, 278, 592, 361),
                 (56, 663, 592, 361), (668, 663, 592, 361), (1280, 278, 592, 746)]
    filenames = ['doc.png', 'table.png', 'note.png', 'structure.png', 'chart-bar.png']
    cards = [dict(title='Point %d' % i, text='Body %d' % i, icon=icon)
             for i, icon in enumerate(filenames, 1)]
    routes = [('json', lambda data: SP.deck_from_spec(
        {'slides': [dict(data, layout='complex')]}, skill_dir=SKILL)),
              ('add', lambda data: Deck(skill_dir=SKILL).add('complex', data)),
              ('helper', lambda data: Deck(skill_dir=SKILL).complex_cards(data['title'], data['cards']))]
    for rich in (False, True):
        inputs = copy.deepcopy(cards)
        if rich:
            inputs[-1] = dict(value='62%', text='Final body', icon='chart-bar.png',
                              items=['First final item', 'Second final item'])
        for route, create in routes:
            data = dict(title='Four observations and conclusion', cards=copy.deepcopy(inputs))
            before = copy.deepcopy(data)
            deck = create(data)
            label = '%s rich=%s' % (route, rich)
            result = deck.build(os.path.join(out_dir, 'complex-order-%s-%s' % (route, rich)),
                                strict=False, keep_html=True)
            check('complex order: %s fits and preserves input' % label,
                  not result.errors and data == before, str(result.errors))
            document = Document.open(result.html_path, extra_dirs=[SKILL])
            boxes = [box for box in document.box(1).walk() if 'card' in box.classes()]
            check('complex order: %s has five cards' % label, len(boxes) == 5)
            for index, (box, expected) in enumerate(zip(boxes, positions)):
                check('complex order: %s literal position %d' % (label, index + 1),
                      (box.x, box.y, box.w, box.h) == expected, str(box))
                expected_head = '62%' if rich and index == 4 else 'Point %d' % (index + 1)
                head = F.first(box.el, 'chart-card-value' if rich and index == 4 else 'card-subtitle')
                body = F.first(box.el, 'card-description')
                icon = F.first(box.el, 'icon')
                check('complex order: %s complete card %d ownership' % (label, index + 1),
                      head is not None and head.text == expected_head
                      and body is not None and ' '.join(body.itertext()).replace('\u00a0', ' ') == inputs[index]['text']
                      and ('yellow' in box.classes()) == (index == 4)
                      and icon is not None and icon.get('src').endswith('/' + filenames[index]))
            if rich:
                final_items = F.by_class(boxes[-1].el, 'bullet-text')
                check('complex order: %s final list belongs only to yellow card' % label,
                      [' '.join(node.itertext()).replace('\u00a0', ' ') for node in final_items]
                      == ['First final item', 'Second final item']
                      and not any(F.by_class(box.el, 'bullet-text') for box in boxes[:-1]))
            native = Presentation(result.pptx_path).slides[0]
            heads = [shape.text for shape in leaf_shapes(native.shapes)
                     if getattr(shape, 'has_text_frame', False)
                     and (shape.text.startswith('Point ') or shape.text == '62%')]
            check('complex order: %s editable PPTX heads follow logical order' % label,
                  heads == ['Point 1', 'Point 2', 'Point 3', 'Point 4', '62%' if rich else 'Point 5'], str(heads))


def test_grid_axis_syntax(out_dir):
    """Literal axis grammar, exact diagnostics and public adapter refusal."""
    from deckkit.html2pptx import layout as GL
    from deckkit.html2pptx.layout import GridPlacementError, _parse_axis
    from deckkit.html2pptx.convert import write_pptx
    GridAxisError = getattr(GL, 'GridAxisError', GridPlacementError)

    valid = [(None, (None, 1)), ('', (None, 1)), ('  ', (None, 1)),
             ('auto', (None, 1)), ('AUTO / Auto', (None, 1)),
             ('1', (1, 1)), ('+02', (2, 1)), ('9007199254740993', (9007199254740993, 1)),
             ('span 2', (None, 2)), ('SPAN\t+2', (None, 2)),
             ('1 / 4', (1, 3)), ('2 / span 2', (2, 2)),
             ('span 2 / 3', (1, 2)), ('span 2 / 5', (3, 2)),
             ('auto / 4', (3, 1)), ('1 / auto', (1, 1)),
             ('auto / span 2', (None, 2)), ('span 2 / auto', (None, 2))]
    for value, expected in valid:
        try:
            actual = _parse_axis(value)
        except Exception as exc:
            actual = (type(exc).__name__, str(exc))
        check('grid syntax: literal %r' % value, actual == expected, str(actual))

    token_reason = 'expected auto, a positive integer line, or span N'
    malformed = ['1 / -1', '1.5', 'inf', '-inf', 'nan', '1e2', '1.0', '0', '-2',
                 'span 0', 'span -1', 'span 1.5', 'span inf', 'span2', 'span',
                 'span 2 name', 'name', 'calc(1 + 1)', 'inherit', '١',
                 '1 / span 0', '0 / 2', 'auto / 2.5', 'span 2 / inf']
    invalid = [(value, token_reason) for value in malformed]
    invalid += [(value, 'expected one or two non-empty endpoints separated by /')
                for value in ['1 / 3 / 4', '1 /', '/ 2', '/']]
    invalid += [(value, 'end line must be greater than start line')
                for value in ['1 / 1', '3 / 2']]
    invalid += [(value, 'end line must exceed the span')
                for value in ['span 2 / 2', 'span 3 / 2', 'auto / 1']]
    invalid += [('span 2 / span 3', 'two span endpoints are not supported'),
                (0, 'expected a CSS string')]
    for axis in ['grid-column', 'grid-row']:
        for value, reason in invalid:
            actual = None
            try:
                _parse_axis(value, axis)
            except Exception as exc:
                actual = (type(exc), str(exc))
            expected = '%s %r is not supported: %s' % (axis, value, reason)
            check('grid syntax: %s rejects %r' % (axis, value),
                  actual == (GridAxisError, expected), str(actual))
    check('grid syntax: typed error preserves placement adapter contract',
          hasattr(GL, 'GridAxisError') and issubclass(GridAxisError, GridPlacementError)
          and issubclass(GridAxisError, ValueError))

    def source(name, column, row):
        path = os.path.join(out_dir, 'grid-syntax-%s.html' % name)
        with open(path, 'w', encoding='utf-8') as stream:
            stream.write('<html><body><div class="slide" style="width:1920px;height:1080px">'
                         '<div style="position:absolute;left:100px;top:100px;width:620px;'
                         'height:320px;display:grid;column-gap:10px;row-gap:10px;'
                         'grid-template-columns:repeat(3, 1fr);grid-template-rows:repeat(3, 1fr)">'
                         '<div id="probe" style="grid-column:%s;grid-row:%s">Cell</div>'
                         '</div></div></body></html>' % (column, row))
        return path

    geometry = [('span 2 / 3', '1', (100, 100, 410, 100)),
                ('auto / 4', '2', (520, 210, 200, 100)),
                ('2 / span 2', '1 / span 2', (310, 100, 410, 210)),
                ('1 / auto', 'auto / 3', (100, 210, 200, 100)),
                ('1', 'span 2 / 3', (100, 100, 200, 210)),
                ('span 2 / auto', 'auto', (100, 100, 410, 100))]
    for index, (column, row, expected) in enumerate(geometry):
        try:
            path = source('valid%d' % index, column, row)
            box = next(box for box in Document.open(path, extra_dirs=[SKILL]).box(1).walk()
                       if box.el is not None and box.el.get('id') == 'probe')
            actual = (box.x, box.y, box.w, box.h)
        except Exception as exc:
            actual = (type(exc).__name__, str(exc))
        check('grid syntax: literal geometry %d' % index, actual == expected, str(actual))

    paths = []
    for axis, value, reason in [('grid-column', '1 / -1', token_reason),
                                ('grid-column', '1.5', token_reason),
                                ('grid-column', 'inf', token_reason),
                                ('grid-row', 'inf', token_reason),
                                ('grid-row', 'span 2 / 2', 'end line must exceed the span')]:
        path = source('invalid%d' % len(paths), value if axis == 'grid-column' else '1',
                      value if axis == 'grid-row' else '1')
        paths.append(path)
        expected = '%s %r is not supported: %s' % (axis, value, reason)
        try:
            Document.open(path, extra_dirs=[SKILL]).boxes()
            actual = None
        except Exception as exc:
            actual = (type(exc), str(exc))
        check('grid syntax: document rejects %s %r' % (axis, value),
              actual == (GridAxisError, expected), str(actual))
        destination = os.path.join(out_dir, 'grid-syntax-cli%d' % (len(paths) - 1))
        try:
            result = subprocess.run([sys.executable, '-B', os.path.join(HERE, 'preview_deck.py'),
                                     path, '--out', destination], capture_output=True,
                                    text=True, timeout=5)
            passed = (result.returncode == 1
                      and 'preview layout rejected:\n%s\n' % expected in result.stderr
                      and 'Traceback' not in result.stderr
                      and not (os.path.isdir(destination) and os.listdir(destination)))
            detail = result.stderr
        except subprocess.TimeoutExpired:
            passed, detail = False, 'timeout'
        check('grid syntax: CLI rejects %s %r' % (axis, value), passed, detail)

    output = os.path.join(out_dir, 'grid-syntax-rejected.pptx')
    with open(output, 'wb') as stream:
        stream.write(b'previous output')
    rejected = False
    try:
        write_pptx(Document.open(paths[3], extra_dirs=[SKILL]), output)
    except GridAxisError:
        rejected = True
    except Exception:
        pass
    with open(output, 'rb') as stream:
        check('grid syntax: writer refuses invalid row and retains output',
              rejected and stream.read() == b'previous output')


def test_grid_column_bounds(out_dir):
    """Impossible columns reject within a deadline; valid rows still grow."""
    from deckkit.html2pptx.convert import write_pptx

    def source(name, children, tracks='1fr 1fr 1fr', rows=''):
        path = os.path.join(out_dir, 'grid-bounds-%s.html' % name)
        markup = ('<html><body><div class="slide" style="width:1920px;height:1080px">'
                  '<div style="position:absolute;left:100px;top:100px;width:620px;'
                  'height:200px;display:grid;column-gap:10px;row-gap:20px;'
                  'grid-template-columns:%s;grid-template-rows:%s">%s</div>'
                  '</div></body></html>' % (tracks, rows, children))
        with open(path, 'w', encoding='utf-8') as stream:
            stream.write(markup)
        return path

    probe = os.path.join(out_dir, 'grid-bounds-probe.py')
    with open(probe, 'w', encoding='utf-8') as stream:
        stream.write('import json, sys\n'
                     'sys.path.insert(0, sys.argv[1])\n'
                     'from deckkit.html2pptx.document import Document\n'
                     'try:\n'
                     '    Document.open(sys.argv[2], extra_dirs=[sys.argv[3]]).boxes()\n'
                     'except ValueError as exc:\n'
                     '    print(json.dumps({"type": type(exc).__name__, "message": str(exc)}))\n'
                     'else:\n'
                     '    print(json.dumps({"type": "ok"}))\n')
    cases = [('outside', '4', '', '4', 1),
             ('outside-fixed-row', '4', 'grid-row:2;', '4', 1),
             ('cross-edge', '3 / span 2', '', '3', 2),
             ('cross-edge-fixed-row', '3 / span 2', 'grid-row:2;', '3', 2),
             ('auto-wide', 'span 4', '', 'auto', 4),
             ('auto-wide-fixed-row', 'span 4', 'grid-row:2;', 'auto', 4),
             ('end-line', '1 / 5', '', '1', 4)]
    paths = []
    for name, column, row, start, span in cases:
        path = source(name, '<div style="grid-column:%s;%s">Bad</div>' % (column, row))
        paths.append(path)
        expected = ('grid-column %r exceeds 3 explicit columns (start=%s, span=%d); '
                    'implicit columns are not supported' % (column, start, span))
        try:
            result = subprocess.run([sys.executable, '-B', probe, HERE, path, SKILL],
                                    capture_output=True, text=True, timeout=5)
            report = json.loads(result.stdout) if result.returncode == 0 else {}
        except subprocess.TimeoutExpired:
            report = {'type': 'timeout'}
        check('grid bounds: %s rejects promptly with exact diagnostic' % name,
              report == {'type': 'GridPlacementError', 'message': expected}, str(report))
        if report.get('type') == 'timeout':
            return
    default = source('default', '<div style="grid-column:2">Bad</div>', tracks='')
    try:
        result = subprocess.run([sys.executable, '-B', probe, HERE, default, SKILL],
                                capture_output=True, text=True, timeout=5, check=True)
        report = json.loads(result.stdout)
    except (subprocess.TimeoutExpired, subprocess.CalledProcessError):
        report = {}
    check('grid bounds: default has one explicit column', report == {
          'type': 'GridPlacementError', 'message':
          "grid-column '2' exceeds 1 explicit columns (start=2, span=1); implicit columns are not supported"})

    valid = source('valid', '<div id="a" style="grid-column:1;grid-row:1">A</div>'
                   '<div id="b" style="grid-column:3;grid-row:1">B</div>'
                   '<div id="c" style="grid-column:span 2">C</div><div id="d">D</div>',
                   rows='repeat(2, 1fr)')
    boxes = {box.el.get('id'): box for box in Document.open(valid, extra_dirs=[SKILL]).box(1).walk()
             if box.el is not None and box.el.get('id')}
    for name, expected in [('a', (100, 100, 200, 90)), ('b', (520, 100, 200, 90)),
                           ('c', (100, 210, 410, 90)), ('d', (520, 210, 200, 90))]:
        box = boxes[name]
        check('grid bounds: valid %s geometry' % name,
              (box.x, box.y, box.w, box.h) == expected, str(box))

    growing = source('rows', '<div id="fixed" style="grid-column:2;grid-row:1;line-height:40px">Fixed</div>'
                     + ''.join('<div id="auto%d" style="grid-column:2;line-height:40px">Cell</div>' % i
                               for i in range(3)))
    boxes = {box.el.get('id'): box for box in Document.open(growing, extra_dirs=[SKILL]).box(1).walk()
             if box.el is not None and box.el.get('id')}
    for name, y in [('fixed', 100), ('auto0', 160), ('auto1', 220), ('auto2', 280)]:
        box = boxes[name]
        check('grid bounds: occupied fixed column grows row %s' % name,
              (box.x, box.y, box.w, box.h) == (310, y, 200, 40), str(box))

    output = os.path.join(out_dir, 'grid-bounds-rejected.pptx')
    from deckkit.html2pptx.layout import GridPlacementError
    with open(output, 'wb') as stream:
        stream.write(b'previous output')
    rejected = False
    try:
        write_pptx(Document.open(paths[0], extra_dirs=[SKILL]), output)
    except GridPlacementError:
        rejected = True
    with open(output, 'rb') as stream:
        check('grid bounds: writer refuses before saving and retains output',
              rejected and stream.read() == b'previous output')
    destination = os.path.join(out_dir, 'grid-bounds-cli')
    result = subprocess.run([sys.executable, '-B', os.path.join(HERE, 'preview_deck.py'),
                             paths[0], '--out', destination], capture_output=True,
                            text=True, timeout=5)
    check('grid bounds: preview CLI rejects without traceback or PNG',
          result.returncode == 1 and 'preview layout rejected:' in result.stderr
          and "grid-column '4' exceeds 3 explicit columns" in result.stderr
          and 'Traceback' not in result.stderr
          and not (os.path.isdir(destination) and os.listdir(destination)), result.stderr)


def test_autofit_picks_a_step(out_dir):
    """The size should follow the text, not stay put.

    The check catches two breakages at once: forgetting to invalidate the
    style cache in cssparse — and the search measures the same layout over
    and over, always picking the top step; and mixing up the step order —
    and short text ends up with a small size.

    The step is read from `BuildResult.sizes`, i.e. from what the build
    decided. Until v1.5 it was not reported, so this test re-ran the whole
    size search over the already-fitted HTML and asserted on that second
    computation instead — which would have agreed with itself even if the
    build had written something else into the file.
    """
    from deckkit import typography as T

    scale = T.load(SKILL)
    word = 'обслуживание клиентов и партнёров банка в едином окне '

    def make(chars):
        deck = Deck(skill_dir=SKILL)
        deck.cards('Заголовок слайда',
                   [{'title': 'Подзаголовок', 'text': (word * 30)[:chars],
                     'icon': 'рост'} for _ in range(3)])
        path = os.path.join(out_dir, 'autofit-%d' % chars)
        return deck.build(path, strict=False, pptx=False, keep_html=True)

    def build(chars):
        return make(chars).sizes[0].pair

    steps = scale.candidates('cards-3')
    top, floor = steps[0], steps[-1]

    check('autofit: short text takes the top step',
          build(60) == top, '%s, expected %s' % (build(60), top))

    # This is the one that matters. "Long text lands lower" would pass even with
    # a broken search: if the style cache is not invalidated between steps, every
    # step after the first measures the FIRST step's layout, they all fail, and
    # the search falls through to the floor - which is still "lower". Demanding a
    # step strictly inside the ladder is what separates a working search from one
    # that only ever returns the ceiling or the floor. Verified by sabotage:
    # stubbing out Stylesheet.invalidate turns this check red and nothing else.
    middle = build(400)
    check('autofit: mid-length text lands inside the ladder, not on the floor',
          middle != top and middle != floor and middle in steps,
          '%s, ladder %s' % (middle, steps))

    check('autofit: longer text never takes a bigger step',
          build(700)[1] <= middle[1] <= build(120)[1],
          '%s / %s / %s' % (build(120), middle, build(700)))

    # What the build reports must be what the build wrote. Everything above
    # reads `sizes`; this is the one check that opens the shipped HTML and
    # compares. Without it the report could drift away from the file and every
    # other assertion here would still pass.
    fitted = make(400)
    written = set()
    for node in F.by_class(parse_html(fitted.html_path), 'card-description'):
        found = re.search(r'font-size:\s*(\d+)px', node.get('style') or '')
        written.add(int(found.group(1)) if found else None)
    check('autofit: the reported step is the one in the file',
          written == set([fitted.sizes[0].pair[1]]),
          'reported %s, in the HTML %s'
          % (fitted.sizes[0].pair[1], sorted(written, key=str)))
    check('autofit: one size per slide, shared by every card',
          len(written) == 1, '%s' % sorted(written, key=str))

    # Title slide: the very bug the ladder was built for in the first place.
    deck = Deck(skill_dir=SKILL)
    deck.title('Длинный заголовок слайда для проверки переноса строк и центрирования',
               subtitle='Длинный подзаголовок, который тоже может занимать несколько строк',
               author='Имя Фамилия, отдел аналитики')
    path = os.path.join(out_dir, 'autofit-title')
    result = deck.build(path, strict=False, pptx=False, keep_html=True)
    headline = result.sizes[0].headline
    sizes = scale.slide_sizes('title-large')
    check('autofit: long title moves off the top step',
          headline is not None and headline < sizes[0], '%s' % (headline,))
    # The other direction: the obstacle checks must still fire when the ladder
    # genuinely cannot save the slide. Both of these were silent before v1.3 —
    # _slide_issues only compared text against cards and against the bottom
    # edge, so a centred block running up into the logo, or off the top of the
    # slide entirely, shipped without a word.
    for chars, want in ((1100, 'COLLISION'), (2400, 'OVERFLOW')):
        loud = Deck(skill_dir=SKILL)
        loud.title('Заголовок презентации',
                   subtitle=(word * 60)[:chars], author='Имя Фамилия')
        spilled = loud.build(os.path.join(out_dir, 'spill-%d' % chars),
                             strict=False, pptx=False)
        check('autofit: %d-char subtitle is caught as %s' % (chars, want),
              any(i.code == want and i.level == 'error' for i in spilled.issues),
              str([i.code for i in spilled.issues]))

    check('autofit: long title no longer touches the logo',
          not [i for i in result.issues if i.code == 'COLLISION'],
          '%s' % [str(i) for i in result.issues if i.code == 'COLLISION'])


def main(argv=None):
    global VERBOSE
    parser = argparse.ArgumentParser(description='Skill self-test.')
    parser.add_argument('--verbose', action='store_true',
                        help='print all passed checks, not only failures')
    args = parser.parse_args(argv)
    VERBOSE = args.verbose

    logging.basicConfig(level=logging.ERROR, format='%(message)s')
    out_dir = tempfile.mkdtemp(prefix='deckselftest-')
    try:
        deck = Deck(skill_dir=SKILL)
        sys.stdout.write('skill: %s\nicons in index: %d\n\n'
                         % (SKILL, len(deck.icons)))

        run(test_layouts_match_reference, deck)
        run(test_trimming, deck)
        run(test_card_items, deck)
        run(test_fragments_present, deck)
        run(test_assets_exist)
        run(test_no_slide_numbers)
        run(test_package_shape)
        run(test_evals_are_scenarios)
        run(test_security_rules)
        run(test_registry_matches_layouts)
        run(test_grid_column_bounds, out_dir)
        run(test_grid_axis_syntax, out_dir)
        run(test_complex_card_order, out_dir)
        run(test_paint_interface_shared)
        run(test_paint_diagnostics, out_dir)
        run(test_build_paint_diagnostics, out_dir)
        run(test_chartdata_parsing)
        run(test_chartdata_finite_values, out_dir)
        run(test_chartdata_delimiters)
        run(test_chartdata_delimiter_counts)
        run(test_formula_parsing)
        run(test_formula_command_coverage)
        run(test_formula_docs_match_code)
        run(test_formula_delimiter_boundaries)
        run(test_formula_office_math)
        run(test_formula_upright_style, out_dir)
        run(test_formula_text_presentation)
        run(test_formula_html_and_runs)
        run(test_formula_preview_continuation, out_dir)
        run(test_preview_superscript_digits, out_dir)
        run(test_media_resolve_image, out_dir)
        run(test_media_pixel_limit, out_dir)
        run(test_cover_crop, out_dir)
        run(test_object_fit_cover, out_dir)
        run(test_chart_native_render, out_dir)
        run(test_chart_preview, out_dir)
        run(test_doughnut_zero_preview, out_dir)
        run(test_chart_xml_patches, out_dir)
        run(test_chart_legend_density_and_swatch, out_dir)
        run(test_chart_palette_by_kind, out_dir)
        run(test_stress_test_2_1_1, out_dir)
        run(test_line_chart_options, out_dir)
        run(test_line_chart_2_3, out_dir)
        run(test_chart_text_2_5, out_dir)
        run(test_chart_text_auto_2_5, out_dir)
        run(test_doughnut_typography_2_5, out_dir)
        run(test_number_format_2_3, out_dir)
        run(test_number_format_large_values, out_dir)
        run(test_excel_edit_2_3, out_dir)
        run(test_bar_gap_2_3, out_dir)
        run(test_chart_wide_2_3, out_dir)
        run(test_chart_two_2_3, out_dir)
        run(test_chart_title_fit, out_dir)
        run(test_chart_groups, out_dir)
        run(test_chart_cards_ladder, out_dir)
        run(test_card_value_options)
        run(test_card_value_focus_limit)
        run(test_card_api_matches_spec)
        run(test_input_ownership, out_dir)
        run(test_reused_card_ownership)
        run(test_card_value_output, out_dir)
        run(test_chart_placed_in_layout_pass, out_dir)
        run(test_deck_chart_api, out_dir)
        run(test_media_slides_through_spec, out_dir)
        run(test_picture_clipping, out_dir)
        run(test_picture_anchor_and_bottom_clip, out_dir)
        run(test_exif_orientation, out_dir)
        run(test_image_options, out_dir)
        run(test_image_fit, out_dir)
        run(test_screenshot_options, out_dir)
        run(test_screenshot_headline_orphans, out_dir)
        run(test_screenshot_native_primitives, out_dir)
        run(test_screenshot_frame_output, out_dir)
        run(test_screenshot_caption_alignment, out_dir)
        run(test_screenshot_capacity, out_dir)
        run(test_self_intro_options, out_dir)
        run(test_self_intro_output, out_dir)
        run(test_self_intro_capacity, out_dir)
        run(test_illustration_options)
        run(test_illustration_output, out_dir)
        run(test_circle_options)
        run(test_circle_output, out_dir)
        run(test_image_frame_output, out_dir)
        run(test_image_capacity, out_dir)
        run(test_media_image_relative_src, out_dir)
        run(test_spec_rejects_mistakes)
        run(test_icon_enforcement_cases)
        run(test_formula_enforcement_cases, out_dir)
        run(test_formula_authoring, out_dir)
        run(test_large_technical_deck, out_dir)
        run(test_untagged_math)
        run(test_formula_prohibited_fields)
        run(test_layout_runs)
        run(test_layout_concentration)
        run(test_element_kinds, deck)
        run(test_icon_checks_cover_every_kind)
        run(test_formula_author_fixes, out_dir)
        run(test_formula_errors_are_all_reported, out_dir)
        run(test_bullet_marker_follows_a_tall_line, out_dir)
        run(test_spec_accepts_example)
        run(test_example_plan_matches_spec)
        run(test_docs_match_code)
        run(test_typography_scale)
        run(test_engine_imports_nothing_of_deckkit)
        run(test_one_layout_pass, out_dir)
        run(test_autofit_picks_a_step, out_dir)
        run(test_icons, deck)
        run(test_overflow, out_dir)
        run(test_formula_geometry, out_dir)
        run(test_slide_headline_width, out_dir)
        run(test_headline_ladder_runs_out, out_dir)
        run(test_columns_title_panel_clearance, out_dir)
        run(test_columns_subtitle_gutters, out_dir)
        run(test_emoji_and_structure, out_dir)
        run(test_texts_cover_every_field, out_dir)
        run(test_line_widths_agree, out_dir)
        run(test_typeset)
        run(test_glue_steps_down)
        run(test_final_and_title_2_3, out_dir)
        run(test_title_two_lines, out_dir)
        run(test_short_title, out_dir)
        run(test_final_2_4, out_dir)
        run(test_statement_looks, out_dir)
        run(test_card_glow, out_dir)
        run(test_versus, out_dir)
        run(test_numbered_cards, out_dir)
        run(test_charts_new_2_4, out_dir)
        run(test_series_options)
        run(test_series_output, out_dir)
        run(test_text_slide_options)
        run(test_text_slide_output, out_dir)
        run(test_text_slide_ladder, out_dir)
        run(test_table_options)
        run(test_table_output, out_dir)
        run(test_table_column_gaps, out_dir)
        run(test_table_limits, out_dir)
        run(test_field_errors_2_3)
        run(test_agenda_bottom_anchored, out_dir)
        run(test_pptx_roundtrip, out_dir)
        run(test_document_title_and_slide_count, out_dir)
        run(test_notes_reach_pptx, out_dir)
        run(test_glass_shadows, out_dir)
        run(test_shape_grouping, out_dir)
        run(test_font_set, out_dir)
        run(test_build_transaction, out_dir)
        run(test_font_embed_transaction, out_dir)
        run(test_theme_and_font_embed_errors, out_dir)
        run(test_svg_raster_geometry)
        run(test_blur_is_premultiplied)
        run(test_asset_paths_from_any_dir, out_dir)
        run(test_inline_svg_cache_stamp, out_dir)
        run(test_icon_archive_cache_identity, out_dir)
        run(test_icon_archive_parallel_extraction, out_dir)
        run(test_icon_archive_failed_extraction, out_dir)
        run(test_icon_pack_transaction, out_dir)
    finally:
        shutil.rmtree(out_dir, ignore_errors=True)

    if FAILED:
        sys.stdout.write('\nFAILED %d: %s\n' % (len(FAILED), '; '.join(FAILED)))
        return 1
    sys.stdout.write('\nall checks passed\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
