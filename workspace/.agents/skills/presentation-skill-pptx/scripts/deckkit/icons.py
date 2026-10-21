# -*- coding: utf-8 -*-
"""Icon matching by meaning.

Presentation authors write 'growth' or 'security', not a PNG filename. This is
the only way to guarantee the link is not broken: the skill template had
`target.png` and `layers.png` that never existed.

Three layers, in order of decreasing accuracy:

1. `assets/icons/CONCEPTS.json` — business concept → ordered list of files.
   Created because index keywords describe objects ('map', 'ruble', 'checkmark'),
   while presentations are written in abstractions: out of 30 common business
   words, 15 found nothing at all, and the agent, after trying synonyms,
   returned to a word already used — along with its icon.
   The list is ordered: `IconAllocator` takes the next option when the first
   is already taken on a slide, so positions 2+ must be usable, not padding.
2. `assets/icons/INDEX.json` — search by `file`, `category`, `keywords`.
3. Morphology: matching by truncated stem.

**Morphology works additively only.** The query is first compared as-is,
then by stem with lower weight. Otherwise regression occurs: stemming was
applied to the query but not keywords, and words became unreachable — 50 out
of 754 keywords became unreachable, meaning words that were found before
morphology appeared stopped being found.
"""
import difflib
import json
import os
import re

from .model import IconNotFound

# Suffixes that are stripped when matching by stem. Order is set by length
# (computed once at module load, not on every call).
_SUFFIXES = tuple(sorted((
    # nouns: cases and number
    'иями', 'ями', 'ами', 'иях', 'иям', 'ии', 'ов', 'ев', 'ей', 'ий', 'ия', 'ию',
    'ие', 'ом', 'ам', 'ах', 'ья', 'ье',
    # verbal nouns
    'ениями', 'ениях', 'ениям', 'ением', 'ений', 'ения', 'ению', 'ении',
    'ение', 'аниями', 'аниях', 'аниям', 'анием', 'аний', 'ания', 'анию',
    'ании', 'ание',
    # quality and property
    'остями', 'остях', 'остям', 'остью', 'остей', 'ости', 'ость',
    'ствами', 'ствах', 'ством', 'ства', 'ству', 'стве', 'ство',
    # adjectives
    'ическими', 'ический', 'ическая', 'ическое', 'ические',
    'ными', 'ного', 'ному', 'ная', 'ное', 'ные', 'ных', 'ном', 'ный', 'ной',
    'ную', 'кими', 'кого', 'кому', 'кая', 'кое', 'кие', 'ких', 'ком', 'кий',
    'кой', 'кую', 'ский', 'ская', 'ское', 'ские', 'ских', 'скими',
    # verbs
    'ировать', 'ируем', 'ирует', 'ируют', 'овать', 'ать', 'ять', 'ить',
    'еть', 'уть', 'ает', 'ают', 'яет', 'яют', 'ил', 'ила', 'или', 'ал',
    'ала', 'али',
    # short suffixes — last, the remaining stem length guards them
    'ими', 'ыми', 'ть', 'ти', 'ая', 'ое', 'ые', 'ых', 'ым', 'ий', 'ой', 'ый',
    'а', 'е', 'и', 'о', 'у', 'ы', 'я', 'ь', 'й',
), key=len, reverse=True))

# Do not cut the stem shorter than this: 'риск' should not become 'рис'.
_MIN_STEM = 4


def _normalize(text):
    """Unified word form for comparison.

    The index has 'ё' but queries almost always come with 'е' — without this
    normalization half the queries would not be found for no reason.
    """
    return (text or '').lower().replace('ё', 'е')


def _stem(word):
    """Word stem: strips one known suffix.

    Result is a service key for matching, not a grammatically correct form.
    Always returned, even if nothing was stripped, so stem comparison is
    never empty.
    """
    word = _normalize(word)
    for suffix in _SUFFIXES:
        if word.endswith(suffix) and len(word) - len(suffix) >= _MIN_STEM:
            return word[:-len(suffix)]
    return word


def _tokens(text):
    """Query words as they came.

    No stemming: stems are counted separately and only add matches.
    """
    return [t for t in re.split(r'[^\w-]+', _normalize(text)) if t]


def _with_png(name):
    """`speedometer` → `speedometer.png`. In CONCEPTS.json names have no extension."""
    return name if name.lower().endswith('.png') else name + '.png'


class IconLibrary(object):
    def __init__(self, index_path, concepts_path=None):
        self.index_path = index_path
        with open(index_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        entries = data['icons'] if isinstance(data, dict) else data
        self.entries = []
        for entry in entries:
            keywords = entry.get('keywords', [])
            name = _normalize(entry['file'].rsplit('.', 1)[0])
            # Normalized forms are computed once at load: otherwise every
            # query would iterate 355 icons with all their keywords again.
            self.entries.append({
                'file': entry['file'],
                'category': entry.get('category', ''),
                'keywords': keywords,
                '_kw': [_normalize(k) for k in keywords],
                '_kw_stems': [_stem(k) for k in keywords],
                '_name': name,
                '_parts': name.split('-'),
            })
        self._by_file = dict((e['file'], e) for e in self.entries)
        self._cache = {}

        # Concept layer: concept → ordered list of files.
        self._concepts = {}
        if concepts_path and os.path.exists(concepts_path):
            with open(concepts_path, 'r', encoding='utf-8') as f:
                raw = json.load(f)
            source = raw.get('concepts') or raw.get('концепты') or {}
            for concept, files in source.items():
                # Extension is added here, not by the consumer. Otherwise
                # `resolve` returns 'speedometer', the path in markup comes out
                # without extension, and the fact that the icon still reaches
                # the file depends on chance: `resolve` is called a second time
                # and the 'exact filename' branch fires.
                self._concepts[_normalize(concept)] = [_with_png(f) for f in files]
        # Concept stem → concept. First occurrence wins, so result does not
        # depend on dictionary traversal order.
        self._concept_stems = {}
        for concept in self._concepts:
            self._concept_stems.setdefault(_stem(concept), concept)

    def __len__(self):
        return len(self.entries)

    @property
    def concepts(self):
        return dict(self._concepts)

    def search(self, query, limit=5):
        """Icons sorted by proximity to query."""
        wanted = _tokens(query)
        if not wanted:
            return []
        scored = []
        for entry in self.entries:
            keywords = entry['_kw']
            parts = entry['_parts']
            score = 0
            for word in wanted:
                # First the word as-is — this block exactly replicates behavior
                # before morphology appeared, so no query that was found before
                # can stop being found.
                if word in keywords:
                    # Keyword order matters: the first describes the icon's essence,
                    # then nuances follow. Otherwise 'lightning' picks the battery
                    # with lightning, and 'checkmark' picks the bell with checkmark.
                    score += max(6, 14 - keywords.index(word) * 2)
                elif word in parts:
                    score += 8
                elif any(word in k for k in keywords):
                    score += 4
                elif word in entry['_name']:
                    score += 3
                elif word == entry['category'].lower():
                    score += 2
                else:
                    # And only now — by stem, weaker than any exact match,
                    # so as not to override ranking.
                    stem = _stem(word)
                    stems = entry['_kw_stems']
                    if stem in stems:
                        score += max(3, 7 - stems.index(stem))
                    elif stem in parts or any(stem == _stem(p) for p in parts):
                        score += 3
            if not score:
                continue
            # Simple name preferred over compound: `flash` beats
            # `battery-flash`, `doc` beats `doc-arrow-down`.
            score -= len(parts) - 1
            scored.append((score, len(parts), entry['file'], entry))
        scored.sort(key=lambda item: (-item[0], item[1], item[2]))
        return [entry for _, _, _, entry in scored[:limit]]

    def candidates(self, query, limit=15):
        """Ordered options for query: concept, then search.

        One source of truth for both `resolve` and `IconAllocator` — otherwise
        they diverge on what counts as the 'next best' option.
        """
        out = []
        seen = set()
        for name in self._resolve_concept(query) or []:
            if name not in seen:
                seen.add(name)
                out.append(name)
        # Search is always added, not only when there is no concept: on a slide
        # with eight cards, five concept options are not enough, and without
        # this continuation the allocator starts repeating icons.
        for entry in self.search(query, limit=limit):
            if entry['file'] not in seen:
                seen.add(entry['file'])
                out.append(entry['file'])
        return out

    def resolve(self, query, exclude_files=None):
        """Query → filename. Does not invent: if not found — exception.

        `exclude_files` skips already taken icons and takes the next by rating.
        The result depends on the argument, so cache is not used in such a call
        — neither for reading nor writing — otherwise the first call would
        remember the answer, and the next with a different set of exclusions
        would get the same one.
        """
        if not query:
            return None
        exclude = set(exclude_files or [])
        if not exclude:
            cached = self._cache.get(query)
            if cached:
                return cached

        # Also allow exact filename: sometimes the author copies it from the reference.
        if query in self._by_file:
            resolved = query
        elif (query + '.png') in self._by_file:
            resolved = query + '.png'
        else:
            options = self.candidates(query)
            if not options:
                raise IconNotFound(self._not_found_message(query))
            free = [name for name in options if name not in exclude]
            # All taken — return the best option. Repeat will be caught by
            # DUPLICATE_ICON in validate.py, that's its purpose.
            resolved = free[0] if free else options[0]

        if not exclude:
            self._cache[query] = resolved
        return resolved

    def _not_found_message(self, query):
        """Message that makes it clear what to do next.

        Previously on a complete miss it remained 'no icon matched X among 355
        icons' — and the spec author had nothing to do with it but blindly
        try synonyms. That very trial and error led to using a word already
        used on a neighboring slide, along with its icon.
        """
        parts = ['no icon matched %r among %d icons' % (query, len(self.entries))]
        first = _tokens(query)[0] if _tokens(query) else ''
        near = [e['file'] for e in self.search(first, limit=5)] if first else []
        if near:
            parts.append('near matches: ' + ', '.join(near))
        if self._concepts:
            close = difflib.get_close_matches(
                _normalize(query), list(self._concepts), n=4, cutoff=0.6)
            if close:
                parts.append('close concepts: ' + ', '.join(close))
            else:
                parts.append('run "scripts/find_icon.py --concepts" for the '
                             '%d business concepts that are covered'
                             % len(self._concepts))
        return ' - '.join(parts)

    def _resolve_concept(self, query):
        """List of files for a concept, or None if not a concept."""
        if not self._concepts:
            return None
        normalized = _normalize(query)
        if normalized in self._concepts:
            return self._concepts[normalized]
        concept = self._concept_stems.get(_stem(query))
        if concept:
            return self._concepts[concept]
        return None

    def concept_icons(self, concept, limit=5):
        """Ordered files for a concept; empty list if none."""
        return (self._resolve_concept(concept) or [])[:limit]

    def has_concept(self, concept):
        return self._resolve_concept(concept) is not None

    def categories(self):
        return sorted(set(e['category'] for e in self.entries if e['category']))


def default_index_path(skill_dir):
    return os.path.join(skill_dir, 'assets', 'icons', 'INDEX.json')


def default_concepts_path(skill_dir):
    return os.path.join(skill_dir, 'assets', 'icons', 'CONCEPTS.json')


class IconAllocator(object):
    """Icon selection with awareness of the whole deck.

    Icons do not repeat within a slide: a query whose best option is already
    taken goes down the candidate list. Thus a duplicate becomes impossible,
    not just caught by a check — the instruction 'do not repeat icons'
    worked exactly here and did not fire.

    Repetition between slides is allowed: `begin_slide` resets what is taken,
    and overusing one icon across the deck is caught by REPEATED_ICON.
    """

    def __init__(self, library):
        self.library = library
        self._used_in_slide = set()
        self._used_in_deck = {}

    def begin_slide(self):
        """Start a new slide: reset what is taken."""
        self._used_in_slide = set()

    def allocate(self, query):
        """Icon for query, not yet taken on current slide."""
        if not query:
            return None
        chosen = self.library.resolve(query, exclude_files=self._used_in_slide)
        self._used_in_slide.add(chosen)
        self._used_in_deck[chosen] = self._used_in_deck.get(chosen, 0) + 1
        return chosen

    def used_in_deck(self, icon_file):
        return self._used_in_deck.get(icon_file, 0)

    def get_deck_usage(self):
        return dict(self._used_in_deck)
