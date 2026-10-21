"""Asset resolver: paths, SVG rasterization, cache.

Paths in HTML are relative, and different files have different ones:
    built presentation     →  <skill-dir>/assets/icons/...
    assets/layouts/*.html  →  ../icons/...
So we resolve relative to the input HTML directory and, if not found,
try several fallback roots — instead of failing.

There are 355 icons, and the marketplace rejects skills larger than 200 files,
so they do not sit loose but in `assets/icons/icons.zip`. The last search step
is to extract the needed member into the cache; see `_from_icon_archive`.
"""
import copy
import hashlib
import logging
import math
import os
import tempfile
import zipfile

from lxml import etree

from . import boxdeco
from .svgraster import rasterize

log = logging.getLogger(__name__)

# lxml.html lowercases tag and attribute names, but in SVG case matters:
# without `viewBox` the rasterizer takes the default size, and the logo draws
# in the corner at 40% scale while the list marker spreads into a solid square.
# Before rasterization we restore canonical names.
_SVG_CAMEL_NAMES = (
    'viewBox', 'preserveAspectRatio', 'clipPath', 'clipPathUnits',
    'linearGradient', 'radialGradient', 'gradientUnits', 'gradientTransform',
    'spreadMethod', 'patternUnits', 'patternContentUnits', 'patternTransform',
    'maskUnits', 'maskContentUnits', 'filterUnits', 'primitiveUnits',
    'feGaussianBlur', 'feOffset', 'feBlend', 'feFlood', 'feColorMatrix',
    'feComposite', 'feMerge', 'feMergeNode', 'feDropShadow', 'feImage',
    'stdDeviation', 'baseFrequency', 'numOctaves', 'foreignObject',
    'markerWidth', 'markerHeight', 'markerUnits', 'refX', 'refY',
    'startOffset', 'textPath', 'textLength', 'lengthAdjust',
)
_LOWER_TO_CAMEL = {name.lower(): name for name in _SVG_CAMEL_NAMES}


def restore_svg_case(element):
    """Copy of subtree with restored case for tag and attribute names."""
    node = copy.deepcopy(element)
    for el in node.iter():
        if not isinstance(el.tag, str):
            continue
        local = el.tag.split('}')[-1]
        canonical = _LOWER_TO_CAMEL.get(local.lower())
        if canonical and canonical != local:
            prefix = el.tag[:-len(local)]
            el.tag = prefix + canonical
        for key in list(el.attrib):
            attr_local = key.split('}')[-1]
            canonical_attr = _LOWER_TO_CAMEL.get(attr_local.lower())
            if canonical_attr and canonical_attr != attr_local:
                value = el.attrib.pop(key)
                el.set(key[:-len(attr_local)] + canonical_attr, value)
    return node

# Fallback roots if the path from HTML does not resolve directly.
_FALLBACK_ROOTS = ('.', '..', '../..')

# Icon archive and the name of the directory it sits next to.
_ICON_ARCHIVE = 'icons.zip'
_ICON_DIR = 'icons'


def _module_stamp(name):
    """Stamp of the drawing module for the cache key.

    The cache survives runs, and the key used to depend only on the SVG and size.
    So after editing the rasterizer the presentation assembled from a previously
    saved image, and the fix did not reach the file. We take the stamp from the
    file itself: it changes together with the drawing logic, so there is no need
    to remember about manually bumping the version.
    """
    module = os.path.join(os.path.dirname(os.path.abspath(__file__)), name)
    try:
        info = os.stat(module)
        return '%d-%d' % (int(info.st_mtime), info.st_size)
    except OSError:
        return 'unknown'


_RASTER_STAMP = _module_stamp('svgraster.py')
_DECO_STAMP = _module_stamp('boxdeco.py')


class AssetResolver:
    def __init__(self, base_dir, cache_dir, css_dirs=()):
        self.base_dir = os.path.abspath(base_dir)
        # Paths in url() inside CSS are relative to the CSS file itself, not HTML.
        # Styles sit in the skill, the presentation is anywhere, so without these
        # roots the background images (agenda, dark metrics background) are not found.
        self.css_dirs = [os.path.abspath(d) for d in css_dirs if d]
        self.cache_dir = cache_dir
        os.makedirs(cache_dir, exist_ok=True)
        self._missing = set()
        self._resolved = {}
        self._archives = {}

    # ------------------------------------------------------------ paths

    def resolve(self, url):
        """Relative path from HTML or CSS → absolute path on disk."""
        if not url or url.startswith(('data:', 'http://', 'https://')):
            return None
        cached = self._resolved.get(url)
        if cached is not None:
            return cached

        candidates = [os.path.normpath(os.path.join(self.base_dir, url))]
        candidates += [os.path.normpath(os.path.join(d, url))
                       for d in self.css_dirs]
        # Same path, but from fallback roots, and also without leading `../`.
        stripped = url.lstrip('./')
        while stripped.startswith('../'):
            stripped = stripped[3:]
        for root in _FALLBACK_ROOTS:
            candidates.append(os.path.normpath(
                os.path.join(self.base_dir, root, stripped)))
        for directory in self.css_dirs:
            candidates.append(os.path.normpath(os.path.join(directory, stripped)))

        for path in candidates:
            if os.path.isfile(path):
                self._resolved[url] = path
                return path

        # Not on disk — possibly an icon, and it sits in the archive.
        extracted = self._from_icon_archive(candidates)
        if extracted:
            self._resolved[url] = extracted
            return extracted

        if url not in self._missing:
            log.warning('[WARN] asset not found: %s (searched from %s)', url, self.base_dir)
            self._missing.add(url)
        return None

    @property
    def missing(self):
        return sorted(self._missing)

    # ------------------------------------------------------------ icon archive

    def _archive(self, path):
        """Member names and content identity, read once per resolver/path."""
        if path in self._archives:
            return self._archives[path]
        entry = None
        if os.path.isfile(path):
            try:
                with open(path, 'rb') as source:
                    digest = hashlib.sha256()
                    for chunk in iter(lambda: source.read(1024 * 1024), b''):
                        digest.update(chunk)
                    source.seek(0)
                    with zipfile.ZipFile(source) as archive:
                        names = set(n for n in archive.namelist()
                                    if not n.endswith('/'))
                entry = (names, digest.hexdigest())
            except (zipfile.BadZipFile, OSError):
                log.warning('[WARN] icon archive unreadable: %s', path)
        self._archives[path] = entry
        return entry

    def _from_icon_archive(self, candidates):
        """Extract one icon from `icons.zip` into the cache and return its path.

        Unpacking the whole set is unnecessary: a deck spends 5-30 icons out of 355.
        The archive's SHA-256 goes into the cache directory name. Different ZIP
        bytes cannot share stale extractions just because size and mtime agree;
        identical bytes can reuse them across paths. Identity is memoised for
        the resolver's lifetime; a new resolver observes archive replacements.
        """
        for candidate in candidates:
            directory, name = os.path.split(candidate)
            # Icons only: look for the archive next to the `icons` directory, not
            # next to every missing asset.
            if not name or os.path.basename(directory) != _ICON_DIR:
                continue
            archive_path = os.path.join(directory, _ICON_ARCHIVE)
            entry = self._archive(archive_path)
            if entry is None or name not in entry[0]:
                continue
            _names, stamp = entry

            out_dir = os.path.join(self.cache_dir, 'icons-%s' % stamp)
            out = os.path.join(out_dir, name)
            if os.path.isfile(out):
                return out
            partial = None
            try:
                os.makedirs(out_dir, exist_ok=True)
                with zipfile.ZipFile(archive_path) as archive:
                    data = archive.read(name)
                # Via a temporary file: otherwise a parallel run might see an
                # unfinished PNG and rasterize half the image.
                fd, partial = tempfile.mkstemp(suffix='.part', dir=out_dir)
                with os.fdopen(fd, 'wb') as f:
                    f.write(data)
                os.replace(partial, out)
            except (zipfile.BadZipFile, OSError, KeyError):
                log.warning('[WARN] failed to extract icon %s from %s',
                            name, archive_path)
                continue
            finally:
                if partial is not None and os.path.exists(partial):
                    os.unlink(partial)
            return out
        return None

    # ------------------------------------------------------------ images

    def image(self, url, width, height, opacity=1.0):
        """Path to PNG ready for embedding: SVG is rasterized, opacity is baked in."""
        path = self.resolve(url)
        if not path:
            return None
        if path.lower().endswith('.svg'):
            return self._raster_svg(path, width, height, opacity)
        path = self._orient_image(path)
        if opacity < 1.0:
            return self._bake_opacity(path, opacity)
        return path

    def for_box(self, box):
        """Image for a box: <img src> or inline <svg>."""
        if box.is_svg and box.src is not None:
            return self._raster_inline_svg(box.src, box.w, box.h)
        if isinstance(box.src, str):
            opacity = _float_or(box.style.get('opacity'), 1.0)
            return self.image(box.src, box.w, box.h, opacity)
        return None

    # ------------------------------------------------------------ rasterization

    def _raster_svg(self, path, width, height, opacity):
        w = max(1, int(round(width or 0))) or None
        h = max(1, int(round(height or 0))) or None
        key = 'svg-%s-%sx%s-o%.2f' % (_digest(path + str(os.path.getmtime(path))
                                              + _RASTER_STAMP),
                                      w, h, opacity)
        out = os.path.join(self.cache_dir, key + '.png')
        if os.path.exists(out):
            return out
        try:
            img = rasterize(path, out_width=w, out_height=h)
        except MemoryError:
            raise
        except Exception as exc:                            # noqa: BLE001
            log.error('[ERROR] failed to rasterize %s: %s', path, exc)
            return None
        img = _apply_opacity(img, opacity)
        img.save(out)
        log.info('[OK] SVG rasterized: %s → %dx%d', os.path.basename(path),
                 img.width, img.height)
        return out

    def _raster_inline_svg(self, svg_element, width, height):
        """Inline <svg> in HTML (logo, list marker)."""
        try:
            markup = etree.tostring(restore_svg_case(svg_element), encoding='unicode')
        except MemoryError:
            raise
        except Exception as exc:                            # noqa: BLE001
            log.warning('[WARN] failed to serialize inline svg: %s', exc)
            return None
        w = max(1, int(round(width or 0)))
        h = max(1, int(round(height or 0)))
        key = 'inline-%s-%sx%s' % (_digest(markup + _RASTER_STAMP), w, h)
        out = os.path.join(self.cache_dir, key + '.png')
        if os.path.exists(out):
            return out
        try:
            img = rasterize(markup, out_width=w, out_height=h)
        except MemoryError:
            raise
        except Exception as exc:                            # noqa: BLE001
            log.error('[ERROR] inline svg not rasterized: %s', exc)
            return None
        img.save(out)
        return out

    def inset_shadow(self, width, height, radius, shadows, outline=None):
        """PNG with box inner shadows — nothing to set them in PPTX (see boxdeco)."""
        path, _ = self._shadow(width, height, radius, shadows, inset=True,
                               outline=outline)
        return path

    def outer_shadow(self, width, height, radius, shadows):
        """PNG with outer shadows and margin in pixels on edges: `(path, pad)`."""
        return self._shadow(width, height, radius, shadows, inset=False)

    def _shadow(self, width, height, radius, shadows, inset, outline=None):
        signature = boxdeco.cache_key(shadows, inset)
        if not signature:
            return None, 0
        # Margin around edges is computed from the shadows themselves, so known
        # before rendering and there is no need to cache it.
        pad = 0 if inset else boxdeco.outer_pad(shadows)
        key = '%s-%s' % ('inset' if inset else 'outer', _digest('|'.join((
            _DECO_STAMP, '%.1fx%.1f' % (width, height), '%.1f' % radius, signature,
            outline.key if outline is not None else ''))))
        out = os.path.join(self.cache_dir, key + '.png')
        if os.path.exists(out):
            return out, pad

        if inset:
            layer = boxdeco.inset_shadow_layer(width, height, radius, shadows,
                                               outline=outline)
        else:
            made = boxdeco.outer_shadow_layer(width, height, radius, shadows)
            layer = made[0] if made else None
        if layer is None:
            return None, 0
        layer.save(out)
        return out, pad

    def _orient_image(self, path):
        """Bake EXIF orientation once so both adapters embed the same pixels.

        Untagged/upright assets retain their original bytes. Oriented sources
        stay untouched; a lossless PNG in the asset cache removes dependence
        on whether the presentation viewer interprets EXIF metadata.
        """
        from PIL import Image, ImageOps
        with Image.open(path) as image:
            if image.getexif().get(274, 1) not in range(2, 9):
                return path
            with open(path, 'rb') as source:
                key = hashlib.sha256(source.read()).hexdigest()
            out = os.path.join(self.cache_dir, 'oriented-' + key + '.png')
            if not os.path.isfile(out):
                oriented = ImageOps.exif_transpose(image)
                if oriented.mode not in ('RGB', 'RGBA', 'L', 'LA', 'P'):
                    oriented = oriented.convert('RGB')
                # Do not carry stale EXIF/XMP orientation into the PNG.
                metadata = {key: oriented.info[key] for key in ('icc_profile', 'dpi', 'transparency')
                            if key in oriented.info}
                oriented.info.clear()
                fd, partial = tempfile.mkstemp(suffix='.png', dir=self.cache_dir)
                os.close(fd)
                try:
                    oriented.save(partial, **metadata)
                    os.replace(partial, out)
                finally:
                    if os.path.exists(partial):
                        os.unlink(partial)
            return out

    def _bake_opacity(self, path, opacity):
        from PIL import Image
        key = 'op-%s-%.2f' % (_digest(path + str(os.path.getmtime(path))), opacity)
        out = os.path.join(self.cache_dir, key + '.png')
        if os.path.exists(out):
            return out
        try:
            img = Image.open(path).convert('RGBA')
        except MemoryError:
            raise
        except Exception as exc:                            # noqa: BLE001
            log.warning('[WARN] failed to open image %s: %s', path, exc)
            return path
        _apply_opacity(img, opacity).save(out)
        return out


def image_size(path):
    """Visible source dimensions after EXIF rotation, without decoding pixels."""
    from PIL import Image
    with Image.open(path) as image:
        width, height = image.size
        if image.getexif().get(274, 1) in (5, 6, 7, 8):
            return height, width
        return width, height


def contain_rect(path, box_w, box_h):
    """Centered ``object-fit: contain`` rectangle inside a viewport.

    The return value is local ``(left, top, width, height)``. The native
    adapter uses it as target fill insets, preserving the original image and
    the viewport's geometry/mask. The preview maps pixels into this rectangle.
    """
    fallback = (0.0, 0.0, box_w, box_h)
    if box_w <= 0 or box_h <= 0:
        return fallback
    try:
        natural_w, natural_h = image_size(path)
        if natural_w <= 0 or natural_h <= 0:
            return fallback
        scale = min(box_w / natural_w, box_h / natural_h)
        width, height = natural_w * scale, natural_h * scale
        return ((box_w - width) / 2, (box_h - height) / 2, width, height)
    except MemoryError:
        raise
    except Exception as exc:                            # noqa: BLE001
        log.warning('[WARN] contain_rect: cannot read %s: %s', path, exc)
        return fallback


def _point_inside(point, polygon):
    x, y = point
    inside = False
    for (ax, ay), (bx, by) in zip(polygon, polygon[1:] + polygon[:1]):
        if (ay > y) != (by > y) and x < (bx-ax)*(y-ay)/(by-ay) + ax:
            inside = not inside
    return inside


def _segment_in_rect(first, last, bounds):
    """Whether a boundary enters a rectangle (Liang–Barsky interval)."""
    x, y = first
    dx, dy = last[0]-x, last[1]-y
    left, top, right, bottom = bounds
    low, high = 0.0, 1.0
    for direction, distance in ((-dx, x-left), (dx, right-x),
                                (-dy, y-top), (dy, bottom-y)):
        if abs(direction) < 1e-12:
            if distance < 0:
                return False
        elif direction < 0:
            low = max(low, distance / direction)
        else:
            high = min(high, distance / direction)
        if low > high:
            return False
    return True


def safe_contain_rect(path, width, height, radius=0, outline=None):
    """Largest centred source-aspect rectangle inside the picture mask.

    Cubics use the same polygon representation as preview masks, at finer
    resolution. A one-pixel clearance protects native curves and rounded
    preview placement from flattening/rounding error. No design geometry is
    duplicated here. Explicit contain on selected picture viewports opts in;
    ordinary CSS contain (including phone/monitor screenshots) is unchanged.
    """
    left, top, w, h = contain_rect(path, width, height)
    if not outline and radius <= 0:
        return left, top, w, h
    polygons = outline.polygons(steps=128) if outline else None
    center = (width / 2, height / 2)
    if polygons and not any(_point_inside(center, poly) for poly in polygons):
        raise ValueError('safe contain requires the viewport centre inside its mask')
    r = min(radius, width/2, height/2)

    def fits(amount):
        x, y = (width-w*amount)/2, (height-h*amount)/2
        bounds = (x-1, y-1, x+w*amount+1, y+h*amount+1)
        if polygons:
            # A centre inside and no boundary crossing implies the entire
            # rectangle is inside; checking just four corners misses notches.
            return not any(_segment_in_rect(a, b, bounds)
                           for poly in polygons
                           for a, b in zip(poly, poly[1:]+poly[:1]))
        px, py = bounds[:2]
        if px < 0 or py < 0:
            return False
        dx, dy = max(0, r-px), max(0, r-py)
        return dx*dx + dy*dy <= r*r

    low, high = 0.0, 1.0
    for _ in range(36):
        middle = (low+high)/2
        if fits(middle):
            low = middle
        else:
            high = middle
    w, h = w*low, h*low
    return (width-w)/2, (height-h)/2, w, h


def picture_mask_area(width, height, radius=0, outline=None):
    """Viewport area remaining after rounded corners or a custom cutout."""
    if outline is not None:
        return sum(abs(sum(ax*by-bx*ay for (ax, ay), (bx, by) in
                           zip(poly, poly[1:]+poly[:1]))) / 2
                   for poly in outline.polygons(steps=128))
    radius = min(radius, width/2, height/2)
    return width*height - (4-math.pi)*radius*radius


def _object_position(value):
    """CSS percentage/keyword positions, restricted to the two-axis syntax.

    Percentages align that fraction of the image with the same viewport
    fraction. Missing/unsupported positions retain CSS's centred default.
    """
    tokens = (value or '50% 50%').strip().lower().split()
    if not tokens or len(tokens) > 2:
        return (0.5, 0.5)
    if len(tokens) == 1:
        tokens = (['center', tokens[0]] if tokens[0] in ('top', 'bottom')
                  else [tokens[0], 'center'])
    elif tokens[0] in ('top', 'bottom') or tokens[1] in ('left', 'right'):
        tokens = tokens[::-1]
    result = []
    for token, keywords in zip(tokens, ({'left': 0, 'center': 0.5, 'right': 1},
                                      {'top': 0, 'center': 0.5, 'bottom': 1})):
        if token in keywords:
            result.append(keywords[token])
        elif token.endswith('%'):
            try:
                result.append(max(0, min(1, float(token[:-1]) / 100)))
            except ValueError:
                return (0.5, 0.5)
        else:
            return (0.5, 0.5)
    return tuple(result)


def cover_crop(path, box_w, box_h, position=None):
    """Fractions `(left, top, right, bottom)` to crop off `path`'s own edges
    so it fills a `box_w`x`box_h` box without distorting it — `object-fit:
    cover`. Only the axis where the image overflows is cropped, aligned by
    ``position`` (CSS ``object-position``), centred by default. This is the
    fraction PPTX's
    own `Picture.crop_left` etc. expect, so no pixel work happens on our
    side for the native render — only `preview.py`'s Pillow path acts on it.

    All zero if the box has no area or the file cannot be read: falling
    back to today's stretch-fill rather than raising, since a bad crop is
    a cosmetic regression, not a build failure the `media.py` gate already
    exists to catch.
    """
    if box_w <= 0 or box_h <= 0:
        return (0.0, 0.0, 0.0, 0.0)
    try:
        natural_w, natural_h = image_size(path)
    except MemoryError:
        raise
    except Exception as exc:                            # noqa: BLE001
        log.warning('[WARN] cover_crop: cannot read %s: %s', path, exc)
        return (0.0, 0.0, 0.0, 0.0)
    if natural_w <= 0 or natural_h <= 0:
        return (0.0, 0.0, 0.0, 0.0)

    box_ar = box_w / box_h
    img_ar = natural_w / natural_h
    position_x, position_y = _object_position(position)
    if img_ar > box_ar:
        crop = 1.0 - box_ar / img_ar
        return (crop * position_x, 0.0, crop * (1 - position_x), 0.0)
    if img_ar < box_ar:
        crop = 1.0 - img_ar / box_ar
        return (0.0, crop * position_y, 0.0, crop * (1 - position_y))
    return (0.0, 0.0, 0.0, 0.0)


def picture_fit(path, width, height, visible_height, fit=None, position=None,
                safe=False, radius=0, outline=None):
    """Source crop and target rectangle after a viewport's bottom is clipped.

    Fit against the original viewport first. Cutting off its tail then cuts
    the same fraction of the already fitted source, without rescaling the
    remaining image or moving its top. Native and preview use these answers.
    """
    if fit == 'contain' and safe:
        return None, safe_contain_rect(path, width, visible_height, radius, outline)
    crop = cover_crop(path, width, height, position) if fit == 'cover' else None
    contained = contain_rect(path, width, height) if fit == 'contain' else None
    if visible_height >= height:
        return crop, contained
    if contained is not None:
        left, top, target_w, target_h = contained
        displayed_h = max(0, min(target_h, visible_height - top))
        crop = (0, 0, 0, 1 - displayed_h / target_h) if target_h else None
        return crop, (left, top, target_w, displayed_h)
    left, top, right, bottom = crop or (0, 0, 0, 0)
    bottom += (1 - top - bottom) * (1 - visible_height / height)
    return (left, top, right, bottom), None


def _apply_opacity(img, opacity):
    """Bake CSS `opacity` into alpha channel — nothing to set it on images in PPTX."""
    if opacity >= 1.0:
        return img
    img = img.convert('RGBA')
    alpha = img.getchannel('A').point(lambda a: int(a * opacity))
    img.putalpha(alpha)
    return img


def _digest(text):
    return hashlib.md5(text.encode('utf-8')).hexdigest()[:16]


def _float_or(value, default):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default
