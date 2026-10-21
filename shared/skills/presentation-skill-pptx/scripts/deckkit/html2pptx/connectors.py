"""Editable connector geometry shared by the native and pixel adapters.

The engine markup is an empty box with ``data-connector="arc"``. Its start
and end attributes are clockwise degrees in the box's ellipse. CSS supplies
the pen and line-end properties; no presentation-specific dimensions live
here. This draws directly in both adapters, without cached raster assets.
"""
import math

from . import values as V


class Arc(object):
    def __init__(self, box):
        element, style = box.el, box.style
        self.start = float(element.get('data-connector-start', '0'))
        self.end = float(element.get('data-connector-end', '90'))
        if not math.isfinite(self.start) or not math.isfinite(self.end):
            raise ValueError('connector angles must be finite')
        self.start %= 360
        self.end %= 360
        self.flip_h = element.get('data-connector-flip-h') == 'true'
        self.flip_v = element.get('data-connector-flip-v') == 'true'
        self.rgba = V.color(style.get('--connector-color')) or (0, 0, 0, 1.0)
        self.width = V.length(style.get('--connector-width'), default=1.0)
        self.width = 1.0 if self.width is None else self.width
        if not math.isfinite(self.width) or self.width <= 0:
            raise ValueError('connector width must be a positive length')
        self.head = style.get('--connector-head', 'none').strip()
        self.head_width = style.get('--connector-head-width', 'med').strip()
        self.head_length = style.get('--connector-head-length', 'med').strip()
        if self.head not in ('none', 'arrow', 'triangle'):
            raise ValueError('unsupported connector head %r' % self.head)
        if self.head_width not in ('sm', 'med', 'lg') \
                or self.head_length not in ('sm', 'med', 'lg'):
            raise ValueError('connector head dimensions must be sm, med or lg')

    def points(self, width, height):
        """Sample the same arc preset, with its local flips applied."""
        sweep = (self.end - self.start) % 360
        count = max(2, int(math.ceil(math.radians(sweep)
                                     * max(width, height))))
        points = []
        for step in range(count + 1):
            angle = math.radians(self.start + sweep * step / count)
            # DrawingML angles are rays from the ellipse's centre. Convert
            # their intersection with the ellipse, rather than treating the
            # ray angle as the ellipse's parametric angle (squares coincide).
            rx, ry = width / 2.0, height / 2.0
            cosine, sine = math.cos(angle), math.sin(angle)
            divisor = math.hypot(ry * cosine, rx * sine)
            reach = rx * ry / divisor if divisor else 0
            x, y = rx + reach * cosine, ry + reach * sine
            points.append((width - x if self.flip_h else x,
                           height - y if self.flip_v else y))
        return points

    def head_dimensions(self):
        """DrawingML line-end sizes in pen widths, for the pixel adapter."""
        factors = {'sm': 2.0, 'med': 3.0, 'lg': 5.0}
        return (self.width * factors[self.head_width],
                self.width * factors[self.head_length])


def read(box):
    value = box.el.get('data-connector') if box.el is not None else None
    if not value:
        return None
    if value != 'arc':
        raise ValueError('unsupported connector geometry %r' % value)
    return Arc(box)
