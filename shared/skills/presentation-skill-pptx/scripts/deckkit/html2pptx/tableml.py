# -*- coding: utf-8 -*-
"""`tables.Table` → one native `p:graphicFrame/a:tbl`.

Everything is explicit, so the file looks the same whichever table style
PowerPoint has: the style is "No Style, No Grid", the first-row and banding
flags are off, every cell writes all four edges (`a:noFill` where CSS has no
border) and no fill. Text is one `a:p` per text box of the cell, with exact
line spacing and explicit breaks from the shared layout, just like text shapes.

Schema order that PowerPoint enforces inside `a:tcPr`: lnL, lnR, lnT, lnB,
then the fill. Out of order, the file opens with a repair prompt.
"""
from pptx.oxml.ns import qn
from pptx.util import Emu

from . import values as V
from . import tables as T
from .formula import MathRun
from .paint import TextStyle

NO_STYLE_NO_GRID = '{2D5ABB26-0587-4C30-8999-92F81FD0307C}'

_ALIGN = {'left': 'l', 'center': 'ctr', 'right': 'r', 'justify': 'just'}


def add_table(renderer, slide, table):
    """Write the table; return its graphic frame."""
    rows, cols = len(table.rows), len(table.columns)
    frame = slide.shapes.add_table(
        rows, cols, Emu(V.px_to_emu(table.x)), Emu(V.px_to_emu(table.y)),
        Emu(V.px_to_emu(table.width)), Emu(V.px_to_emu(table.height)))
    tbl = frame._element.graphic.graphicData.find(qn('a:tbl'))
    _plain_style(tbl)
    grid = frame.table
    for index, width in enumerate(table.columns):
        grid.columns[index].width = Emu(V.px_to_emu(width))
    for index, height in enumerate(table.rows):
        grid.rows[index].height = Emu(V.px_to_emu(height))
    for r, line in enumerate(table.cells):
        for c, cell in enumerate(line):
            target = grid.cell(r, c)
            _cell_properties(target._tc, cell)
            _cell_text(renderer, target, cell)
    return frame


def _plain_style(tbl):
    tblPr = tbl.find(qn('a:tblPr'))
    for name in list(tblPr.attrib):
        del tblPr.attrib[name]
    for old in tblPr.findall(qn('a:tableStyleId')):
        tblPr.remove(old)
    style = tblPr.makeelement(qn('a:tableStyleId'), {})
    style.text = NO_STYLE_NO_GRID
    tblPr.append(style)


def _cell_properties(tc, cell):
    tcPr = tc.get_or_add_tcPr()
    for child in list(tcPr):
        tcPr.remove(child)
    left, top, right, bottom = cell.margins
    tcPr.set('marL', str(V.px_to_emu(left)))
    tcPr.set('marR', str(V.px_to_emu(right)))
    tcPr.set('marT', str(V.px_to_emu(top)))
    tcPr.set('marB', str(V.px_to_emu(bottom)))
    tcPr.set('anchor', cell.anchor)
    for tag, edge in (('a:lnL', None), ('a:lnR', None),
                      ('a:lnT', cell.top), ('a:lnB', cell.bottom)):
        tcPr.append(_line(tcPr, tag, edge))
    tcPr.append(tcPr.makeelement(qn('a:noFill'), {}))


def _line(parent, tag, edge):
    if edge is None:
        node = parent.makeelement(qn(tag), {'w': '12700', 'cmpd': 'sng'})
        node.append(node.makeelement(qn('a:noFill'), {}))
        return node
    node = parent.makeelement(qn(tag), {
        'w': str(V.px_to_emu(edge.width)), 'cap': 'flat', 'cmpd': 'sng',
        'algn': 'ctr'})
    fill = node.makeelement(qn('a:solidFill'), {})
    colour = fill.makeelement(qn('a:srgbClr'), {'val': V.to_hex(edge.rgba)})
    if edge.rgba[3] < 1:
        colour.append(colour.makeelement(
            qn('a:alpha'), {'val': str(int(round(edge.rgba[3] * 100000)))}))
    fill.append(colour)
    node.append(fill)
    node.append(node.makeelement(qn('a:prstDash'), {'val': 'solid'}))
    return node


def _cell_text(renderer, target, cell):
    txBody = target.text_frame._txBody
    bodyPr = txBody.find(qn('a:bodyPr'))
    bodyPr.set('wrap', 'none')
    for p in txBody.findall(qn('a:p')):
        txBody.remove(p)
    content_left = cell.box.x + cell.margins[0]
    if not cell.paragraphs:
        txBody.append(txBody.makeelement(qn('a:p'), {}))
        return
    for paragraph in cell.paragraphs:
        box = paragraph.box
        style = TextStyle(box)
        p = txBody.makeelement(qn('a:p'), {})
        txBody.append(p)
        pPr = p.makeelement(qn('a:pPr'), {
            'algn': _ALIGN.get(style.align, 'l')})
        p.append(pPr)
        indent_left = max(0.0, box.x + style.pad_left - content_left)
        if indent_left:
            pPr.set('marL', str(V.px_to_emu(indent_left)))
        line_height = style.line_heights[0] if style.line_heights \
            else style.line_height
        _spacing(pPr, 'a:lnSpc', line_height)
        _spacing(pPr, 'a:spcBef', paragraph.space_before)
        _spacing(pPr, 'a:spcAft', 0)
        pPr.append(pPr.makeelement(qn('a:buNone'), {}))
        for run in T.text_of(box):
            if run is None:
                p.append(p.makeelement(qn('a:br'), {}))
                continue
            if isinstance(run, MathRun):
                raise ValueError('formulas are not supported in table cells')
            r = p.makeelement(qn('a:r'), {})
            p.append(r)
            rPr = r.makeelement(qn('a:rPr'), {'lang': 'ru-RU', 'dirty': '0'})
            r.append(rPr)
            text = r.makeelement(qn('a:t'), {})
            text.text = run.text
            r.append(text)
            face, bold = renderer.fonts.face(style.family, run.weight)
            _run_properties(rPr, face, style.size, bold, style.rgba)
        end = p.makeelement(qn('a:endParaRPr'), {'lang': 'ru-RU', 'dirty': '0'})
        face, bold = renderer.fonts.face(style.family, style.weight)
        _run_properties(end, face, style.size, bold, style.rgba)
        p.append(end)


def _spacing(pPr, tag, px):
    node = pPr.makeelement(qn(tag), {})
    node.append(node.makeelement(qn('a:spcPts'), {
        'val': str(int(round(V.px_to_pt(px) * 100)))}))
    pPr.append(node)


def _run_properties(rPr, face, size_px, bold, rgba):
    rPr.set('sz', str(int(round(V.px_to_pt(size_px) * 100))))
    rPr.set('b', '1' if bold else '0')
    fill = rPr.makeelement(qn('a:solidFill'), {})
    colour = fill.makeelement(qn('a:srgbClr'), {'val': V.to_hex(rgba)})
    if rgba[3] < 1:
        colour.append(colour.makeelement(
            qn('a:alpha'), {'val': str(int(round(rgba[3] * 100000)))}))
    fill.append(colour)
    rPr.append(fill)
    for tag in ('a:latin', 'a:ea', 'a:cs'):
        rPr.append(rPr.makeelement(qn(tag), {'typeface': face}))
