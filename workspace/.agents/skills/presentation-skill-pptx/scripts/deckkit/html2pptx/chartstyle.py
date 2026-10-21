# -*- coding: utf-8 -*-
"""A `chartgeom.Geometry` turned into a native, editable PowerPoint chart.

The chart stays a real `c:chart` with its data in an embedded workbook: the
author opens it in PowerPoint, edits the numbers and the chart redraws. That
was the decision for v2.0 (PROGRESS, "Decisions taken with the author"), and
it sets what this module may do — style the chart PowerPoint draws, never
replace it with shapes of our own.

Everything a chart carries that the layout also needs to align with — the
chart title, the legend — is drawn by the layout as ordinary boxes, and the
native legend is off. The native title is off too, except on a doughnut with
a centre figure: since 2.3.0 that figure is the title, linked to a cell of
the workbook, so an edit in Excel reaches it (`_center_title`).

An author who edits the data in Excel and adds a row or a column gets a
chart that grows with it and stays in style (2.3.0, `_ChartData`,
`_theme_override`, `_group_labels`): the data is an Excel table, so the
chart's ranges follow a new row; a new series takes the next colour of our
palette from the chart's own theme override, not the deck theme's accent;
and it takes the font, format and position of the labels the others carry. What makes those
boxes line up with the plot is `pin_plot_area`: `c:manualLayout` with
`layoutTarget inner` fixes the plot rectangle to the one `chartgeom`
computed, instead of wherever PowerPoint would have put it.

The python-pptx API is used wherever it reaches (fills, gap width, overlap,
data labels, axis scale, fonts). Direct XML only where it does not: the
manual layout, colour alpha on the gridlines, `c:holeSize`, the round line
cap. Every one of those edits inserts in the schema's child order — a child
out of order is not ignored by PowerPoint, it is "found a problem with
content". The orders are listed in PROGRESS, stage 0, read off python-pptx's
own `_tag_seq`.
"""
import copy

from lxml import etree
from pptx.chart.data import CategoryChartData
from pptx.chart.xlsx import CategoryWorkbookWriter
from pptx.opc.constants import RELATIONSHIP_TYPE as RT
from pptx.opc.package import Part
from pptx.text.text import Font
from pptx.dml.color import RGBColor
from pptx.enum.chart import (XL_CHART_TYPE, XL_LABEL_POSITION,
                             XL_MARKER_STYLE, XL_TICK_LABEL_POSITION,
                             XL_TICK_MARK)
from pptx.oxml.ns import qn
from pptx.util import Emu, Pt

from . import chartgeom as G
from . import values as V
from .textmeasure import DEFAULT_FAMILY

XL_TYPES = {
    'line': XL_CHART_TYPE.LINE,
    'bar': XL_CHART_TYPE.COLUMN_CLUSTERED,
    'stacked': XL_CHART_TYPE.COLUMN_STACKED,
    'bar_h': XL_CHART_TYPE.BAR_CLUSTERED,
    'doughnut': XL_CHART_TYPE.DOUGHNUT,
}

_FAMILY = DEFAULT_FAMILY


# The header over the category column: an Excel table wants every column
# named, and python-pptx leaves A1 blank.
CATEGORY_HEADER = 'Категория'
CENTER_HEADER = 'Центр'
TABLE_STYLE = 'Table Style Light 1'


class _Workbook(CategoryWorkbookWriter):
    """python-pptx's sheet, made an Excel table, plus the centre's cell.

    The table is what lets the chart grow: PowerPoint's data sheet extends
    a chart whose ranges are a table when a row or a column is typed next to
    it, and leaves plain ranges where they were. A doughnut's centre figure
    sits two columns right of the table, row 2, under its own header.
    """

    def __init__(self, chart_data, center):
        super(_Workbook, self).__init__(chart_data)
        self._center = center

    def center_ref(self):
        column = len(list(self._chart_data)) + 3
        return 'Sheet1!$%s$2' % self._column_reference(column)

    def _populate_worksheet(self, workbook, worksheet):
        super(_Workbook, self)._populate_worksheet(workbook, worksheet)
        names = [s.name for s in self._chart_data]
        headers = [CATEGORY_HEADER] + names
        # Table headers are unique and not blank; series that share a name
        # keep the plain ranges.
        if all(headers) and len(set(headers)) == len(headers):
            worksheet.add_table(0, 0, len(self._chart_data.categories),
                                len(names), {
                                    'columns': [{'header': h}
                                                for h in headers],
                                    'style': TABLE_STYLE,
                                    'autofilter': False})
        if self._center is not None:
            worksheet.write_string(0, len(names) + 2, CENTER_HEADER)
            worksheet.write_string(1, len(names) + 2, self._center)


class _ChartData(CategoryChartData):
    """CategoryChartData whose workbook is `_Workbook`."""

    def __init__(self, number_format, center=None):
        super(_ChartData, self).__init__(number_format=number_format)
        self._center = center

    @property
    def _workbook_writer(self):
        return _Workbook(self, self._center)


def chart_data(data, values, center=None):
    """The workbook behind the chart. Its cells carry the chart's format
    code (`chartgeom.ValueFormat.cells`): a label linked to them shows what
    Excel shows, and keeps it after an edit in Excel. `center` is a
    doughnut's centre figure, written into its own cell."""
    chart = _ChartData(values.cells, center)
    chart.categories = data.categories
    for series in data.series:
        chart.add_series(series.name, series.values)
    return chart


def add_chart(slide, geometry, data, colors, palette, fonts):
    """Add the chart to `slide` and style it. Returns the graphic frame."""
    kind = geometry.chart_type
    frame = geometry.frame
    center = geometry.center.text if geometry.center is not None else None
    source = chart_data(data, geometry.values or G.ValueFormat(data), center)
    graphic_frame = slide.shapes.add_chart(
        XL_TYPES[kind], Emu(V.px_to_emu(frame.x)), Emu(V.px_to_emu(frame.y)),
        Emu(V.px_to_emu(frame.w)), Emu(V.px_to_emu(frame.h)), source)
    chart = graphic_frame.chart
    chart.has_title = False
    chart.has_legend = False
    _base_font(chart, geometry, palette, fonts)
    pin_plot_area(chart, *geometry.plot_fraction)
    _theme_override(slide, graphic_frame, _next_colors(palette, kind, data,
                                                       colors))

    if kind == 'doughnut':
        _style_doughnut(chart, geometry, colors, palette, fonts)
        _point_labels_follow(chart)
        if center is not None:
            _center_title(chart, geometry, source._workbook_writer.center_ref(),
                          palette, fonts)
        _labels_on_one_line(chart)
        return graphic_frame
    _style_axes(chart, geometry, palette, fonts)
    plot = chart.plots[0]
    if kind == 'line':
        _style_lines(chart, colors, palette)
        _line_options(chart, geometry, colors, palette, fonts)
        _point_labels_follow(chart)
        _group_labels(plot)
        _labels_on_one_line(chart)
        return graphic_frame
    variant = G.bar_variant(kind, data)
    plot.gap_width = geometry.gap_width
    overlap = palette.axes.get('overlap', {}).get(variant)
    if geometry.overlap is not None:
        overlap = geometry.overlap
    if kind == 'stacked':
        plot.overlap = 100
    elif overlap is not None:
        plot.overlap = int(overlap)
    _style_bars(chart, geometry, colors, palette, fonts)
    _point_labels_follow(chart)
    _group_labels(plot)
    _labels_on_one_line(chart)
    return graphic_frame


# ------------------------------------------------------------ Excel edits

_THEME_OVERRIDE_RT = ('http://schemas.openxmlformats.org/officeDocument/'
                      '2006/relationships/themeOverride')
_THEME_OVERRIDE_CT = ('application/vnd.openxmlformats-officedocument.'
                      'themeOverride+xml')
_A = 'http://schemas.openxmlformats.org/drawingml/2006/main'


def _next_colors(palette, kind, data, colors):
    """Accents 1-6 for a chart's theme override: slot k is series k's
    colour in a chart of max(n, k + 1) series (a doughnut: slices), so the
    slot of a series added in Excel holds the colour that series would have
    had, and so does the slot of a second one. None for a chart painted by
    sign, whose colours follow no order."""
    if kind == 'doughnut':
        table, count = 'categorical', len(data.categories)
    elif 'points' in colors:
        return None
    else:
        table = 'categorical' if kind == 'line' else 'stacked'
        count = len(data.series)
    limit = palette.limit(table)
    colors = []
    for index in range(6):
        row_count = min(max(count, index + 1), limit)
        row = (palette.table(table, row_count) if kind == 'doughnut'
               else palette.series_colors(kind, row_count))
        colors.append(row[min(index, len(row) - 1)])
    return colors


def _theme_override(slide, graphic_frame, accents):
    """A `themeOverride` part on the chart with `accents` as accent 1-6.

    PowerPoint colours a series that has no fill of its own - one added in
    Excel - with the theme accent of its index, and the deck theme's accents
    are the slide colours (yellow, then dark grey). The override is the
    chart's own copy of the theme: same fonts and effects, our palette in
    the accents, the slides untouched.
    """
    if not accents:
        return
    master = slide.part.slide_layout.slide_master.part
    theme = etree.fromstring(master.part_related_by(RT.THEME).blob)
    elements = theme.find(qn('a:themeElements'))
    override = etree.Element(qn('a:themeOverride'), nsmap={'a': _A})
    for name in ('a:clrScheme', 'a:fontScheme', 'a:fmtScheme'):
        override.append(copy.deepcopy(elements.find(qn(name))))
    scheme = override.find(qn('a:clrScheme'))
    for index, hex_ in enumerate(accents[:6]):
        slot = scheme.find(qn('a:accent%d' % (index + 1)))
        for child in list(slot):
            slot.remove(child)
        etree.SubElement(slot, qn('a:srgbClr')).set('val', hex_.upper())
    chart_part = graphic_frame.chart_part
    package = chart_part.package
    part = Part(package.next_partname('/ppt/theme/themeOverride%d.xml'),
                _THEME_OVERRIDE_CT, package,
                etree.tostring(override, xml_declaration=True,
                               encoding='UTF-8', standalone=True))
    chart_part.relate_to(part, _THEME_OVERRIDE_RT)


def _group_labels(plot):
    """Plot-level `c:dLbls`, a copy of the first series' labels, when every
    series shows its values.

    A series without labels of its own takes the plot's: one added in Excel
    then comes out labelled like the rest, in our font and format, instead
    of bare. A chart where some series go unlabelled gets none - the plot's
    labels would switch those on; so does a labelled line chart, whose halo
    series (`_line_options`) carry no labels.
    """
    element = plot._element
    series = element.findall(qn('c:ser'))
    own = [s.find(qn('c:dLbls')) for s in series]
    if not own or any(d is None or d.find(qn('c:showVal')) is None
                      or d.find(qn('c:showVal')).get('val') not in ('1', 'true')
                      for d in own):
        return
    group = copy.deepcopy(own[0])
    for point in group.findall(qn('c:dLbl')):
        group.remove(point)
    old = element.find(qn('c:dLbls'))
    if old is not None:
        element.remove(old)
    # CT_BarChart and CT_LineChart alike: `c:dLbls` right after the series.
    series[-1].addnext(group)


def _center_title(chart, geometry, ref, palette, fonts):
    """A doughnut's centre figure: the chart title, its text the workbook
    cell `ref` (`c:strRef`), laid over the plot at the ring's centre.

    The title box is as large as its text and `c:manualLayout` places its
    top-left corner, so the corner is the centre less half the measured
    figure. CT_Title order: tx, layout, overlay, spPr, txPr.
    """
    label = geometry.center
    width, height = geometry.center_size
    frame = geometry.frame
    chart.has_title = True
    # python-pptx leaves the `autoTitleDeleted` that has_title = False set.
    chart._chartSpace.chart.get_or_add_autoTitleDeleted().val = False
    title = chart._chartSpace.chart.find(qn('c:title'))
    for child in list(title):
        title.remove(child)
    tx = etree.SubElement(title, qn('c:tx'))
    str_ref = etree.SubElement(tx, qn('c:strRef'))
    etree.SubElement(str_ref, qn('c:f')).text = ref
    cache = etree.SubElement(str_ref, qn('c:strCache'))
    etree.SubElement(cache, qn('c:ptCount')).set('val', '1')
    point = etree.SubElement(cache, qn('c:pt'))
    point.set('idx', '0')
    etree.SubElement(point, qn('c:v')).text = label.text
    manual = etree.SubElement(etree.SubElement(title, qn('c:layout')),
                              qn('c:manualLayout'))
    etree.SubElement(manual, qn('c:xMode')).set('val', 'edge')
    etree.SubElement(manual, qn('c:yMode')).set('val', 'edge')
    x = (label.x - width / 2.0 - frame.x) / frame.w
    y = (label.y - height / 2.0 - frame.y) / frame.h
    etree.SubElement(manual, qn('c:x')).set('val', '%.6f' % x)
    etree.SubElement(manual, qn('c:y')).set('val', '%.6f' % y)
    etree.SubElement(title, qn('c:overlay')).set('val', '1')
    tx_pr = etree.SubElement(title, qn('c:txPr'))
    body = etree.SubElement(tx_pr, qn('a:bodyPr'))
    body.set('wrap', 'none')
    body.set('anchor', 'ctr')
    etree.SubElement(tx_pr, qn('a:lstStyle'))
    p_pr = etree.SubElement(etree.SubElement(tx_pr, qn('a:p')), qn('a:pPr'))
    default = etree.SubElement(p_pr, qn('a:defRPr'))
    _set_font(Font(default), fonts, palette.type['doughnut_center'],
              label.color)


# ------------------------------------------------------------------ pieces


def _px_pt(px):
    return Pt(V.px_to_pt(px))


def _face(fonts, weight):
    """(typeface, bold) for a T-Sans weight — the face name, not `bold`, is
    what carries Medium into PPTX; see AGENTS.md on face names."""
    return fonts.face(_FAMILY, weight)


def _set_font(font, fonts, style, color=None):
    name, bold = _face(fonts, style['weight'])
    font.name = name
    font.bold = bold
    font.size = _px_pt(style['size'])
    font.color.rgb = RGBColor.from_string(color or style.get('color', '333333'))


def _base_font(chart, geometry, palette, fonts):
    """The chart-wide default in `c:chartSpace/c:txPr`.

    Every text part without its own `txPr` inherits this, so a part we forget
    to style still comes out in T-Sans rather than Calibri — the hole the
    extended font gate in selftest exists to catch.
    """
    _set_font(chart.font, fonts, palette.type[geometry.tick_role])


def _alpha(color_parent, alpha):
    """Add `a:alpha` to the `a:srgbClr` under `color_parent`.

    python-pptx has no alpha on a colour. The element goes inside the
    `srgbClr`, as its child — it is a colour transform, not a sibling.
    """
    for clr in color_parent.iter(qn('a:srgbClr')):
        for old in clr.findall(qn('a:alpha')):
            clr.remove(old)
        node = etree.SubElement(clr, qn('a:alpha'))
        node.set('val', str(int(round(alpha * 100000))))


def _line(format_, hex_, width_px, alpha=1.0):
    line = format_.line
    line.color.rgb = RGBColor.from_string(hex_)
    line.width = Emu(V.px_to_emu(width_px))
    if alpha < 1.0:
        _alpha(line._get_or_add_ln(), alpha)
    return line


def _no_line(format_):
    format_.line.fill.background()


def _fill(format_, hex_, gradient=None):
    """A solid fill, or `gradient` (`Palette.gradient`) written as XML:
    python-pptx gives two stops and mirrors the angle."""
    if gradient is None:
        format_.fill.solid()
        format_.fill.fore_color.rgb = RGBColor.from_string(hex_)
        return
    format_.fill.gradient()
    grad = format_.fill._xPr.find(qn('a:gradFill'))
    for child in list(grad):
        grad.remove(child)
    stops, angle = gradient
    gs_lst = etree.SubElement(grad, qn('a:gsLst'))
    for position, color in stops:
        gs = etree.SubElement(gs_lst, qn('a:gs'),
                              pos=str(int(round(position * 100000))))
        etree.SubElement(gs, qn('a:srgbClr'), val=color)
    etree.SubElement(grad, qn('a:lin'),
                     ang=str(int(round(angle * 60000)) % 21600000),
                     scaled='0')


def pin_plot_area(chart, x, y, w, h):
    """Fix the inner plot rectangle with `c:plotArea/c:layout/c:manualLayout`.

    Fractions of the chart frame. `layoutTarget inner` means the rectangle is
    the plot itself, tick labels outside it; `edge` modes mean `x`/`y` are
    positions, not offsets from PowerPoint's own choice.

    Doughnut plots arrive with an empty `c:layout`; bar and line plots
    arrive with none at all (stage 0, `chart_probe.py dump`). It is
    `c:plotArea`'s first child either way.
    """
    plot_area = chart._chartSpace.find(qn('c:chart')).find(qn('c:plotArea'))
    layout = plot_area.find(qn('c:layout'))
    if layout is None:
        layout = etree.Element(qn('c:layout'))
        plot_area.insert(0, layout)
    for child in list(layout):
        layout.remove(child)
    manual = etree.SubElement(layout, qn('c:manualLayout'))
    for tag, value in (('c:layoutTarget', 'inner'), ('c:xMode', 'edge'),
                       ('c:yMode', 'edge')):
        etree.SubElement(manual, qn(tag)).set('val', value)
    for tag, value in (('c:x', x), ('c:y', y), ('c:w', w), ('c:h', h)):
        etree.SubElement(manual, qn(tag)).set('val', '%.6f' % value)
    return manual


def _style_axes(chart, geometry, palette, fonts):
    """Value axis on the line chart only; category axis always.

    The value axis' scale is written even where the axis is hidden: the bars
    must stand at the heights `chartgeom` computed, and a hidden axis left on
    auto would pick its own maximum.
    """
    axes = palette.axes
    tick = palette.type[geometry.tick_role]
    value_axis = chart.value_axis
    scale = geometry.scale
    value_axis.minimum_scale = scale.minimum
    value_axis.maximum_scale = scale.maximum
    value_axis.major_unit = scale.step
    value_axis.major_tick_mark = XL_TICK_MARK.NONE
    value_axis.minor_tick_mark = XL_TICK_MARK.NONE
    _no_line(value_axis.format)
    if geometry.value_axis:
        value_axis.has_major_gridlines = True
        _line(value_axis.major_gridlines.format, axes['grid_color'],
              axes['grid_weight_px'], axes['grid_alpha'])
        # The ticks' own code (chartgeom.ValueFormat.ticks): the source
        # format less the zeros every tick shares, so not linked.
        value_axis.tick_labels.number_format = geometry.tick_code
        value_axis.tick_labels.number_format_is_linked = False
        _set_font(value_axis.tick_labels.font, fonts, tick)
    else:
        value_axis.has_major_gridlines = False
        value_axis.visible = False

    category_axis = chart.category_axis
    category_axis.major_tick_mark = XL_TICK_MARK.NONE
    category_axis.minor_tick_mark = XL_TICK_MARK.NONE
    category_axis.has_major_gridlines = False
    _set_font(category_axis.tick_labels.font, fonts, tick)
    # Horizontal names, wrapped at spaces, as chartgeom reserved room for.
    # Left on auto, PowerPoint turned names that did not fit their column 45°
    # and cut them to «Д…» (v2.1.0 stress test, slides 43 and 79). `rot` is
    # in 60000ths of a degree; the default -60000000 means "auto".
    body = category_axis._element.find(qn('c:txPr')).find(qn('a:bodyPr'))
    body.set('rot', '0')
    body.set('vert', 'horz')
    # Category names under the plot, where chartgeom put them - not at the
    # zero line, which is PowerPoint's default and printed "Мар" across a
    # negative bar (iteration 2, slide 30). The axis line stays at zero.
    category_axis.tick_label_position = XL_TICK_LABEL_POSITION.LOW
    if geometry.chart_type == 'bar_h':
        # First category at the top, as the reader reads a list.
        category_axis.reverse_order = True
    baseline = (any(is_base for _, is_base in geometry.gridlines)
                or geometry.zero_x is not None)
    if baseline:
        _line(category_axis.format, axes['grid_color'], axes['grid_weight_px'],
              axes['baseline_alpha'])
    else:
        _no_line(category_axis.format)


def _style_lines(chart, colors, palette):
    width = palette.line_px
    for index, series in enumerate(chart.plots[0].series):
        series.smooth = False
        series.marker.style = XL_MARKER_STYLE.NONE
        _line(series.format, colors['series'][index], width)
        # Round caps and joins, as the design draws them; python-pptx has
        # neither. `cap` is an attribute of `a:ln`, `a:round` a child that
        # goes after the fill.
        ln = series.format.line._get_or_add_ln()
        ln.set('cap', 'rnd')
        if ln.find(qn('a:round')) is None:
            fill = ln.find(qn('a:solidFill'))
            join = etree.Element(qn('a:round'))
            if fill is not None:
                fill.addnext(join)
            else:
                ln.append(join)


def _line_options(chart, geometry, colors, palette, fonts):
    """Value labels with a dot in a halo, or areas — what `chartgeom` laid
    out from a line chart's `LineOptions`. Nothing, for a chart without them.

    The halo is a second, "shadow" series under each ringed one: the same
    cells, no line, a larger marker at 30 % — the dot of the real series is
    drawn on top of it. It is native, so it follows the plot when the author
    edits the numbers; ovals laid over the chart came apart from it in
    PowerPoint (tmp_files/linear-graphs-feature, halo-3-overlay.pptx).
    An area is its series moved into a `c:areaChart` ahead of the lines,
    sharing their axes, so every line is drawn over every area.
    """
    labels = dict((l.index, l) for l in geometry.labels
                  if l.role in ('data_label', 'data_label_dense')
                  and l.index is not None)
    if not (labels or geometry.markers or geometry.areas):
        return
    line = palette.data['line']
    plot = chart.plots[0]
    series = list(plot.series)
    # c:size is whole points; half a point goes up (14 px = 10.5 pt -> 11).
    dot = int(V.px_to_pt(line['marker_px']) + 0.5)
    halo = int(V.px_to_pt(line['halo_px']) + 0.5)

    for s_index, points in sorted(geometry.markers.items()):
        _ring(series[s_index], points, dot, colors['series'][s_index])
    for s_index, ser in enumerate(series):
        mine = sorted(k for k in labels if k[0] == s_index)
        if not mine:
            continue
        first = labels[mine[0]]
        style = palette.type[first.role]
        data_labels = ser.data_labels
        _label_format(data_labels, geometry)
        data_labels.show_value = True
        # Of two lines, the lower point's label hangs under it (chartgeom's
        # anchor 'ct'): the series takes the more common side, a point on the
        # other side gets its own c:dLbl.
        below = set(k for k in mine if labels[k].anchor == 'ct')
        series_below = len(below) * 2 > len(mine)
        data_labels.position = _LINE_POSITION[series_below]
        _set_font(data_labels.font, fonts, style, first.color)
        wanted = set(c for _, c in mine)
        for c_index in range(len(ser.values)):
            if c_index not in wanted:
                _hide_point_label(ser, c_index)
            elif ((s_index, c_index) in below) != series_below:
                dl = ser.points[c_index].data_label
                dl.position = _LINE_POSITION[not series_below]
                _set_font(dl.font, fonts, style, first.color)
                dl.show_value = True

    line_chart = plot._element
    reals = line_chart.findall(qn('c:ser'))
    for s_index in sorted(geometry.markers):
        shadow = copy.deepcopy(reals[s_index])
        for dlbls in shadow.findall(qn('c:dLbls')):
            shadow.remove(dlbls)
        _no_stroke(shadow.find(qn('c:spPr')))
        for marker in shadow.iter(qn('c:marker')):
            size = marker.find(qn('c:size'))
            if size is not None:
                size.set('val', str(halo))
            _alpha(marker, line['halo_alpha'])
        reals[0].addprevious(shadow)

    if geometry.areas:
        area_chart = etree.Element(qn('c:areaChart'))
        etree.SubElement(area_chart, qn('c:grouping')).set('val', 'standard')
        etree.SubElement(area_chart, qn('c:varyColors')).set('val', '0')
        for s_index, _, hex_ in geometry.areas:
            ser = reals[s_index]
            # CT_AreaSer has no marker and no smooth: left in, PowerPoint
            # reports the file as damaged.
            for tag in ('c:marker', 'c:smooth', 'c:dPt', 'c:dLbls', 'c:spPr'):
                for child in ser.findall(qn(tag)):
                    ser.remove(child)
            sp_pr = etree.Element(qn('c:spPr'))
            fill = etree.SubElement(sp_pr, qn('a:solidFill'))
            etree.SubElement(fill, qn('a:srgbClr')).set('val', hex_)
            _no_stroke(sp_pr)
            ser.find(qn('c:tx')).addnext(sp_pr)
            area_chart.append(ser)
        for ax_id in line_chart.findall(qn('c:axId')):
            area_chart.append(copy.deepcopy(ax_id))
        line_chart.addprevious(area_chart)
        if line_chart.find(qn('c:ser')) is None:
            line_chart.getparent().remove(line_chart)

    # Series numbers run through the chart in drawing order: areas, halos,
    # lines. `c:idx` must be unique across every plot of the chart.
    plot_area = chart._chartSpace.find(qn('c:chart')).find(qn('c:plotArea'))
    for number, ser in enumerate(plot_area.iter(qn('c:ser'))):
        ser.find(qn('c:idx')).set('val', str(number))
        ser.find(qn('c:order')).set('val', str(number))

    if geometry.edge:
        _cross_between(plot_area, 'midCat')
    if geometry.drop_lines and line_chart.getparent() is not None:
        axes = palette.axes
        drop = etree.Element(qn('c:dropLines'))
        sp_pr = etree.SubElement(drop, qn('c:spPr'))
        ln = etree.SubElement(sp_pr, qn('a:ln'))
        ln.set('w', str(V.px_to_emu(axes['grid_weight_px'])))
        fill = etree.SubElement(ln, qn('a:solidFill'))
        etree.SubElement(fill, qn('a:srgbClr')).set('val', axes['grid_color'])
        _alpha(ln, axes['grid_alpha'])
        # CT_LineChart: ser*, dLbls, dropLines, hiLowLines, upDownBars,
        # marker, smooth, axId.
        after = [c for c in line_chart
                 if c.tag in (qn('c:ser'), qn('c:dLbls'))]
        after[-1].addnext(drop)


# Whether a line's label is under its point -> where PowerPoint puts it.
_LINE_POSITION = {False: XL_LABEL_POSITION.ABOVE,
                  True: XL_LABEL_POSITION.BELOW}


def _ring(series, points, size, hex_):
    """A round marker of `size` pt in the line's colour on `points` — the
    whole series' marker when every point has one, else one `c:dPt` each."""
    if len(points) == len(series.values):
        markers = [series.marker]
    else:
        markers = [series.points[i].marker for i in points]
    for marker in markers:
        marker.style = XL_MARKER_STYLE.CIRCLE
        marker.size = size
        _fill(marker.format, hex_)
        _no_line(marker.format)


def _no_stroke(sp_pr):
    """`a:ln` with `a:noFill` in a `c:spPr`, replacing any line it had."""
    for ln in sp_pr.findall(qn('a:ln')):
        sp_pr.remove(ln)
    ln = etree.Element(qn('a:ln'))
    etree.SubElement(ln, qn('a:noFill'))
    # CT_ShapeProperties: xfrm, geometry, fill, ln, effects...
    fills = [c for c in sp_pr if c.tag in (qn('a:noFill'), qn('a:solidFill'),
                                           qn('a:gradFill'), qn('a:pattFill'))]
    if fills:
        fills[-1].addnext(ln)
    else:
        sp_pr.insert(0, ln)


def _cross_between(plot_area, value):
    """`c:valAx/c:crossBetween`: `midCat` puts the first and last category
    on the plot's edges, as an area chart has them; the line chart's default
    is `between`, mid-column. In CT_ValAx it follows crossAx and crosses."""
    for axis in plot_area.findall(qn('c:valAx')):
        node = axis.find(qn('c:crossBetween'))
        if node is None:
            node = etree.Element(qn('c:crossBetween'))
            anchor = [c for c in axis if c.tag in (
                qn('c:crossAx'), qn('c:crosses'), qn('c:crossesAt'))]
            anchor[-1].addnext(node)
        node.set('val', value)


_POSITION = {
    # (chart type, inside) -> where PowerPoint puts the label
    ('stacked', True): XL_LABEL_POSITION.CENTER,
    ('bar', True): XL_LABEL_POSITION.INSIDE_END,
    ('bar', False): XL_LABEL_POSITION.OUTSIDE_END,
    ('bar_h', True): XL_LABEL_POSITION.INSIDE_END,
    ('bar_h', False): XL_LABEL_POSITION.OUTSIDE_END,
}


def _style_bars(chart, geometry, colors, palette, fonts):
    """Fills and data labels, per series and — where they differ — per point.

    The series-level label settings follow the most common case among its
    points; a point whose label `chartgeom` moved (a bar too short to hold
    it inside) gets its own `c:dLbl` with a different position and colour.
    """
    kind = geometry.chart_type
    # The label size is chartgeom's call (a dense stack labels smaller), read
    # off the labels' role so the file and the preview cannot disagree.
    labels = {}
    for label in geometry.labels:
        if label.role in ('data_label', 'data_label_dense') \
                and label.index is not None:
            labels[label.index] = label
    for s_index, series in enumerate(chart.plots[0].series):
        series.invert_if_negative = False
        _no_line(series.format)
        if 'series' in colors:
            hex_ = colors['series'][s_index]
            _fill(series.format, hex_, palette.gradient(kind, hex_))
        else:
            # Value mode: each point carries its sign's colour. A negative
            # point came out transparent in desktop PowerPoint (iteration 2,
            # slides 9 and 22): a `c:dPt` without its own `invertIfNegative`
            # is inverted whatever the series says, and an inverted solid
            # fill is drawn as none. Excel writes the flag on every point, so
            # do we; the series fill is the base for any point left unstyled.
            _fill(series.format, colors['points'][0])
            for c_index, hex_ in enumerate(colors['points']):
                point = series.points[c_index]
                _fill(point.format, hex_)
                _no_line(point.format)
                _no_invert(point)

        mine = [labels[k] for k in sorted(labels) if k[0] == s_index]
        data_labels = series.data_labels
        _label_format(data_labels, geometry)
        data_labels.show_value = True
        if not mine:
            data_labels.show_value = False
            continue
        style = palette.type[mine[0].role]
        inside = sum(1 for l in mine if l.inside) * 2 >= len(mine)
        color = _most_common([l.color for l in mine if l.inside == inside])
        data_labels.position = _POSITION[(kind, inside)]
        _set_font(data_labels.font, fonts, style, color)
        for c_index in range(len(series.values)):
            point_label = labels.get((s_index, c_index))
            if point_label is None:
                # Stacked segments too thin for their value: no label at all,
                # rather than one printed over the neighbouring segment.
                _hide_point_label(series, c_index)
                continue
            if point_label.inside == inside and point_label.color == color:
                continue
            dl = series.points[c_index].data_label
            dl.position = _POSITION[(kind, point_label.inside)]
            _set_font(dl.font, fonts, style, point_label.color)
            dl.show_value = True


# What a label shows, in CT_DLbl order; and what comes after `c:numFmt`.
_SHOW = ('c:showLegendKey', 'c:showVal', 'c:showCatName', 'c:showSerName',
         'c:showPercent', 'c:showBubbleSize')
_AFTER_NUMFMT = ('c:spPr', 'c:txPr', 'c:dLblPos') + _SHOW


def _point_labels_follow(chart):
    """Every point's own `c:dLbl` shows what its series' `c:dLbls` show, in
    the series' number format.

    A point gets a label of its own for its colour or position, and
    python-pptx writes it from a template: showVal on, showPercent off, no
    numFmt. A doughnut's white percentage then printed the bare value
    («24», not «24%», 2.3.0 gate), and a point label could drop the cells'
    format. Its point DataLabel has no `show_percentage` to set - the
    assignment only made a Python attribute - so this is XML.
    """
    for dlbls in chart._chartSpace.xpath('.//c:ser/c:dLbls'):
        fmt = dlbls.find(qn('c:numFmt'))
        flags = dict((tag, dlbls.find(qn(tag))) for tag in _SHOW)
        for dlbl in dlbls.findall(qn('c:dLbl')):
            if dlbl.find(qn('c:delete')) is not None:
                continue
            old = dlbl.find(qn('c:numFmt'))
            if old is not None:
                dlbl.remove(old)
            if fmt is not None:
                after = [dlbl.find(qn(tag)) for tag in _AFTER_NUMFMT]
                after = [el for el in after if el is not None]
                if after:
                    after[0].addprevious(copy.deepcopy(fmt))
                else:
                    dlbl.append(copy.deepcopy(fmt))
            for tag, source in flags.items():
                mine = dlbl.find(qn(tag))
                if source is not None and mine is not None:
                    mine.set('val', source.get('val'))


def _labels_on_one_line(chart):
    """`wrap="none"` on every data label's text body, series and point level.

    PowerPoint sizes a data label's box itself and wraps inside it: a
    doughnut's «13%» came out as «13» over «%», and «27» lost its «%» below
    the ring (v2.1.0 stress test, slides 55, 74, 77). A value label is one
    number — it never has a reason to break.
    """
    space = chart._chartSpace
    for body in space.xpath('.//c:dLbls/c:txPr/a:bodyPr'
                            ' | .//c:dLbls/c:dLbl/c:txPr/a:bodyPr'):
        body.set('wrap', 'none')


def _no_invert(point):
    """`c:invertIfNegative val=0` on one `c:dPt`, right after its `c:idx`
    (CT_DPt order: idx, invertIfNegative, marker, bubble3D, explosion, spPr)."""
    dpt = point._ser.get_or_add_dPt_for_point(point._idx)
    flag = dpt.find(qn('c:invertIfNegative'))
    if flag is None:
        flag = etree.Element(qn('c:invertIfNegative'))
        dpt.find(qn('c:idx')).addnext(flag)
    flag.set('val', '0')


def _hide_point_label(series, index):
    """`c:dLbl` with `c:delete val=1` — the schema's way to drop one label."""
    dlbls = series._element.get_or_add_dLbls()
    for dlbl in dlbls.findall(qn('c:dLbl')):
        idx = dlbl.find(qn('c:idx'))
        if idx is not None and idx.get('val') == str(index):
            dlbls.remove(dlbl)
    dlbl = etree.Element(qn('c:dLbl'))
    etree.SubElement(dlbl, qn('c:idx')).set('val', str(index))
    etree.SubElement(dlbl, qn('c:delete')).set('val', '1')
    # `c:dLbl` children come first in `c:dLbls`, in `idx` order.
    before = [d for d in dlbls.findall(qn('c:dLbl'))
              if int(d.find(qn('c:idx')).get('val')) < index]
    if before:
        before[-1].addnext(dlbl)
    else:
        dlbls.insert(0, dlbl)


def _most_common(values):
    counts = {}
    for value in values:
        counts[value] = counts.get(value, 0) + 1
    return max(sorted(counts), key=lambda v: counts[v]) if counts else None


def _label_format(data_labels, geometry):
    """A chart with a `number_format` links its labels to the cells
    (`sourceLinked`): PowerPoint prints the cells' code, and an edit of the
    code in Excel carries over. Without one, `General`: each label as
    written, "2" beside "2,4" — chartgeom.format_number(trim=True), which
    the preview draws."""
    values = geometry.values
    if values is not None and values.linked:
        data_labels.number_format = values.cells
        data_labels.number_format_is_linked = True
    else:
        data_labels.number_format = 'General'
        data_labels.number_format_is_linked = False


def _style_doughnut(chart, geometry, colors, palette, fonts):
    """Slice fills, the hole, and percentages set inside the ring.

    Slices have no outline: the design butts them against each other, and
    PowerPoint's default is a white stroke between slices.
    """
    plot = chart.plots[0]
    doughnut = plot._element
    hole = doughnut.find(qn('c:holeSize'))
    if hole is None:
        hole = etree.SubElement(doughnut, qn('c:holeSize'))
    hole.set('val', str(palette.hole_percent))
    first = doughnut.find(qn('c:firstSliceAng'))
    if first is not None:
        first.set('val', str(int(palette.data['doughnut']['first_slice_angle'])))

    series = plot.series[0]
    by_point = dict((l.index[1], l) for l in geometry.labels
                    if l.role.startswith('doughnut_percent') and l.index)
    # One size for the ring (chartgeom._layout_doughnut picks it).
    style = palette.type[by_point[min(by_point)].role if by_point
                         else 'doughnut_percent']
    data_labels = series.data_labels
    data_labels.show_percentage = True
    data_labels.show_value = False
    data_labels.show_category_name = False
    data_labels.number_format = '0%'
    data_labels.number_format_is_linked = False
    # No `c:dLblPos`: a doughnut has no label positions (PowerPoint offers
    # none), its labels sit midway through the ring, where chartgeom measured
    # the arc. With `dLblPos val="ctr"`, added in 2.1.1, PowerPoint drew no
    # chart and exported the slide blank (v2.2.0 stress test, 8 slides).
    default_color = palette.text_on_light
    _set_font(data_labels.font, fonts, style, default_color)
    for index, hex_ in enumerate(colors['points']):
        point = series.points[index]
        _fill(point.format, hex_, palette.gradient('doughnut', hex_))
        _no_line(point.format)
        label = by_point.get(index)
        if label is None:
            _hide_point_label(series, index)
        elif label.color != default_color:
            # What it shows (the percentage, `0%`) comes from the series'
            # labels: `_point_labels_follow`.
            _set_font(point.data_label.font, fonts, style, label.color)
