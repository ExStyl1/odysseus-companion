"""CSS cascade for HTML → PPTX converter.

Reads stylesheets linked to the document (`<link rel="stylesheet">` and `<style>`),
parses them into rules, and computes final element properties accounting for:
  - selector specificity,
  - declaration order,
  - inline style (always highest priority),
  - inheritance (color, font-*, line-height, text-align).

Values are NOT hardcoded: the project has two different `base.css` files
(in the skill root and in references/), and they differ — e.g.
`.metric-description` is 44px vs 40px. So we read exactly the file linked
in the input HTML.

Supported selector subset (exactly what the template uses):
    *            .class        .a.b          tag
    .a .b        tag.class     tag tag       comma-separated list
"""
import logging
import os
import re

log = logging.getLogger(__name__)

# Properties that are inherited from parent in CSS. Needed because the template
# actively puts text-align/color on the container while text lies in descendants.
INHERITED = {
    'color', 'font-family', 'font-size', 'font-weight', 'font-style',
    'line-height', 'text-align', 'letter-spacing', 'text-transform',
}

# Default values (root of the tree).
INITIAL = {
    'color': '#000000',
    'font-family': 'Arial',
    'font-size': '16px',
    'font-weight': '400',
    'line-height': 'normal',
    'text-align': 'left',
    'display': 'block',
    'position': 'static',
}


# ---------------------------------------------------------------- shorthands

def _split_top_level(value):
    """Split value by spaces without breaking parentheses: rgba(1, 2, 3) is one."""
    parts, depth, cur = [], 0, ''
    for ch in value:
        if ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
        if ch.isspace() and depth == 0:
            if cur:
                parts.append(cur)
                cur = ''
        else:
            cur += ch
    if cur:
        parts.append(cur)
    return parts


def _expand_box(prop, value):
    """padding/margin: 1-4 values → four sides (CSS order)."""
    v = _split_top_level(value)
    if len(v) == 1:
        top = right = bottom = left = v[0]
    elif len(v) == 2:
        top = bottom = v[0]
        right = left = v[1]
    elif len(v) == 3:
        top, right, bottom = v[0], v[1], v[2]
        left = v[1]
    elif len(v) >= 4:
        top, right, bottom, left = v[0], v[1], v[2], v[3]
    else:
        return {}
    return {prop + '-top': top, prop + '-right': right,
            prop + '-bottom': bottom, prop + '-left': left}


def expand_shorthand(prop, value):
    """Expand shorthand into individual properties.

    Expand at cascade time so a later single-property rule can correctly
    override part of the shorthand.
    """
    prop = prop.strip().lower()
    value = value.strip()

    if prop in ('padding', 'margin'):
        return _expand_box(prop, value)

    if prop == 'gap':
        v = _split_top_level(value)
        if len(v) == 1:
            return {'row-gap': v[0], 'column-gap': v[0]}
        return {'row-gap': v[0], 'column-gap': v[1]}

    if prop == 'background':
        # In the template: either a color, linear-gradient(...), or url(...).
        if 'gradient' in value or value.startswith('url('):
            return {'background-image': value}
        return {'background-color': value}

    if prop == 'flex':
        # `flex: 1` → grow 1. Also handle full form flex: g s b.
        v = _split_top_level(value)
        out = {'flex-grow': v[0]}
        if len(v) > 1:
            out['flex-shrink'] = v[1]
        if len(v) > 2:
            out['flex-basis'] = v[2]
        return out

    return {prop: value}


# ---------------------------------------------------------------- selectors

class Selector:
    """A single selector like `.a .b.c` — chain of simple parts via descendant."""

    __slots__ = ('parts', 'specificity')

    def __init__(self, text):
        self.parts = []
        for chunk in text.split():
            tag = None
            classes = set()
            ids = set()
            # Parse `div.card.gray#x` into components.
            for m in re.finditer(r'([.#]?)([A-Za-z0-9_-]+|\*)', chunk):
                kind, name = m.group(1), m.group(2)
                if kind == '.':
                    classes.add(name)
                elif kind == '#':
                    ids.add(name)
                elif name != '*':
                    tag = name.lower()
            self.parts.append((tag, classes, ids))

        n_id = sum(len(p[2]) for p in self.parts)
        n_cls = sum(len(p[1]) for p in self.parts)
        n_tag = sum(1 for p in self.parts if p[0])
        self.specificity = (n_id, n_cls, n_tag)

    @staticmethod
    def _matches_part(el, part):
        tag, classes, ids = part
        if tag is not None and str(el.tag).lower() != tag:
            return False
        if classes:
            el_classes = set((el.get('class') or '').split())
            if not classes.issubset(el_classes):
                return False
        if ids and (el.get('id') or '') not in ids:
            return False
        return True

    def matches(self, el):
        """Check right-to-left: last part is the element itself, rest are ancestors."""
        if not self.parts:
            return False
        if not self._matches_part(el, self.parts[-1]):
            return False
        remaining = list(reversed(self.parts[:-1]))
        if not remaining:
            return True
        node = el.getparent()
        idx = 0
        while node is not None and idx < len(remaining):
            if isinstance(node.tag, str) and self._matches_part(node, remaining[idx]):
                idx += 1
            node = node.getparent()
        return idx == len(remaining)


class Rule:
    __slots__ = ('selector', 'declarations', 'order')

    def __init__(self, selector, declarations, order):
        self.selector = selector
        self.declarations = declarations
        self.order = order


# ---------------------------------------------------------------- CSS parser

_COMMENT_RE = re.compile(r'/\*.*?\*/', re.S)
_IMPORTANT_RE = re.compile(r'\s*!\s*important\s*$', re.I)


def parse_declarations(text):
    """`a: 1px; b: red` → {'a': '1px', 'b': 'red'} with shorthands expanded."""
    out = {}
    for decl in _split_declarations(text):
        if ':' not in decl:
            continue
        prop, _, value = decl.partition(':')
        prop = prop.strip().lower()
        # WARNING: do NOT use rstrip('!important') — it strips any character
        # from the set, turning `column` into `colu`. Remove the suffix explicitly.
        value = _IMPORTANT_RE.sub('', value.strip()).strip()
        if not prop or not value:
            continue
        out.update(expand_shorthand(prop, value))
    return out


def _split_declarations(text):
    """Split by `;` without breaking parentheses — box-shadow and gradients have semicolon-safe commas."""
    parts, depth, cur = [], 0, ''
    for ch in text:
        if ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
        if ch == ';' and depth == 0:
            parts.append(cur)
            cur = ''
        else:
            cur += ch
    if cur.strip():
        parts.append(cur)
    return parts


def parse_stylesheet(css_text, start_order=0):
    """Parse CSS text into a list of rules. Skip at-rules with blocks."""
    css_text = _COMMENT_RE.sub('', css_text)
    rules = []
    order = start_order
    i = 0
    n = len(css_text)
    while i < n:
        brace = css_text.find('{', i)
        if brace == -1:
            break
        prelude = css_text[i:brace].strip()

        # Find the matching closing brace.
        depth = 1
        j = brace + 1
        while j < n and depth:
            if css_text[j] == '{':
                depth += 1
            elif css_text[j] == '}':
                depth -= 1
            j += 1
        body = css_text[brace + 1:j - 1]

        if prelude.startswith('@'):
            # @media print / @page / @font-face — do not affect slide geometry.
            log.debug('[SKIP] at-rule: %s', prelude[:40])
        else:
            decls = parse_declarations(body)
            if decls:
                for sel_text in prelude.split(','):
                    sel_text = sel_text.strip()
                    if not sel_text:
                        continue
                    if any(c in sel_text for c in '>+~:['):
                        # Combinators and pseudo-classes are not used in the template.
                        log.debug('[SKIP] unsupported selector: %s', sel_text)
                        continue
                    rules.append(Rule(Selector(sel_text), decls, order))
                    order += 1
        i = j
    return rules, order


# ---------------------------------------------------------------- stylesheet

class Stylesheet:
    """Collected document rules + element property computation."""

    def __init__(self, rules, sources):
        self.rules = rules
        self.sources = sources          # paths to actually loaded CSS files (for logging)
        self._cache = {}

    @classmethod
    def from_document(cls, doc, base_dir):
        """Collect document styles: external <link> + internal <style>."""
        rules, order, sources = [], 0, []

        for link in doc.xpath('//link[@rel="stylesheet"]'):
            href = link.get('href')
            if not href:
                continue
            path = os.path.normpath(os.path.join(base_dir, href))
            if not os.path.exists(path):
                log.warning('[WARN] stylesheet not found: %s', path)
                continue
            with open(path, 'r', encoding='utf-8') as f:
                text = f.read()
            new_rules, order = parse_stylesheet(text, order)
            rules.extend(new_rules)
            sources.append(path)
            log.info('[OK] stylesheet loaded: %s (rules: %d)', path, len(new_rules))

        for style in doc.xpath('//style'):
            new_rules, order = parse_stylesheet(style.text or '', order)
            rules.extend(new_rules)
            if new_rules:
                sources.append('<style>')

        if not rules:
            log.warning('[WARN] no styles found — rendering will use inline only')
        return cls(rules, sources)

    def add_file(self, path):
        """Load additional CSS (for slide fragments without <link>)."""
        if not os.path.isfile(path):
            log.warning('[WARN] stylesheet not found: %s', path)
            return
        with open(path, 'r', encoding='utf-8') as f:
            text = f.read()
        order = max((r.order for r in self.rules), default=0) + 1
        new_rules, _ = parse_stylesheet(text, order)
        # Place the external file BEFORE already collected rules by order, so
        # inline and document <style> remain higher priority at equal specificity.
        for rule in new_rules:
            rule.order -= 10 ** 6
        self.rules.extend(new_rules)
        self.rules.sort(key=lambda r: r.order)
        self._cache.clear()
        self.sources.append(path)
        log.info('[OK] style attached automatically: %s (rules: %d)',
                 path, len(new_rules))

    def invalidate(self, el=None):
        """Forget what was computed for the element (or for all of them).

        Needed by anyone who edits the `style` attribute after the first
        pass already happened — that's what the size search in
        deckkit/autofit.py does. Without the reset, `declared` would return
        the inline style read before the edit: the search would measure the
        same layout over and over and "pick" the very first step.
        """
        if el is None:
            self._cache.clear()
        else:
            self._cache.pop(el, None)

    def declared(self, el):
        """Properties declared for the element: cascade of rules + inline."""
        # Key by the element itself, not id(): lxml proxies are short-lived,
        # and after garbage collection id() gets reused by another element.
        # The dict also keeps the proxy alive.
        cached = self._cache.get(el)
        if cached is not None:
            return cached

        matched = [r for r in self.rules if r.selector.matches(el)]
        matched.sort(key=lambda r: (r.selector.specificity, r.order))

        props = {}
        for rule in matched:
            props.update(rule.declarations)

        inline = el.get('style')
        if inline:
            props.update(parse_declarations(inline))

        self._cache[el] = props
        return props

    def computed(self, el, parent_computed=None):
        """Final properties with inheritance from parent."""
        base = dict(INITIAL) if parent_computed is None else {
            k: v for k, v in parent_computed.items() if k in INHERITED
        }
        base.update(self.declared(el))
        return base
