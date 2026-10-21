# -*- coding: utf-8 -*-
"""PPTX presentation build strictly within the template.

Content is described by data; markup comes from the skill's reference layouts
(`assets/layouts/`) and is filled in. There are no CSS classes, coordinates,
or icon filenames in the data — there is no way to go outside the template.

Entry point is `scripts/build_deck.py` and a JSON spec file. This package is
the internal implementation: spec parsing in `spec.py`, field checks in `schema.py`, deck assembly in
`deck.py`, validation in `validate.py`, HTML and PPTX emission in `build.py`.
"""
from .model import (BuildError, Card, ChartData, ChartDataError, FormulaError,
                    IconNotFound, Issue, MediaError, Metric, Series, SpecError)
from .deck import Deck
from .spec import deck_from_spec, load_spec

__all__ = ['Deck', 'Card', 'Metric', 'Issue', 'BuildError', 'IconNotFound',
           'SpecError', 'ChartData', 'ChartDataError', 'FormulaError', 'Series',
           'MediaError', 'load_spec', 'deck_from_spec']
