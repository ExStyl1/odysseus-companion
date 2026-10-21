# -*- coding: utf-8 -*-
"""Image source validation for the `image` and `chart` layouts.

`resolve_image` only checks that a user-supplied file exists and decodes as
a format PPTX can embed — it does not render anything. The path it returns
still goes through the existing `AssetResolver` in `html2pptx/assets.py`,
the same as any other `<img src>` in the template.

Fails hard rather than the icon-style silent `[WARN]`: a spec author who
typos a filename or drops a PDF instead of a PNG should see it at build
time, not discover a slide with a missing picture after the build already
reported success.
"""
from PIL import Image, UnidentifiedImageError

from .model import MediaError

# What PPTX can embed and what the author's own scenario actually asks for
# ("jpeg / png лежит в папке") — not every format Pillow can decode.
_SUPPORTED_FORMATS = ('PNG', 'JPEG')


def resolve_image(path):
    """Validate `path` and return it unchanged.

    Raises `MediaError` if the file is missing, unreadable, exceeds Pillow's
    pixel limit, or is not one of `_SUPPORTED_FORMATS`.
    """
    try:
        with Image.open(path) as img:
            fmt = img.format
            img.verify()
    except FileNotFoundError:
        raise MediaError('image not found: %r' % (path,))
    except Image.DecompressionBombError as exc:
        raise MediaError('%s: image exceeds Pillow pixel limit (%s)' % (path, exc))
    except (IOError, OSError, UnidentifiedImageError) as exc:
        raise MediaError('%s: not a readable image (%s)' % (path, exc))

    if fmt not in _SUPPORTED_FORMATS:
        raise MediaError(
            '%s: unsupported image format %r — only %s are supported'
            % (path, fmt, ' and '.join(_SUPPORTED_FORMATS)))
    return path
