# -*- coding: utf-8 -*-
"""Putting the layers of one design object back into one PowerPoint shape.

Some things the template draws are single objects that PPTX has no way to
express as a single shape, so the renderer emits them as several: a glass panel
is an outer shadow, a fill and an inner shadow; a ring is a disc with a hole
laid over it; a numbered circle is a circle plus a text box. Left flat, each
layer is separately selectable, and dragging one produces something nobody drew
— a shadow off its panel, a hole outside its ring. That is not a designer's
recommendation being broken, it is the renderer's implementation leaking into
the object model, so these are grouped.

Groups deliberately stop there. A whole card, a timeline point or a flow step
are several *distinct* objects that happen to sit together, and selecting one
of them alone is legitimate — someone may well retype a card's title without
touching its icon. Grouping those would cost a click on every text edit and,
worse, allow the group to be resized as a unit: PowerPoint rescales the child
frames without rescaling the type, so the text reflows or clips. The flat
layout cannot produce that failure and should not learn how.

Which classes are such objects is the template's knowledge, not the engine's:
the caller passes them in (`write_pptx(..., group_roots=...)`; the deck passes
`layouts.GROUP_ROOTS`). Without them nothing is grouped, which is a correct
if less convenient file.

Grouping is a PPTX concern only. `paint.py` and `PaintTarget` know nothing
about it, and the Pillow preview is unaffected — it draws pixels, which have no
object model to leak into.
"""
import logging

log = logging.getLogger(__name__)

def parent_map(root):
    """Child → parent for one slide.

    `Box` carries no parent pointer, so it is rebuilt by walking `children`.
    The key is the Box object rather than `id()` on purpose: lxml proxies are
    short-lived and their ids get reused by other nodes, and holding the object
    as a key keeps it alive as well.
    """
    parents = {}
    for box in root.walk():
        for child in box.children:
            parents[child] = box
    return parents


def group_root(box, parents, roots):
    """The box that defines `box`'s group, or None if it stands alone.

    `roots` are the classes that mark one design object drawn as several
    shapes; the nearest ancestor carrying one - or the box itself - defines
    the group.
    """
    node = box
    while node is not None:
        if node.classes() & roots:
            return node
        node = parents.get(node)
    return None


def apply_groups(slide, painted, parents, index=0, roots=frozenset()):
    """Group the recorded shapes. Returns [(class name, shape count), ...].

    `painted` is (box, shape) in paint order, one entry per shape the slide
    actually got.
    """
    order = []
    members = {}
    for box, shape in painted:
        root = group_root(box, parents, roots)
        if root is None:
            continue
        if root not in members:
            members[root] = []
            order.append(root)
        members[root].append(shape)

    tree = slide.shapes._spTree
    made = []
    for root in order:
        shapes = members[root]
        if len(shapes) < 2:
            continue
        name = ' '.join(sorted(root.classes() & roots))

        # Contiguity is a correctness condition, not a tidiness one. Grouping
        # shapes that are not neighbours in the shape tree would reorder them
        # against everything painted in between, silently changing what covers
        # what. Every group in the template is contiguous; if one stops being
        # so, the template changed and the rule has to be rethought rather than
        # applied anyway.
        at = [tree.index(shape._element) for shape in shapes]
        if at != list(range(at[0], at[0] + len(at))):
            log.error('[ERROR] slide %02d: %s is not contiguous in the shape '
                      'tree (%s) - left ungrouped', index, name, at)
            continue

        group = slide.shapes.add_group_shape(shapes)

        # `add_group_shape` appends the group at the END of the shape tree, so
        # the group would land on top of everything drawn after its members.
        # On a glass panel — drawn first, with the logo and the headline over
        # it — that turns the title slide into a blank panel. Nothing here can
        # catch it: no .pptx renderer exists in this environment and the PNG
        # preview does not go through grouping at all. So the group goes back
        # where its first member was.
        tree.insert(at[0], group._element)
        made.append((name, len(shapes)))
    return made
