# -*- coding: utf-8 -*-
"""Inline formulas, whole: the parse, the metrics and the Office Math.

The supported language is deliberately smaller than LaTeX. Every accepted
formula must also render through matplotlib mathtext for the PNG preview; an
unknown construct is a build error rather than a best-effort equation with a
different meaning.

The engine owns the `<span class="math" data-latex data-mathtext>` marker,
so it owns the formula too: the layout asks this module how wide and how
deep a formula is (`MathRun`, `math_metrics`), the writer asks it for the
styled `<a14:m>` (`omml`), and the deck's fragment filler asks it whether a
source is acceptable (`parse_inline`, `validate`). Until 2.1 this module sat
in `deckkit` while its metrics sat in `textmeasure` and its styling in
`render`, and the two halves imported each other lazily.
"""
import collections
import logging
import re
import unicodedata

import numpy as np
from lxml import etree
from pptx.oxml.ns import qn

from . import values as V
from .fonts import normalize_weight


class FormulaError(Exception):
    """Inline LaTeX does not belong to the supported editable-math subset."""
    pass


A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main'
A14_NS = 'http://schemas.microsoft.com/office/drawing/2010/main'
M_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/math'

# Public contract used by the documentation and the self-test. Structural
# commands are parsed separately; symbol commands map directly to one glyph.
SYMBOLS = {
    'alpha': '\U0001D6FC', 'beta': '\U0001D6FD', 'gamma': '\U0001D6FE',
    'delta': '\U0001D6FF', 'epsilon': '\U0001D700', 'zeta': '\U0001D701',
    'eta': '\U0001D702', 'theta': '\U0001D703', 'iota': '\U0001D704',
    'kappa': '\U0001D705', 'lambda': '\U0001D706', 'mu': '\U0001D707',
    'nu': '\U0001D708', 'xi': '\U0001D709',
    # No \omicron here on purpose: TeX has no such command, because omicron
    # is an ordinary o, and mathtext does not know the name either.
    'pi': '\U0001D70B', 'rho': '\U0001D70C', 'sigma': '\U0001D70E',
    'tau': '\U0001D70F', 'upsilon': '\U0001D710', 'phi': '\U0001D711',
    'chi': '\U0001D712', 'psi': '\U0001D713', 'omega': '\U0001D714',
    'Gamma': '\U0001D6E4', 'Delta': '\U0001D6E5', 'Theta': '\U0001D6E9',
    'Lambda': '\U0001D6EC', 'Xi': '\U0001D6EF', 'Pi': '\U0001D6F1',
    'Sigma': '\U0001D6F4', 'Phi': '\U0001D6F7', 'Psi': '\U0001D6F9',
    'Omega': '\U0001D6FA',
    'partial': '∂', 'infty': '∞', 'le': '≤', 'leq': '≤', 'ge': '≥',
    'geq': '≥', 'neq': '≠', 'approx': '≈', 'pm': '±', 'mp': '∓',
    'cdot': '·', 'times': '×', 'div': '÷', 'to': '→', 'rightarrow': '→',
    'leftarrow': '←', 'leftrightarrow': '↔', 'prime': '′',
    # v1.8 shipped the Greek alphabet and little else, and a corpus audit of
    # 318 real formulas then rejected 174 of them. Everything below is that
    # vocabulary. Each entry is checked against matplotlib mathtext as well as
    # OMML by selftest.test_formula_command_coverage — the supported set is the
    # tested intersection of the two consumers, and that is now a check rather
    # than a promise in prose.
    'mid': '∣', 'in': '∈', 'notin': '∉', 'ni': '∋', 'perp': '⊥',
    'forall': '∀', 'exists': '∃', 'neg': '¬',
    'ell': 'ℓ', 'hbar': 'ℏ', 'aleph': 'ℵ', 'emptyset': '∅',
    'cup': '∪', 'cap': '∩', 'setminus': '∖',
    'subset': '⊂', 'subseteq': '⊆', 'supset': '⊃', 'supseteq': '⊇',
    'sim': '∼', 'simeq': '≃', 'propto': '∝', 'equiv': '≡',
    'll': '≪', 'gg': '≫', 'circ': '∘', 'ast': '∗', 'star': '⋆',
    'oplus': '⊕', 'otimes': '⊗', 'nabla': '∇', 'angle': '∠',
    'Rightarrow': '⇒', 'Leftarrow': '⇐', 'Leftrightarrow': '⇔',
    'mapsto': '↦', 'langle': '⟨', 'rangle': '⟩',
    'top': '⊤', 'bot': '⊥', '%': '%',
    # A norm bar is written bare far more often than as a \left...\right pair
    # (`\|\hat g - g_0\|_2`), so it is a symbol as well as a delimiter.
    # Its \lvert / \lVert spellings stay delimiters only: mathtext has no
    # such bare command, and a lone bar is written as `|`.
    '|': '‖',
    'dots': '…', 'ldots': '…', 'cdots': '⋯', 'vdots': '⋮', 'ddots': '⋱',
    'quad': ' ', 'qquad': '  ',
    ',': ' ', ';': ' ', ':': ' ', '!': '', ' ': ' ',
}

# Spelt one way by the corpus, another by the engine. Resolved before the
# dispatch chain sees the name, so a synonym costs one row and no code path.
_ALIASES = {
    'dfrac': 'frac', 'tfrac': 'frac',
    # mathtext knows \leq and \geq, not the short spellings. This pair is
    # the whole of what textmeasure._MATHTEXT_ALIASES used to hold, moved to
    # where every other synonym already lives.
    'le': 'leq', 'ge': 'geq', 'ne': 'neq',
    'widehat': 'hat', 'widetilde': 'tilde',
    'iff': 'Leftrightarrow', 'implies': 'Rightarrow', 'impliedby': 'Leftarrow',
    'lor': 'cup', 'land': 'cap',
    # The var- forms are the same letter here, deliberately. TeX distinguishes
    # two shapes per letter and Unicode has both, but the two consumers do not
    # agree on which shape each command means — mathtext draws \epsilon as the
    # lunate form while the glyph OMML has always carried is the other one. An
    # alias makes the two adapters show the same letter, which matters more in
    # a slide than the shape distinction does.
    'varepsilon': 'epsilon', 'varphi': 'phi',
    'vartheta': 'theta', 'varsigma': 'sigma',
}

# A delimiter whose size the author asked for by hand. TeX's \bigl family is a
# manual size hint on an ordinary delimiter, and neither consumer has one:
# OMML grows m:d to fit its content, and mathtext rejects the command outright.
# Both are therefore read as \left / \right, which is what the hint was
# approximating in the first place.
_BIG_LEFT = frozenset(('bigl', 'Bigl', 'biggl', 'Biggl'))
_BIG_RIGHT = frozenset(('bigr', 'Bigr', 'biggr', 'Biggr'))
# The unsuffixed forms are NOT openers, and treating them as such is what made
# `E\big[ x \,\big|\, A\big]` report an unclosed delimiter: `\big|` is a lone
# mid-height bar, and three neutral hints in a row are not a nest. Only the
# l/r-suffixed spellings pair up. A neutral hint is read as the plain
# delimiter it decorates, since neither consumer can honour the size request.
_BIG_NEUTRAL = frozenset(('big', 'Big', 'bigg', 'Bigg'))

_FUNCTIONS = frozenset((
    'log', 'ln', 'exp', 'sin', 'cos', 'tan', 'min', 'max',
    'sinh', 'cosh', 'tanh', 'arcsin', 'arccos', 'arctan',
    'sup', 'inf', 'lim', 'det', 'gcd', 'dim', 'ker', 'Pr',
))
# \arg is only ever an operator name here, and always as \arg\min / \arg\max.
# One name rather than a function applied to a function, which is what nesting
# the two would mean.
_ARG_OPERATORS = frozenset(('min', 'max'))
_STYLES = frozenset(('mathrm', 'mathbb', 'mathbf', 'mathcal', 'mathit',
                     'mathsf', 'boldsymbol'))
STRUCTURAL_COMMANDS = frozenset((
    'frac', 'sqrt', 'sum', 'prod', 'int', 'left', 'right', 'bar', 'hat',
    'overline', 'text', 'arg', 'not',
)) | _FUNCTIONS | _STYLES | _BIG_LEFT | _BIG_RIGHT | _BIG_NEUTRAL

# Refused by name, with the rewrite to make instead. A construct with no
# faithful equivalent in *both* consumers is better named than approximated:
# an approximation of mathematics is wrong mathematics, and the author who
# wrote it is the only one who can say what it should become.
_REFUSALS = {
    'underbrace': 'annotate the expression in prose instead',
    'overbrace': 'annotate the expression in prose instead',
    'xrightarrow': 'use \\to and put the label in prose',
    'xleftarrow': 'use \\leftarrow and put the label in prose',
    'stackrel': 'use \\to and put the label in prose',
    'overset': 'put the annotation in prose',
    'underset': 'put the annotation in prose',
    'begin': 'matrices, cases and align are not inline math',
    'end': 'matrices, cases and align are not inline math',
    'displaystyle': 'an inline formula has no display mode',
    'limits': 'limits are placed for you; write \\sum_{a}^{b}',
    'nolimits': 'limits are placed for you; write \\sum_{a}^{b}',
    'substack': 'write one subscript, or move the condition to prose',
    'binom': 'write the binomial as \\frac, or in prose',
    'phantom': 'spacing struts are not supported',
    'mathstrut': 'spacing struts are not supported',
}

_NARY = {'sum': '∑', 'prod': '∏', 'int': '∫', 'oint': '∮',
         'bigcup': '⋃', 'bigcap': '⋂', 'bigoplus': '⨁'}
_INVISIBLE_ARGUMENT = '​'
# The combining mark OMML puts in m:accPr/m:chr, and the command
# mathtext wants back. One row per accent so the two cannot drift.
_ACCENTS = {'hat': '̂', 'tilde': '̃', 'vec': '⃗', 'dot': '̇',
            'ddot': '̈', 'check': '̌', 'breve': '̆',
            'acute': '́', 'grave': '̀'}
_DELIMITERS = {'(': '(', ')': ')', '[': '[', ']': ']', '|': '|',
               '\\lvert': '|', '\\rvert': '|', '\\{': '{', '\\}': '}',
               '\\|': '‖', '\\lVert': '‖', '\\rVert': '‖',
               '\\langle': '⟨', '\\rangle': '⟩',
               '\\lfloor': '⌊', '\\rfloor': '⌋',
               '\\lceil': '⌈', '\\rceil': '⌉',
               '.': ''}
# The same table read the other way, for the canonical mathtext spelling.
# Not derived by inverting _DELIMITERS: that map is many-to-one (three ways to
# write a norm bar) and an inverse would pick whichever came last.
_DELIMITER_TEX = {'(': '(', ')': ')', '[': '[', ']': ']', '|': '|',
                  '{': '\\{', '}': '\\}', '‖': '\\|',
                  '⟨': '\\langle', '⟩': '\\rangle',
                  '⌊': '\\lfloor', '⌋': '\\rfloor',
                  '⌈': '\\lceil', '⌉': '\\rceil', '': '.'}

# The whole public contract, assembled from the tables rather than restated —
# the documentation and selftest.test_formula_command_coverage both read this.
SUPPORTED_COMMANDS = (frozenset(SYMBOLS) | STRUCTURAL_COMMANDS
                      | frozenset(_ACCENTS) | frozenset(_NARY)
                      | frozenset(_ALIASES))

_ALLOWED_LITERAL = frozenset(
    '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ '
    "+−-=(),.[]|<>/:;%!′'")


def _m(name):
    return '{%s}%s' % (M_NS, name)


def _a(name):
    return '{%s}%s' % (A_NS, name)


def _node(kind, *values):
    return (kind,) + values


# Rebuilt per run before v1.8.1, once per symbol emitted. SYMBOLS is now four
# times longer, so it is computed once.
_GREEK = frozenset(name for name, glyph in SYMBOLS.items()
                   if glyph and ord(glyph[0]) >= 0x1D6E2)

# Every command that closes a delimiter pair, and every one that opens one.
# `_row` and the unbraced-operand scanners have to stop at all of the closers,
# not only at `\right`.
_CLOSER_NAMES = frozenset(['right']) | _BIG_RIGHT
_OPENER_NAMES = frozenset(['left']) | _BIG_LEFT


def _command_at(source, pos):
    """The whole command name starting at `pos`, or None.

    Whole, not a prefix. The delimiter spellings nest inside each other —
    `\\big` is a prefix of `\\bigg` *and* of `\\bigr` — so prefix matching
    read the closing `\\bigr` as another opening `\\big`, ran the nesting
    depth up instead of down, and reported every `\\bigl(...\\bigr)` as
    unclosed.
    """
    if pos >= len(source) or source[pos] != '\\':
        return None
    match = re.match(r'\\([A-Za-z]+)', source[pos:])
    return match.group(1) if match else None


def _at_closer(source, pos):
    return _command_at(source, pos) in _CLOSER_NAMES


def _literal_tex(ch):
    """One literal character as mathtext source."""
    if ch == '%':
        return '\\%'
    if ch == '−':
        return '-'
    return ch


_CYRILLIC = re.compile('[Ѐ-ӿ]')


def _check_math_text(value, parser):
    """Refuse Cyrillic inside a formula, where no math face can set it.

    mathtext draws math with a math face and OMML has no upright Cyrillic
    math either, so a Cyrillic label inside `\\text{}` is not a formula that
    renders badly — it is one neither consumer can render at all.
    """
    if _CYRILLIC.search(value):
        parser._error('Cyrillic cannot be set inside a formula — keep '
                      '%r in the prose outside \\(...\\)' % value)


def parse_inline(text):
    """Split prose on unambiguous inline-math delimiters ``\(...\)``.

    ``\\(`` is a literal ``\(``. An unmatched opening delimiter remains prose;
    a matched empty formula is an error. Closing ``\)`` without an opener is
    ordinary text, which keeps copied prose harmless.
    """
    text = text or ''
    out = []
    plain = []
    pos = 0

    def flush():
        if plain:
            value = ''.join(plain)
            if out and out[-1][0] == 'text':
                out[-1] = ('text', out[-1][1] + value)
            else:
                out.append(('text', value))
            del plain[:]

    while pos < len(text):
        if text.startswith('\\\\(', pos):
            plain.append('\\(')
            pos += 3
            continue
        if text.startswith('\\\\)', pos):
            # The closer unescapes too. `_find_close` has always skipped this
            # pair when scanning for the end of a formula; the prose branch
            # did not, so an escaped opener came back as `\(` and an escaped
            # closer stayed `\\)` — the same text treated two ways.
            plain.append('\\)')
            pos += 3
            continue
        if not text.startswith('\\(', pos):
            plain.append(text[pos])
            pos += 1
            continue
        close = _find_close(text, pos + 2)
        if close < 0:
            plain.append('\\(')
            pos += 2
            continue
        flush()
        latex = text[pos + 2:close]
        if not latex.strip():
            raise FormulaError('empty inline formula \\(\\)')
        out.append(('math', latex.strip()))
        pos = close + 2
    flush()
    return out


def _find_close(text, start):
    pos = start
    while pos < len(text) - 1:
        if text.startswith('\\\\)', pos):
            pos += 3
            continue
        if text.startswith('\\)', pos):
            return pos
        pos += 1
    return -1


def contains_formula(text):
    """Whether text contains an intentional, matched inline formula."""
    return any(kind == 'math' for kind, _ in parse_inline(text))


def validate(latex, size_px=34.0, weight=400):
    """Require one source to work in both consumers, and return both forms.

    Returns ``(omath, mathtext_source)``. The caller keeps the second value:
    it is what every measurement and the PNG raster are computed from. The
    writer parses `latex` once more for the OMML (`omml`), because the HTML
    round trip carries strings and not the tree; the parse is deterministic,
    and this call is what guarantees that second parse succeeds.
    """
    ast = parse(latex)
    omath = _omml_of(ast, latex)
    source = to_mathtext(ast)
    try:
        math_metrics(source, size_px, weight)
    except FormulaError:
        raise
    except Exception as exc:
        # Name the canonical source too. A construct this parser accepts and
        # mathtext does not is a gap between the two tables, and the spelling
        # we handed over is the first thing to look at.
        raise FormulaError('mathtext cannot render \\(%s\\) as %r: %s'
                           % (latex, source, exc))
    return omath, source


def parse(latex):
    """The single parse both emitters read."""
    try:
        return _Parser(latex).parse()
    except FormulaError:
        raise
    except RecursionError:
        raise FormulaError('formula is nested too deeply in \\(%s\\)' % latex)


def latex_to_omml(latex):
    """Convert the supported inline-LaTeX subset to an ``m:oMath`` element."""
    return _omml_of(parse(latex), latex)


def omml(latex, face, size_px, bold, rgba):
    """The `<a14:m>` a DrawingML paragraph takes inline, styled like its text.

    `face` is the PPTX typeface of the surrounding prose (`FontBook.face`) and
    goes to the East Asian and complex-script slots; Latin is always Cambria
    Math, the face PowerPoint sets OMML in and the one `MATH_*_FACTOR` below
    are calibrated against.
    """
    omath = latex_to_omml(latex)
    size = str(int(round(V.px_to_pt(size_px) * 100)))
    colour = V.to_hex(rgba)
    for rpr in omath.iter('{%s}rPr' % A_NS):
        italic = rpr.get('i')
        rpr.clear()
        if italic:
            rpr.set('i', italic)
        if bold:
            rpr.set('b', '1')
        rpr.set('sz', size)
        fill = etree.SubElement(rpr, qn('a:solidFill'))
        etree.SubElement(fill, qn('a:srgbClr')).set('val', colour)
        etree.SubElement(rpr, qn('a:latin')).set('typeface', 'Cambria Math')
        # PowerPoint can use the EA/CS slots for U+2194 and fall back to a
        # colored emoji. Keep this mathematical arrow in Cambria Math in
        # every slot; a text variation selector renders as a visible box.
        value = rpr.getparent().find(_m('t'))
        symbol_face = ('Cambria Math' if value is not None
                       and '\u2194' in (value.text or '') else face)
        etree.SubElement(rpr, qn('a:ea')).set('typeface', symbol_face)
        etree.SubElement(rpr, qn('a:cs')).set('typeface', symbol_face)
    wrapper = etree.Element('{%s}m' % A14_NS,
                            nsmap={'a14': A14_NS, 'm': M_NS, 'a': A_NS})
    wrapper.append(omath)
    return wrapper


def _omml_of(ast, latex):
    try:
        root = etree.Element(_m('oMath'), nsmap={'m': M_NS, 'a': A_NS})
        _emit(ast, root)
        return root
    except FormulaError:
        raise
    except RecursionError:
        raise FormulaError('formula is nested too deeply in \\(%s\\)' % latex)


class _Parser(object):
    def __init__(self, source):
        self.source = source
        self.pos = 0

    def parse(self):
        row = self._row(stop=None)
        self._spaces()
        if self.pos != len(self.source):
            # Name the leftover command instead of the backslash in front of
            # it. `_row` stops at a closing delimiter, so an unpaired
            # `\right)` or `\bigr]` lands here, and `unexpected '\'` told the
            # author nothing about which of the two halves is missing.
            leftover = _command_at(self.source, self.pos)
            if leftover in _CLOSER_NAMES:
                self._error('\\%s has no matching opener — a delimiter pair '
                            'needs both halves' % leftover)
            if leftover:
                self._error('unexpected \\%s' % leftover)
            self._error('unexpected %r' % self.source[self.pos])
        if not row[1]:
            self._error('empty formula')
        return row

    def _row(self, stop):
        children = []
        while self.pos < len(self.source):
            if stop and self.source.startswith(stop, self.pos):
                break
            if self.source[self.pos] == '}':
                if stop == '}':
                    break
                self._error('unexpected closing brace')
            if _at_closer(self.source, self.pos):
                break
            child = self._atom()
            if child is not None:
                children.append(self._scripts(child))
        return _node('row', children)

    def _atom(self):
        ch = self.source[self.pos]
        if ch == '{':
            return self._group()
        if ch == '\\':
            return self._command()
        if ch in '^_':
            self._error('script has no base')
        self.pos += 1
        if ch == '*':
            # TeX sets a bare `*` in math as \ast, and the corpus writes x^*
            # for an optimum. Emitted as \ast for mathtext too, so both
            # consumers show U+2217 rather than one of them the ASCII star;
            # the trailing space keeps `x*y` from reading as `\asty`.
            return _node('run', SYMBOLS['ast'], True, '\\ast ')
        if ch not in _ALLOWED_LITERAL:
            self._error('unsupported symbol %r' % ch)
        if ch.isspace():
            return _node('run', ' ', True, ' ')
        if ch == "'":
            # A bare apostrophe is TeX's prime, and the corpus writes j' rather
            # than j^{\prime} throughout. mathtext takes it verbatim.
            return _node('run', '′', True, "'")
        if ch.isalpha():
            return _node('run', _math_italic(ch), False, ch)
        return _node('run', ch, True, _literal_tex(ch))

    def _group(self):
        self.pos += 1
        row = self._row('}')
        if self.pos >= len(self.source) or self.source[self.pos] != '}':
            self._error('unclosed group')
        self.pos += 1
        return row

    def _script_value(self):
        value = self._group() if self.source[self.pos] == '{' else self._atom()
        if value[0] == 'row' and not value[1]:
            self._error('script value is empty')
        return value

    def _required_group(self, command):
        self._spaces()
        if self.pos >= len(self.source) or self.source[self.pos] != '{':
            self._error('\\%s requires a braced argument' % command)
        value = self._group()
        if not value[1]:
            self._error('\\%s requires a non-empty argument' % command)
        return value

    def _argument(self, command):
        """A braced group, or one bare atom.

        TeX's own rule, and the corpus relies on it: `\\hat\\tau`, `\\sqrt n`,
        `\\bar x` and `\\tilde Y` are written unbraced everywhere. Requiring
        braces rejected about twenty-five real formulas for a spelling.
        `to_mathtext` always writes the braced form back out, which is also
        what makes `\\sqrt n` acceptable to mathtext — it wants braces too.
        """
        self._spaces()
        if self.pos >= len(self.source):
            self._error('\\%s requires an argument' % command)
        if self.source[self.pos] == '{':
            value = self._group()
            if not value[1]:
                self._error('\\%s requires a non-empty argument' % command)
            return value
        if self.source[self.pos] in '}^_]':
            self._error('\\%s requires an argument' % command)
        value = self._atom()
        if value is None or (value[0] == 'row' and not value[1]):
            self._error('\\%s requires a non-empty argument' % command)
        return value

    def _raw_group(self, command):
        self._spaces()
        if self.pos >= len(self.source) or self.source[self.pos] != '{':
            self._error('\\%s requires a braced argument' % command)
        self.pos += 1
        start = self.pos
        depth = 1
        while self.pos < len(self.source) and depth:
            if self.source[self.pos] == '{':
                depth += 1
            elif self.source[self.pos] == '}':
                depth -= 1
                if depth == 0:
                    value = self.source[start:self.pos]
                    self.pos += 1
                    return value
            self.pos += 1
        self._error('unclosed \\%s text' % command)

    def _optional_group(self, command=None):
        self._spaces()
        if self.pos >= len(self.source) or self.source[self.pos] != '[':
            return None
        self.pos += 1
        value = self._row(']')
        if self.pos >= len(self.source) or self.source[self.pos] != ']':
            self._error('unclosed optional argument')
        self.pos += 1
        if not value[1]:
            self._error('\\%s requires a non-empty index' % (command or 'command'))
        return value

    def _command(self):
        start = self.pos
        self.pos += 1
        if self.pos >= len(self.source):
            self._error('trailing backslash')
        if self.source[self.pos].isalpha():
            match = re.match(r'[A-Za-z]+', self.source[self.pos:])
            name = match.group(0)
            self.pos += len(name)
        else:
            name = self.source[self.pos]
            self.pos += 1

        raw_name = name
        name = _ALIASES.get(name, name)
        if raw_name in _REFUSALS:
            self._error('\\%s is not supported — %s'
                        % (raw_name, _REFUSALS[raw_name]))

        if name in SYMBOLS:
            value = SYMBOLS[name]
            if not value:
                # `\!` is a negative thin space: no glyph to set, but mathtext
                # honours the kern, so the command still has to reach it. An
                # empty `row` dropped it on the floor and left `to_mathtext`
                # with nothing to emit for a formula made only of spacing.
                return _node('space', '\\' + name)
            return _node('run', value, name not in _GREEK,
                         '\\' + name)
        if name == 'frac':
            return _node('frac', self._argument(name), self._argument(name))
        if name == 'sqrt':
            index = self._optional_group(name)
            # A childless m:deg displays Office's insertion placeholder inside
            # inline shape math even with degHide. Populate it invisibly while
            # retaining the standard hide property for an ordinary square root.
            if index is None:
                index = _node('run', _INVISIBLE_ARGUMENT, True, '')
                return _node('rad', self._argument(name), index, True)
            return _node('rad', self._argument(name), index, False)
        if name in _NARY:
            # OMML requires populated argument elements; empty m:e/m:sub/m:sup
            # nodes show Office's dotted insertion placeholder even when a Hide
            # property is set. Parse limits first, populate omitted limits with
            # an invisible run, then consume the operand.
            base = _node('nary', _NARY[name], None, None, None)
            scripted = self._scripts(base)
            hidden_sub = scripted[2] is None
            hidden_sup = scripted[3] is None
            sub = scripted[2] or _node('run', _INVISIBLE_ARGUMENT, True, '')
            sup = scripted[3] or _node('run', _INVISIBLE_ARGUMENT, True, '')
            body = self._nary_body(name)
            return _node('nary', scripted[1], sub, sup, body,
                         hidden_sub, hidden_sup, '\\' + name)
        if name == 'arg':
            # \arg only ever names an operator, and always \arg\min / \arg\max.
            operator = self._arg_operator()
            base = _node('run', 'arg ' + operator, True,
                         '\\arg\\' + operator)
            scripted = self._scripts(base)
            return _node('func', scripted, self._function_argument(name))
        if name in _FUNCTIONS:
            # Function application is structural in OMML. Keeping `log` as a
            # plain sibling run looks similar but loses the native function
            # semantics and associates a subscript with the wrong object.
            base = _node('run', name, True, '\\' + name)
            scripted = self._scripts(base)
            return _node('func', scripted, self._function_argument(name))
        if name in ('bar', 'overline'):
            return _node('bar', self._argument(name))
        if name in _ACCENTS:
            return _node('acc', self._argument(name), _ACCENTS[name],
                         '\\' + name)
        if name == 'text':
            value = self._raw_group(name)
            if not value:
                self._error('\\text requires a non-empty argument')
            _check_math_text(value, self)
            return _node('run', value, True, '\\mathrm{%s}' % value)
        if name in _STYLES:
            value = self._required_group(name)
            return _apply_style(value, name)
        if name == 'left' or name in _BIG_LEFT:
            return self._delimited(name)
        if name in _BIG_NEUTRAL:
            return self._lone_delimiter(name)
        if name == 'not':
            return self._negated()
        if name == 'right' or name in _BIG_RIGHT:
            self.pos = start
            self._error('\\%s has no matching opening delimiter' % raw_name)
        if name in ('{', '}'):
            return _node('run', name, True, '\\' + name)
        self._error('unsupported command \\%s' % raw_name)

    def _arg_operator(self):
        """The operator name \\arg qualifies: \\min or \\max."""
        self._spaces()
        match = re.match(r'\\([A-Za-z]+)', self.source[self.pos:])
        if not match or match.group(1) not in _ARG_OPERATORS:
            self._error('\\arg must be followed by \\min or \\max')
        self.pos += len(match.group(0))
        return match.group(1)

    def _lone_delimiter(self, hint):
        """`\\big|` and friends: one delimiter, drawn at its ordinary size."""
        glyph = self._delimiter()
        if not glyph:
            self._error('\\%s needs a delimiter, not \\.' % hint)
        return _node('run', glyph, True, _delimiter_tex(glyph))

    def _negated(self):
        """`\\not` before a relation, as the negated glyph.

        The relation plus a combining solidus, composed (NFC): Unicode has a
        precomposed character for the common negations - `≠ ≰ ∉ ⊄ ≢` - and a
        canonical composition to it, so those ship as the one character
        Cambria Math draws as a designed glyph; the rest (`∝̸`, `⊥̸`) keep
        the overlay. Until 2.1 every negation went out as the overlay pair,
        whose placement is up to PowerPoint's mark positioning. The mathtext
        side keeps `\\not` + the relation, which it composes itself.
        """
        self._spaces()
        if self.pos >= len(self.source):
            self._error('\\not requires a relation after it')
        inner = self._atom()
        if inner is None or inner[0] != 'run' or not inner[1]:
            self._error('\\not applies to one relation, such as \\not\\in')
        # The source has to survive concatenation. `\not` before a bare letter
        # produced `\notx`, an unknown command, and the failure then surfaced
        # from mathtext as `Unknown symbol: \notx` — while the message right
        # here, written for exactly this mistake, never fired. A relation is
        # either a command or one of the three literal signs.
        if not (inner[3].startswith('\\') or inner[3] in ('=', '<', '>')):
            self._error('\\not applies to one relation, such as \\not\\in '
                        'or \\not=, not to %r' % inner[3])
        return _node('run', unicodedata.normalize('NFC', inner[1] + '̸'),
                     inner[2], '\\not' + inner[3])

    def _delimited(self, opener):
        """A \\left...\\right pair, or the \\bigl...\\bigr spelling of one."""
        left = self._delimiter()
        if opener in _BIG_LEFT:
            right_at, closer_len = self._matching_big_right()
        else:
            right_at, closer_len = self._matching_right(self.pos), len('\\right')
        body = self._row_until(right_at)
        if not body[1]:
            self._error('a delimiter pair requires a non-empty body')
        self.pos = right_at + closer_len
        right = self._delimiter()
        return _node('delim', left, right, body)

    def _matching_big_right(self):
        """Position and length of the \\bigr-family closer for this opener.

        The \\bigl family carries no nesting information of its own, so the
        scan counts every opener spelling against every closer spelling.
        """
        depth = 1
        pos = self.pos
        while pos < len(self.source):
            name = _command_at(self.source, pos)
            if name is None:
                pos += 1
                continue
            if name in _OPENER_NAMES:
                depth += 1
            elif name in _CLOSER_NAMES:
                depth -= 1
                if depth == 0:
                    return pos, len(name) + 1
            pos += len(name) + 1
        self._error('an opening delimiter has no matching closer')

    def _matching_right(self, start):
        depth = 1
        pos = start
        while pos < len(self.source):
            # Match whole command names: arrows are not delimiter halves.
            name = _command_at(self.source, pos)
            if name == 'left':
                depth += 1
            elif name == 'right':
                depth -= 1
                if depth == 0:
                    return pos
            pos += len(name) + 1 if name is not None else 1
        self._error('\\left has no matching \\right')

    def _row_until(self, end):
        children = []
        while self.pos < end:
            child = self._atom()
            if child is not None:
                children.append(self._scripts(child))
        if self.pos != end:
            self._error('delimiter body crosses its matching \\right')
        return _node('row', children)

    def _nary_body(self, command):
        """Parse the mandatory OMML operand following an n-ary operator."""
        self._spaces()
        if self.pos >= len(self.source) or self.source[self.pos] == '}':
            self._error('\\%s requires an operand' % command)
        if _at_closer(self.source, self.pos):
            self._error('\\%s requires an operand' % command)
        if self.source[self.pos] == '{':
            return self._group()

        children = []
        while self.pos < len(self.source):
            if self.source[self.pos] == '}' or _at_closer(self.source, self.pos):
                break
            if children and self._at_nary_boundary():
                break
            child = self._atom()
            if child is not None:
                children.append(self._scripts(child))
        if not children:
            self._error('\\%s requires an operand' % command)
        return _node('row', children)

    def _function_argument(self, command):
        """Parse one explicit function argument without swallowing later terms.

        An empty braced group is refused as firmly as a missing argument.
        `m:func` has `m:e` as a *required* argument, and a childless `m:e` is
        not an empty-looking formula — PowerPoint draws a dotted insertion
        placeholder in its place, which is the defect the first production gate
        found in sums and roots. Every other argument path here checks it; this
        one did not, so `\\log{}` and `\\arg\\min{}` parsed clean and shipped a
        placeholder into the slide.
        """
        self._spaces()
        if self.pos >= len(self.source) or self.source[self.pos] == '}':
            self._error('\\%s requires an argument' % command)
        if _at_closer(self.source, self.pos):
            self._error('\\%s requires an argument' % command)
        if self.source[self.pos] == '{':
            value = self._group()
            if not value[1]:
                self._error('\\%s requires a non-empty argument' % command)
            return value
        return self._scripts(self._atom())

    def _at_nary_boundary(self):
        """Whether the current top-level token ends an unbraced n-ary body."""
        if self.source[self.pos] in '+−-=,;<>':
            return True
        if self.source[self.pos] != '\\':
            return False
        match = re.match(r'\\([A-Za-z]+)', self.source[self.pos:])
        return bool(match and match.group(1) in (
            'le', 'leq', 'ge', 'geq', 'neq', 'approx', 'pm', 'mp', 'to',
            'rightarrow', 'leftarrow', 'leftrightarrow'))

    def _delimiter(self):
        self._spaces()
        if self.pos >= len(self.source):
            self._error('missing delimiter')
        if self.source[self.pos] == '\\':
            start = self.pos
            self.pos += 1
            if self.pos < len(self.source) and self.source[self.pos].isalpha():
                match = re.match(r'[A-Za-z]+', self.source[self.pos:])
                self.pos += len(match.group(0))
            else:
                self.pos += 1
            raw = self.source[start:self.pos]
        else:
            raw = self.source[self.pos]
            self.pos += 1
        if raw not in _DELIMITERS:
            self._error('unsupported delimiter %s' % raw)
        return _DELIMITERS[raw]

    def _scripts(self, base):
        sub = sup = None
        while self.pos < len(self.source) and self.source[self.pos] in '^_':
            kind = self.source[self.pos]
            self.pos += 1
            self._spaces()
            if self.pos >= len(self.source):
                self._error('missing script value')
            value = self._script_value()
            if kind == '^':
                if sup is not None:
                    self._error('duplicate superscript')
                sup = value
            else:
                if sub is not None:
                    self._error('duplicate subscript')
                sub = value
        if sub is None and sup is None:
            return base
        if base[0] == 'nary' and len(base) == 5:
            # The half-built n-ary from `_command`: its limits arrive before
            # its operand, so they fold into the node rather than wrap it.
            # A *finished* n-ary falls through and gets wrapped instead —
            # `\sum_{i} {x}^2` reaches here, because the braced operand ends
            # the body before the `^`, and folding would move the script onto
            # the operator and drop the operand on the way (an IndexError in
            # `_emit`, since the folded node is one element short).
            return _node('nary', base[1], sub, sup, base[4])
        return _node('script', base, sub, sup)

    def _spaces(self):
        while self.pos < len(self.source) and self.source[self.pos].isspace():
            self.pos += 1

    def _error(self, message):
        raise FormulaError('%s at column %d in \\(%s\\)'
                           % (message, self.pos + 1, self.source))


# Unicode's Mathematical Alphanumeric Symbols: the codepoint of each style's
# A, its a and its 0, plus the letters Unicode assigned elsewhere long before
# this block existed and therefore left as holes in it. Getting a hole wrong
# yields a reserved codepoint, which renders as a missing glyph rather than an
# error, so the exceptions are listed rather than computed.
_ALPHABETS = {
    'mathbb': (0x1D538, 0x1D552, 0x1D7D8,
               {'C': 'ℂ', 'H': 'ℍ', 'N': 'ℕ', 'P': 'ℙ', 'Q': 'ℚ',
                'R': 'ℝ', 'Z': 'ℤ'}),
    'mathcal': (0x1D49C, 0x1D4B6, None,
                {'B': 'ℬ', 'E': 'ℰ', 'F': 'ℱ', 'H': 'ℋ', 'I': 'ℐ',
                 'L': 'ℒ', 'M': 'ℳ', 'R': 'ℛ',
                 'e': 'ℯ', 'g': 'ℊ', 'o': 'ℴ'}),
    'mathbf': (0x1D400, 0x1D41A, 0x1D7CE, {}),
    'boldsymbol': (0x1D468, 0x1D482, 0x1D7CE, {}),
    'mathsf': (0x1D5A0, 0x1D5BA, 0x1D7E2, {}),
}
# Upright by default; only \mathit and \boldsymbol lean.
_STYLE_ITALIC = frozenset(('mathit', 'boldsymbol'))

# Greek has its own runs in the same Unicode block, and only for the styles
# Unicode actually assigned one — there is no blackboard, script or plain
# sans-serif Greek. Absent here means the letter cannot be set in that style
# and the build says so, the same way `\mathcal` refuses a digit: a style that
# reached the canonical source but not the glyph rendered bold in the PNG
# preview and plain in PowerPoint, which is the disagreement between the two
# adapters that every other table in this module exists to prevent.
#
# `\mathrm` is the plain Greek block, not a Mathematical Alphanumeric run:
# upright Greek is what U+0391/U+03B1 already are.
_GREEK_ALPHABETS = {
    'mathbf': (0x1D6A8, 0x1D6C2),               # upright bold
    'boldsymbol': (0x1D71C, 0x1D736),           # bold italic
    'mathit': (0x1D6E2, 0x1D6FC),               # italic — the default shape
    'mathrm': (0x0391, 0x03B1),
}
# Where the italic Greek that `SYMBOLS` carries starts, per case. Reading a
# letter back to a plain Α/α is the first half of restyling it.
_GREEK_ITALIC_UPPER, _GREEK_ITALIC_LOWER = 0x1D6E2, 0x1D6FC


def _plain_greek(ch):
    """Italic Greek back to the ordinary letter, or None if it is not Greek."""
    code = ord(ch)
    if _GREEK_ITALIC_UPPER <= code <= _GREEK_ITALIC_UPPER + 24:
        return 0x0391 + code - _GREEK_ITALIC_UPPER, True
    if _GREEK_ITALIC_LOWER <= code <= _GREEK_ITALIC_LOWER + 24:
        return 0x03B1 + code - _GREEK_ITALIC_LOWER, False
    if 0x0391 <= code <= 0x03A9:
        return code, True
    if 0x03B1 <= code <= 0x03C9:
        return code, False
    return None


def _styled_greek(ch, style):
    """One Greek letter in `style`, or a refusal naming what is missing."""
    plain = _plain_greek(ch)
    if plain is None:
        return None
    run = _GREEK_ALPHABETS.get(style)
    if run is None:
        raise FormulaError('\\%s has no Greek letters, so %r cannot be set '
                           'that way' % (style, ch))
    code, upper = plain
    base = run[0] if upper else run[1]
    return chr(base + code - (0x0391 if upper else 0x03B1))


def _restyle_char(ch, style):
    """One already-plain character in `style`. Greek, Latin and digits alike.

    The single mapping point. Latin used to go one way, Greek no way at all —
    `\\boldsymbol{\\beta}` wrapped the source and left the glyph italic, so the
    preview drew bold and PowerPoint drew plain.
    """
    greek = _styled_greek(ch, style)
    if greek is not None:
        return greek
    if style in _ALPHABETS:
        return _styled_char(ch, style)
    if style == 'mathit':
        return _math_italic(ch)
    return ch                                   # mathrm: plain is upright


def _styled_char(ch, style):
    upper, lower, digit, specials = _ALPHABETS[style]
    if ch in specials:
        return specials[ch]
    if 'A' <= ch <= 'Z':
        return chr(upper + ord(ch) - ord('A'))
    if 'a' <= ch <= 'z':
        return chr(lower + ord(ch) - ord('a'))
    if '0' <= ch <= '9':
        if digit is None:
            raise FormulaError('\\%s has no digits, so %r cannot be set '
                               'that way' % (style, ch))
        return chr(digit + ord(ch) - ord('0'))
    # An operator or bracket inside a styled group keeps its own glyph, as in
    # TeX. Refusing it here would reject \mathbf{X + Y} for the plus sign.
    return ch


# A style reaches the runs inside these, one child at a time, exactly as TeX
# applies it: `\mathbf{x^2}` bolds the base and the exponent both. Which slots
# of the node hold styleable children is listed here rather than written out
# per branch, because getting one wrong is silent — see `_apply_style`.
_STYLEABLE_SLOTS = {
    'frac': (1, 2),
    'script': (1, 2, 3),        # base, sub, sup — the last two may be None
    'bar': (1,),
    'acc': (1,),
    'delim': (3,),              # 1 and 2 are delimiter glyphs, not nodes
}

# A style an operator name cannot carry. `\mathbf{\log x}` would have to bold
# `\log` itself, and neither consumer takes a styled operator name: mathtext
# rejects `\mathbf{\log}` outright, and OMML's m:func names its operator in
# m:fName where a style is not ours to set. Refused rather than dropped, for
# the reason the module header gives — an approximation of mathematics is
# wrong mathematics, and only the author can say what it should become.
_UNSTYLEABLE = {
    'func': 'a named operator',
    'nary': 'a sum, product or integral',
}


def _apply_style(node, style):
    """Apply an alphabet command to every run beneath `node`.

    Recursive on purpose. This used to return any non-`run` node untouched,
    which made `\\mathbf{x^2}` and `\\boldsymbol{\\hat\\beta}` come out plain
    with no error at all — the author asked for a weight and silently did not
    get one, in a module whose whole rule is to refuse rather than approximate.
    """
    kind = node[0]
    if kind == 'row':
        return _node('row', [_apply_style(child, style) for child in node[1]])
    if kind in _UNSTYLEABLE:
        raise FormulaError(
            '\\%s cannot be applied to %s — style its operand instead'
            % (style, _UNSTYLEABLE[kind]))
    if kind == 'rad':
        # The degree is styled only when the author wrote one. An omitted one
        # is the invisible placeholder run, and wrapping that in the style
        # would put `\%s{}` into the canonical source for no glyph.
        degree = node[2] if node[3] else _apply_style(node[2], style)
        return _node('rad', _apply_style(node[1], style), degree, node[3])
    slots = _STYLEABLE_SLOTS.get(kind)
    if slots is not None:
        parts = list(node)
        for slot in slots:
            if parts[slot] is not None:
                parts[slot] = _apply_style(parts[slot], style)
        return tuple(parts)
    if kind != 'run':
        # `space` is the only one left: a kern carries no glyph to style.
        return node
    # Undo the italic mapping the plain reader applied, then re-map. Styles do
    # not compose in this subset, so the input is always ordinary math italic
    # or an already-upright literal.
    plain = ''.join(_plain_math_char(ch) for ch in node[1])
    mapped = ''.join(_restyle_char(ch, style) for ch in plain)
    # The canonical source wraps the run's *own* source, not the mapped glyph.
    # Reading the glyph back put a raw U+1D6FD into `\boldsymbol{...}`, and
    # mathtext's bold face has no such codepoint: it substituted a dummy glyph
    # and returned successfully, so a formula measured and previewed as a
    # placeholder box while reporting no error at all.
    return _node('run', mapped, style not in _STYLE_ITALIC,
                 '\\%s{%s}' % (style, node[3]))


def _emit(node, parent):
    kind = node[0]
    if kind == 'space':
        return                      # kerning only; no OMML content to write
    if kind == 'row':
        for child in node[1]:
            _emit(child, parent)
        return
    if kind == 'run':
        _emit_run(parent, node[1], node[2])
        return
    if kind == 'frac':
        outer = etree.SubElement(parent, _m('f'))
        _control(outer, 'fPr')
        _emit(node[1], etree.SubElement(outer, _m('num')))
        _emit(node[2], etree.SubElement(outer, _m('den')))
        return
    if kind == 'script':
        sub, sup = node[2], node[3]
        tag = 'sSubSup' if sub is not None and sup is not None else (
            'sSub' if sub is not None else 'sSup')
        outer = etree.SubElement(parent, _m(tag))
        _control(outer, tag + 'Pr')
        _emit(node[1], etree.SubElement(outer, _m('e')))
        if sub is not None:
            _emit(sub, etree.SubElement(outer, _m('sub')))
        if sup is not None:
            _emit(sup, etree.SubElement(outer, _m('sup')))
        return
    if kind == 'rad':
        outer = etree.SubElement(parent, _m('rad'))
        props = etree.SubElement(outer, _m('radPr'))
        if node[3]:
            etree.SubElement(props, _m('degHide')).set(_m('val'), 'on')
        _append_ctrl(props)
        degree = etree.SubElement(outer, _m('deg'))
        _emit(node[2], degree)
        _emit(node[1], etree.SubElement(outer, _m('e')))
        return
    if kind == 'func':
        outer = etree.SubElement(parent, _m('func'))
        _control(outer, 'funcPr')
        _emit(node[1], etree.SubElement(outer, _m('fName')))
        _emit(node[2], etree.SubElement(outer, _m('e')))
        return
    if kind == 'nary':
        outer = etree.SubElement(parent, _m('nary'))
        props = etree.SubElement(outer, _m('naryPr'))
        etree.SubElement(props, _m('chr')).set(_m('val'), node[1])
        # `undOvr` is not inert, contrary to what this comment used to say.
        # PowerPoint honours it for an inline formula in body text: on slide 10
        # of the test deck the measured line descent is 22.6px, where limits
        # beside the operator would give about 13. Changing it moves the line
        # height of every deck that sums anything — see the `nary` branch of
        # `to_mathtext`, which has to stay in step with it.
        etree.SubElement(props, _m('limLoc')).set(_m('val'), 'undOvr')
        if node[5]:
            etree.SubElement(props, _m('subHide')).set(_m('val'), 'on')
        if node[6]:
            etree.SubElement(props, _m('supHide')).set(_m('val'), 'on')
        _append_ctrl(props)
        sub = etree.SubElement(outer, _m('sub'))
        sup = etree.SubElement(outer, _m('sup'))
        _emit(node[2], sub)
        _emit(node[3], sup)
        _emit(node[4], etree.SubElement(outer, _m('e')))
        return
    if kind == 'delim':
        outer = etree.SubElement(parent, _m('d'))
        props = etree.SubElement(outer, _m('dPr'))
        etree.SubElement(props, _m('begChr')).set(_m('val'), node[1])
        etree.SubElement(props, _m('endChr')).set(_m('val'), node[2])
        _append_ctrl(props)
        _emit(node[3], etree.SubElement(outer, _m('e')))
        return
    if kind == 'bar':
        outer = etree.SubElement(parent, _m('bar'))
        props = etree.SubElement(outer, _m('barPr'))
        etree.SubElement(props, _m('pos')).set(_m('val'), 'top')
        _append_ctrl(props)
        _emit(node[1], etree.SubElement(outer, _m('e')))
        return
    if kind == 'acc':
        outer = etree.SubElement(parent, _m('acc'))
        props = etree.SubElement(outer, _m('accPr'))
        etree.SubElement(props, _m('chr')).set(_m('val'), node[2])
        _append_ctrl(props)
        _emit(node[1], etree.SubElement(outer, _m('e')))
        return
    raise FormulaError('internal formula node is unsupported: %s' % kind)


def to_mathtext(node):
    """The same AST as canonical LaTeX for matplotlib's bounded parser.

    The second emitter, beside `_emit`. Before it existed the two consumers
    read the *same raw string* through *different* parsers, kept in step by a
    table of regex substitutions in `textmeasure` — the two-tables-that-agree-
    only-if-you-edit-both seam that `fonts.py` removed in v1.7. mathtext now
    only ever sees a string this function generated, so an alias is taught to
    the parser once and both sides get it: `\\bigl(` and `\\left(` arrive here
    as one node, `\\hat\\tau` comes back braced, and `\\sqrt n` — which
    mathtext rejects for the same reason our parser used to — comes back as
    `\\sqrt{n}`.
    """
    kind = node[0]
    if kind == 'row':
        return ''.join(to_mathtext(child) for child in node[1])
    if kind == 'run':
        return node[3]
    if kind == 'space':
        return node[1]
    if kind == 'frac':
        return '\\frac{%s}{%s}' % (to_mathtext(node[1]), to_mathtext(node[2]))
    if kind == 'script':
        out = '{%s}' % to_mathtext(node[1])
        if node[2] is not None:
            out += '_{%s}' % to_mathtext(node[2])
        if node[3] is not None:
            out += '^{%s}' % to_mathtext(node[3])
        return out
    if kind == 'rad':
        if node[3]:                             # degree hidden: a plain root
            return '\\sqrt{%s}' % to_mathtext(node[1])
        return '\\sqrt[%s]{%s}' % (to_mathtext(node[2]), to_mathtext(node[1]))
    if kind == 'func':
        return '%s{%s}' % (to_mathtext(node[1]), to_mathtext(node[2]))
    if kind == 'nary':
        # Do NOT wrap the operator in braces here, however wrong this looks.
        #
        # `{\sum}_i` demotes the big operator and moves the limits beside it.
        # An earlier note claimed that was the *correct* spelling, on the
        # grounds that PowerPoint draws inline limits beside the operator
        # whatever `limLoc` says. That was wrong, and the crop it rested on was
        # showing `\arg\min_\tau` — a `func` with a subscript, beside in either
        # style. We emit `limLoc="undOvr"` and a desktop export honours it: on
        # slide 10 of the test deck the measured line descent is 22.6px, where
        # limits beside the operator would give about 13.
        #
        # So mathtext's under-limit layout is the one PowerPoint ships, and
        # this line already matches it. What does not match is the *face*:
        # STIX stacks a limit deeper than Cambria Math does, which is why the
        # same bullet still measures 13px out. That is a job for a
        # Cambria-derived extent (the `cambria_extent.py` prototype in the
        # source repository, not shipped here, predicts it to within 3.3px),
        # not for changing the spelling here — demoting measured 18.1px worst
        # error against 13.3px when it was tried.
        out = node[7]
        if not node[5]:                         # subscript not hidden
            out += '_{%s}' % to_mathtext(node[2])
        if not node[6]:
            out += '^{%s}' % to_mathtext(node[3])
        return out + '{%s}' % to_mathtext(node[4])
    if kind == 'delim':
        return '\\left%s %s \\right%s' % (_delimiter_tex(node[1]),
                                          to_mathtext(node[3]),
                                          _delimiter_tex(node[2]))
    if kind == 'bar':
        return '\\overline{%s}' % to_mathtext(node[1])
    if kind == 'acc':
        return '%s{%s}' % (node[3], to_mathtext(node[1]))
    raise FormulaError('internal formula node is unsupported: %s' % kind)


def _delimiter_tex(glyph):
    if glyph not in _DELIMITER_TEX:
        raise FormulaError('internal delimiter is unsupported: %r' % glyph)
    return _DELIMITER_TEX[glyph]


def _emit_run(parent, text, upright):
    run = etree.SubElement(parent, _m('r'))
    if upright:
        # DrawingML's absent/false italic flag does not override math italics.
        props = etree.SubElement(run, _m('rPr'))
        etree.SubElement(props, _m('sty')).set(_m('val'), 'p')
    props = etree.SubElement(run, _a('rPr'))
    if not upright:
        props.set('i', '1')
    value = etree.SubElement(run, _m('t'))
    value.text = text


def _control(parent, name):
    props = etree.SubElement(parent, _m(name))
    _append_ctrl(props)


def _append_ctrl(parent):
    ctrl = etree.SubElement(parent, _m('ctrlPr'))
    etree.SubElement(ctrl, _a('rPr')).set('i', '1')


def _math_italic(ch):
    if 'A' <= ch <= 'Z':
        return chr(0x1D434 + ord(ch) - ord('A'))
    if 'a' <= ch <= 'z':
        if ch == 'h':
            return 'ℎ'
        return chr(0x1D44E + ord(ch) - ord('a'))
    return ch


def _plain_math_char(ch):
    code = ord(ch)
    if 0x1D434 <= code <= 0x1D44D:
        return chr(ord('A') + code - 0x1D434)
    if 0x1D44E <= code <= 0x1D467:
        return chr(ord('a') + code - 0x1D44E)
    if ch == 'ℎ':
        return 'h'
    # Greek too: `SYMBOLS` carries the italic run, and `\mathrm{\alpha}` has
    # to start from an ordinary α or it comes out leaning.
    greek = _plain_greek(ch)
    if greek is not None:
        return chr(greek[0])
    return ch


# ------------------------------------------------------------------ metrics
# Moved from `textmeasure` in 2.1: the layout, the validator and the preview
# measure a formula here, next to the parser whose canonical spelling they
# measure.

class MathRun:
    """An indivisible inline formula; raw LaTeX is never treated as prose.

    Two spellings of one formula, both produced by the parse in `validate`:
    `latex` is the author's source and goes to OMML (`omml` parses it again at
    write time), `mathtext` is the canonical form `to_mathtext` emitted and is
    what every measurement and the PNG raster read.
    """

    __slots__ = ('latex', 'mathtext', 'weight')

    def __init__(self, latex, mathtext, weight):
        self.latex = latex
        self.mathtext = mathtext
        self.weight = weight

    def __repr__(self):
        return 'MathRun(%r, %s)' % (self.latex, self.weight)


# Cambria Math is an Office/system face unavailable on the build machine. The
# preview uses mathtext's STIX metrics, so reserve space rather than risk that a
# line accepted here becomes wider in PowerPoint. The raster is centred inside
# this advance by preview.py; both adapters therefore share the same geometry.
# How much room a formula gets beyond what mathtext measured, on each axis.
#
# We measure with mathtext (STIX) and ship OMML that PowerPoint sets in Cambria
# Math. Different faces, so the measurement is an estimate and these are the
# margin on it. v1.8 shipped 1.08 on width, guessed, and nothing at all on
# height — which meant vertical overflow was invisible to every gate at once,
# because autofit, the validator and the preview all read the same wrong
# number. The preview cannot see either error: it is drawn from the same
# metrics.
#
# Calibrated, not guessed, by `calibrate_math.py` — a development tool in the
# source repository under `tmp_files/tools/`, which does not ship inside this
# package. The numbers below are the result; the tool is how to redo it.
#   renders  the AIPW formula on slide 12 of the v1.7.0 test deck, ink extent
#            in our PNG against the author's PowerPoint export of the same
#            slide — x1.171 wide, x1.143 tall. This is the number that counts:
#            it sees fraction gaps and n-ary sizing, not just glyphs.
#   glyphs   Cambria Math against STIX, advance and ink height over 103
#            characters — p90 x1.127 and x1.086. Consistent with the above,
#            and lower, as it should be: layout adds on top of glyph metrics.
#
# Rounded up a little from the measured pair. Trust them as far as the type
# ceilings: best evidence, one sample, no PowerPoint renderer on this machine
# to widen it. Re-measure with the tool if a new export becomes available.
MATH_WIDTH_FACTOR = 1.20
MATH_HEIGHT_FACTOR = 1.16

# The floor a math object puts under its line, in em of the body size.
#
# A line carrying an inline `<a14:m>` is set by PowerPoint with *two* faces on
# it, and the line's descent is the deeper of the two. Cambria Math's own line
# descent is 0.2222 em (typo descender) + 0.1724 em (typo line gap) = 0.3946 em,
# against T-Sans's 0.318 em — so even a formula whose ink never reaches the
# baseline reserves 0.077 em more room under it, about 2.6px at 34px type.
#
# Mind the direction, it is the reverse of what "deeper descent" suggests. The
# line box is fixed and `baseline_offset` is `line_box - descent`, so a deeper
# descent moves the baseline *up* inside the box, and the marker with it. That
# is the direction the export calls for: the marker was sitting 1.8-2.6px
# *below* the cap midline of the text PowerPoint had actually set, i.e. our
# baseline was too low, on fourteen bullets across three slides — one
# direction, one magnitude. Implied descent 13.07px at 34px type against the
# 13.42px this constant gives; the 0.35px gap is inside the antialiasing bias
# of reading a cap-top off a PNG.
#
# It is gated on the line actually holding a MathRun, because that is the run
# that brings the second face with it. A formula-free line keeps T-Sans's own
# descent and its marker does not move.
MATH_LINE_DESCENT_EM = 0.3946
_MATH_CACHE = {}

# The math face is pinned rather than inherited. Before v1.8.1 nothing set it,
# so the metrics of every formula in every deck came from whatever
# `mathtext.fontset` the ambient matplotlib configuration happened to hold —
# `dejavusans` by default, a *sans* face, while PowerPoint sets the same OMML
# in serif Cambria Math. Two costs, and the first is the serious one: a skill
# whose output depends on what is installed beside it produces different decks
# in different places (see AGENTS.md, the fontTools trap). The second is that
# the PNG preview showed a different typeface from the file it was evidence
# about. `stix` is the closest of matplotlib's built-in sets to Cambria Math.
_MATHTEXT_RC = {'mathtext.fontset': 'stix', 'mathtext.default': 'it'}


class _MathtextGlyphError(Exception):
    """A glyph mathtext substituted rather than drew. See math_metrics."""


class _GlyphLogCatcher(logging.Handler):
    """Collects matplotlib's missing-glyph log lines during one parse."""

    def __init__(self):
        logging.Handler.__init__(self, level=logging.WARNING)
        self.missing = []

    def emit(self, record):
        try:
            message = record.getMessage()
        except Exception:                          # noqa: BLE001
            return
        if 'does not have a glyph' in message:
            self.missing.append(message)


MathMetrics = collections.namedtuple(
    'MathMetrics',
    'advance ascent descent alpha raw_ascent raw_descent')


def math_metrics(source, size_px, weight=400):
    """Mathtext metrics for one formula, in deck pixels.

    `source` is the canonical spelling from `formula.to_mathtext`, never the
    author's raw LaTeX: matplotlib's parser and ours accept different
    spellings of the same construct, and reconciling them here — as a table of
    regex substitutions, which is what this module used to hold — put the
    supported set in two places at once.

    `ascent`/`descent` carry the reserve and size the line box. `raw_ascent`/
    `raw_descent` are what mathtext actually measured, and the preview draws
    its raster against those: reserve is padding around the glyph, not a move.
    Inflating the position instead would lift the ink off the shared baseline
    and make the preview disagree with itself.
    """
    weight = normalize_weight(weight)
    key = (source, round(float(size_px), 2), weight)
    cached = _MATH_CACHE.get(key)
    if cached is not None:
        return cached

    import matplotlib
    from matplotlib.font_manager import FontProperties
    from matplotlib.mathtext import MathTextParser

    prop = FontProperties(size=float(size_px) * 0.75,
                          weight='bold' if weight >= 600 else 'normal')
    try:
        # A missing glyph is neither an exception nor a warning in matplotlib:
        # it is a line on matplotlib's own *logger*, after which the parse
        # returns metrics for a dummy box. So a formula would measure,
        # validate and preview as a placeholder while the build reported
        # nothing — the same silent-wrong-output shape as the fontTools trap.
        # Promoted to an error here, where both consumers already have to
        # agree. It is a log record and not a warning, which is why capturing
        # `warnings` caught nothing.
        catcher = _GlyphLogCatcher()
        mpl_log = logging.getLogger('matplotlib')
        # Force the level and stop propagation for the duration. Adding a
        # handler is not enough: matplotlib's logger has no level of its own,
        # so it inherits the root's, and any caller that configures logging
        # above WARNING — `selftest.py` sets ERROR, and so would any quiet
        # CLI — drops the record before a handler ever sees it. That would
        # have switched this guard off in exactly the runs that are least
        # watched. Propagation is off so the borrowed level does not turn
        # matplotlib's chatter into console noise.
        saved_level, saved_propagate = mpl_log.level, mpl_log.propagate
        mpl_log.setLevel(logging.WARNING)
        mpl_log.propagate = False
        mpl_log.addHandler(catcher)
        try:
            with matplotlib.rc_context(_MATHTEXT_RC):
                parsed = MathTextParser('agg').parse('$%s$' % source, dpi=96,
                                                     prop=prop)
        finally:
            mpl_log.removeHandler(catcher)
            mpl_log.setLevel(saved_level)
            mpl_log.propagate = saved_propagate
        if catcher.missing:
            raise _MathtextGlyphError(catcher.missing[0])
    except Exception as exc:
        raise FormulaError('mathtext cannot render %r: %s' % (source, exc))
    alpha = np.asarray(parsed.image).copy()
    raw_ascent = float(parsed.height) - float(parsed.depth)
    raw_descent = float(parsed.depth)
    result = MathMetrics(
        advance=float(parsed.width) * MATH_WIDTH_FACTOR,
        ascent=raw_ascent * MATH_HEIGHT_FACTOR,
        descent=raw_descent * MATH_HEIGHT_FACTOR,
        alpha=alpha,
        raw_ascent=raw_ascent,
        raw_descent=raw_descent)
    _MATH_CACHE[key] = result
    return result


def math_width(source, size_px, weight=400):
    return math_metrics(source, size_px, weight).advance
