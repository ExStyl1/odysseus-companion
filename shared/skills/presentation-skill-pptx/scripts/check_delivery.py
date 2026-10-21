#!/usr/bin/env python3
"""Inspect a generated PPTX against its JSON spec without modifying either."""
import argparse
import json
import os
import posixpath
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from deckkit.layouts import PUBLIC                              # noqa: E402
from deckkit.html2pptx.formula import FormulaError, parse_inline  # noqa: E402

NS = {
    'p': 'http://schemas.openxmlformats.org/presentationml/2006/main',
    'a': 'http://schemas.openxmlformats.org/drawingml/2006/main',
    'm': 'http://schemas.openxmlformats.org/officeDocument/2006/math',
    'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
    'rel': 'http://schemas.openxmlformats.org/package/2006/relationships',
    'c': 'http://schemas.openxmlformats.org/drawingml/2006/chart',
}
LIMITS = [
    'Only explicit formula markup in supported body fields is inventoried; '
    'prose, values and speaker notes do not establish equation intent.',
    'Per-slide equation counts do not prove equation meaning, order within a '
    'slide, adjacent prose, or mathematical equivalence.',
    'Title presence is an order sanity check, not slide identity: repeated or '
    'missing titles and identical equation counts can conceal reordered slides. '
    'The heading is read from the field each layout uses (text on title, '
    'statement and final slides, name on self-intro); a final slide without '
    'text and layouts with no heading field (versus) are not checked.',
    'Picture crop rectangles include decorative pictures; absence of a crop '
    'warning does not prove diagram completeness or absence of other clipping.',
    'No PNG or native PowerPoint rendering is inspected. Visual review and '
    'existing build validation remain required; this is not full OOXML validation.',
]


def strings(value, path='', generic=''):
    """Yield indexed source paths and registry paths without restating fields."""
    if isinstance(value, str):
        yield path, generic, value
    elif isinstance(value, list):
        for index, item in enumerate(value):
            yield from strings(item, path + '[%d]' % index, generic + '[]')
    elif isinstance(value, dict):
        for key, item in value.items():
            yield from strings(item, path + ('.' if path else '') + key,
                               generic + ('.' if generic else '') + key)


def expected_formulas(slide):
    layout = slide.get('layout')
    if not isinstance(layout, str) or layout not in PUBLIC:
        raise ValueError('unknown slide layout: %r' % layout)
    allowed = PUBLIC[layout].formula_paths()
    return [{'field': actual, 'latex': text}
            for actual, generic, value in strings(slide) if generic in allowed
            for kind, text in parse_inline(value) if kind == 'math']


def normalized(text):
    return ''.join(text.split()).replace('\u00ad', '')


# Layouts whose heading is not in a "title" field. A title slide's headline,
# a statement and a closing line are "text"; a speaker introduction is headed
# by the "name". Reading "title" alone left the boundary slides unchecked.
_HEADING_FIELD = {'title': 'text', 'statement': 'text', 'final': 'text',
                  'self-intro': 'name'}


def heading(slide):
    """The text a slide shows as its heading, or '' when it has none."""
    return slide.get(_HEADING_FIELD.get(slide.get('layout'), 'title'), '')


def read_xml(archive, name):
    return ET.fromstring(archive.read(name))


def slide_parts(archive):
    presentation = read_xml(archive, 'ppt/presentation.xml')
    relations = read_xml(archive, 'ppt/_rels/presentation.xml.rels')
    lookup = {item.get('Id'): item for item in relations}
    result = []
    slide_list = presentation.find('p:sldIdLst', NS)
    if slide_list is None:
        raise ValueError('presentation has no slide list')
    for item in slide_list:
        relation = lookup.get(item.get('{%s}id' % NS['r']))
        if relation is None or relation.get('TargetMode') == 'External' \
                or not relation.get('Type', '').endswith('/slide'):
            raise ValueError('missing or invalid slide relationship')
        target = relation.get('Target', '')
        part = posixpath.normpath(target.lstrip('/') if target.startswith('/')
                                 else posixpath.join('ppt', target))
        if not part.startswith('ppt/') or part in result:
            raise ValueError('invalid or duplicate slide target')
        result.append(part)
    return result


def inspect(spec, pptx):
    if not isinstance(spec, dict) or not isinstance(spec.get('slides'), list) \
            or not all(isinstance(s, dict) for s in spec['slides']):
        raise ValueError('spec must contain a list of slide objects')
    formulas = [expected_formulas(slide) for slide in spec['slides']]
    if any(not isinstance(heading(slide), str) for slide in spec['slides']):
        raise ValueError('slide titles must be strings')
    report = {'status': 'pass', 'errors': [], 'warnings': [], 'slides': [],
              'review_slides': [], 'limits': LIMITS}
    with zipfile.ZipFile(pptx) as archive:
        parts = slide_parts(archive)
        report['expected_slide_count'] = len(spec['slides'])
        report['actual_slide_count'] = len(parts)
        if len(parts) != len(spec['slides']):
            report['errors'].append({'code': 'SLIDE_COUNT'})
        seen_layouts = set()
        for index, (slide, part) in enumerate(zip(spec['slides'], parts), 1):
            root = read_xml(archive, part)
            if root.tag != '{%s}sld' % NS['p']:
                raise ValueError('slide relationship targets a non-slide XML part')
            expected = formulas[index - 1]
            actual = len(root.findall('.//m:oMath', NS))
            title = heading(slide)
            text = ''.join(node.text or '' for node in root.findall('.//a:t', NS))
            title_present = normalized(title) in normalized(text) if title else None
            errors = []
            if actual != len(expected):
                errors.append('FORMULA_COUNT')
            if title_present is False:
                errors.append('TITLE_MISSING')
            for code in errors:
                report['errors'].append({'slide': index, 'code': code})
            crops = []
            for picture_index, picture in enumerate(root.findall('.//p:pic', NS), 1):
                for rect in picture.findall('.//a:srcRect', NS):
                    sides = {side: int(rect.get(side, '0')) for side in ('l', 't', 'r', 'b')}
                    if any(value > 0 for value in sides.values()):
                        crops.append({'picture': picture_index, 'crop_100000ths': sides})
            if crops:
                report['warnings'].append({'slide': index, 'code': 'PICTURE_CROP',
                                           'pictures': crops})
            reasons = []
            if index in (1, len(parts)):
                reasons.append('deck boundary')
            layout = slide['layout']
            if layout not in seen_layouts:
                reasons.append('layout sample: ' + layout)
                seen_layouts.add(layout)
            if expected or actual:
                reasons.append('equations')
            # Native pictures include icons/backgrounds; retain broad coverage
            # instead of pretending to classify semantic diagrams from XML.
            if root.find('.//p:pic', NS) is not None:
                reasons.append('pictures (including decoration)')
            if root.find('.//c:chart', NS) is not None:
                reasons.append('native charts')
            if root.find('.//a:tbl', NS) is not None:
                reasons.append('native tables')
            if errors or crops:
                reasons.append('findings')
            report['slides'].append({'slide': index, 'part': part, 'layout': layout,
                                     'expected_formulas': expected, 'actual_omml_count': actual,
                                     'title_present': title_present})
            if reasons:
                report['review_slides'].append({'slide': index, 'reasons': reasons})
    if report['errors']:
        report['status'] = 'fail'
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('spec', type=Path, help='existing deck JSON spec')
    parser.add_argument('pptx', type=Path, help='final generated PPTX')
    args = parser.parse_args(argv)
    try:
        report = inspect(json.loads(args.spec.read_text(encoding='utf-8')), args.pptx)
    except (OSError, ValueError, KeyError, ET.ParseError, zipfile.BadZipFile,
            FormulaError, RuntimeError) as exc:
        report = {'status': 'error', 'errors': [{'code': 'INPUT_ERROR', 'message': str(exc)}],
                  'limits': LIMITS}
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return {'pass': 0, 'fail': 1, 'error': 2}[report['status']]


if __name__ == '__main__':
    sys.exit(main())
