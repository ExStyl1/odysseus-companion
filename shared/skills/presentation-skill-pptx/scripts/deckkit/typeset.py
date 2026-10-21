# -*- coding: utf-8 -*-
"""Non-breaking spaces where Russian typography wants them.

The line breaker (`html2pptx/textmeasure.wrap_runs`) breaks at every ASCII
space and at nothing else, so an author's «4,5 млн ₽» can come out as «4,5»
at the end of one line and «млн ₽» at the start of the next, «25 000» can
split between its digit groups, and a dash can open a line. Writers do not
type U+00A0 — ten test decks written by agents held none at all, against 13
number-and-unit pairs and 169 spaced dashes — so the fix is here, applied to
the text as it goes into the HTML, and not in the spec or in an instruction.

The spec is left as written: this is output typography, the way a word
processor does it. NBSP needs nothing from the engine: the font has the glyph,
the measurer reads its advance, and the wrapper already treats it as part of
a word, so the size search and the validator see the glued group as one unit.

Short words («в», «на», «не») are glued to the word after them everywhere
since 2.3.0 (the designers: «неразрывные пробелы везде»). Until then only the
`statement` had it (2.1.1): on the closing slide, at 168 px in a 1014 px
column, «за внимание!» became one word too wide for its line and a deck that
built before stopped. That was the size search, not the glue: it checked a
headline's width only inside a fit-box, so it never stepped down
(`fit.headline_fits`). Measured on 55 saved decks, the closing slide was the
only place a glued group outgrew its line.
"""
import re

NBSP = '\u00a0'

# Digit groups of one number: «25 000», «1 200 000». The first group is one to
# three digits, so «в 2024 100 клиентов» (a year, then a count) is left alone.
_GROUPED_NUMBER = re.compile(r'(?<![\d,.])\d{1,3}(?: \d{3})+(?!\d)')

# A unit written after a number. The negative lookahead keeps «5 минут» from
# matching «мин» and «3 часа» from matching «ч».
_UNIT_AFTER_NUMBER = re.compile(
    r'(?<=\d) (?='
    r'(?:млн|млрд|трлн|тыс|руб|коп|п\.\s?п\.|б\.\s?п\.|мин|сек|ч|дн|дня|дней'
    r'|нед|мес|лет|год|года|шт|раз|раза|чел)'
    r'(?![А-Яа-яЁёA-Za-z]))')

# A currency or percent sign sticks to whatever precedes it, which covers both
# «15 %» and the second space of «4,5 млн ₽».
_BEFORE_SIGN = re.compile(r' (?=[₽$€%‰](?![А-Яа-яЁёA-Za-z\d]))')

# «п. п.», «б. п.» written with a space inside the abbreviation.
_INSIDE_POINTS = re.compile(r'(?<=[пб]\.) (?=п\.)')

# «№ 5»
_NUMERO = re.compile(r'№ (?=\d)')

# A dash does not open a line: the space before it is glued, the one after is
# not. Covers the en dash used as a dash; a range like «5–7» has no spaces.
_BEFORE_DASH = re.compile(r' (?=[—–] )')

# «2024 г.», «2023–2024 гг.»: the year keeps its «г.».
_YEAR = re.compile(r'(?<=\d) (?=гг?\.)')

# Initials stay with each other and with the surname, either way round:
# «А. С. Пушкин», «Пушкин А. С.». An initial is a lone capital and a dot, so
# «США. Далее» (a word before the dot) is left alone.
_INITIAL_BEFORE = re.compile(r'(?<![\w.])([А-ЯЁA-Z]\.) (?=[А-ЯЁA-Z])')
_SURNAME_BEFORE = re.compile(r'(?<=[а-яёa-z]) (?=[А-ЯЁA-Z]\.(?![\w]))')

# Prepositions, conjunctions and «не»/«ни» that must not end a line. Closed,
# like the unit list: «ИИ», «ML», «я» are not in it. Postpositive particles
# («же», «ли», «бы») lean on the word before them and are left alone. A chain
# glues whole: «и не в объёме» is one unit.
_SHORT_WORD = re.compile(
    r'(?<![\w-])(?:а|в|во|да|до|за|и|из|к|ко|на|не|ни|но|о|об|обо|от|по|с|со'
    r'|у) (?=\S)', re.IGNORECASE)

# Longer prepositions belong with their following word in screenshot
# headlines. Keep this policy opt-in: global prose still uses _SHORT_WORD.
HEADLINE_CONNECTORS = frozenset(('для', 'без', 'при', 'под', 'над', 'через',
                                 'перед', 'между', 'после', 'около', 'вокруг',
                                 'против', 'ради', 'или', 'либо'))
_HEADLINE_WORD = re.compile(
    r'(?<![\w-])(?:%s) (?=\S)' % '|'.join(sorted(HEADLINE_CONNECTORS)),
    re.IGNORECASE)


def glue_headline(text):
    """Opt-in connector glue, without changing the spec or global prose."""
    if not text:
        return text
    text = typeset(text)
    return _HEADLINE_WORD.sub(lambda match: match.group(0)[:-1] + NBSP, text)


def typeset(text):
    """`text` with the spaces that must not break replaced by U+00A0."""
    if not text or ' ' not in text:
        return text
    text = _GROUPED_NUMBER.sub(lambda m: m.group(0).replace(' ', NBSP), text)
    text = _UNIT_AFTER_NUMBER.sub(NBSP, text)
    text = _BEFORE_SIGN.sub(NBSP, text)
    text = _INSIDE_POINTS.sub(NBSP, text)
    text = _NUMERO.sub('№' + NBSP, text)
    text = _BEFORE_DASH.sub(NBSP, text)
    text = _YEAR.sub(NBSP, text)
    text = _INITIAL_BEFORE.sub(lambda m: m.group(1) + NBSP, text)
    text = _SURNAME_BEFORE.sub(NBSP, text)
    return _SHORT_WORD.sub(lambda m: m.group(0)[:-1] + NBSP, text)
