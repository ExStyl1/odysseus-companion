# Inspect the final delivery

After building, run `python3 scripts/check_delivery.py deck.json deck.pptx`.
It reads both files and emits a JSON report on stdout; redirect that output to a
report beside the deck if needed. Exit 0 means the inspected counts and title
checks passed, 1 means an artifact mismatch, 2 means unreadable/invalid input.
Run the normal spec/build checks first: this does not repeat schema validation.

The inspector follows the presentation's slide relationship order. It compares
slide counts, checks title presence after whitespace normalization, and compares
explicit formula runs in supported body fields with native OMML counts **on
each slide**. The heading is read from the field the layout uses: `text` on
`title`, `statement` and `final` slides, `name` on `self-intro`, `title`
elsewhere. A `final` slide without `text` and a `versus` slide have no heading
to check. The existing layout registry determines eligible fields; speaker
notes and plain numbers, prices and arithmetic are not equation requirements.
No extra annotations or second build input are required.

A pass does not prove mathematical equivalence or correct formula placement
within a slide. Equal counts can hide substituted equations; repeated titles
can hide reordered slides. Reconcile expressions and adjacent prose against the
source and the user's intended equations during review. Intent absent from the
spec cannot be inferred by this script.

Positive picture crop rectangles produce advisory `PICTURE_CROP` findings.
Decorative pictures are included: retain intentional crops with a reason and
inspect substantive diagrams for missing labels/arrows. Other clipping is not
excluded by a clean crop report. Existing build warnings still require review.

`review_slides` includes equation, picture, native chart/table slides, findings,
deck boundaries and the first occurrence of each public layout. Pictures include
icons/backgrounds, so this conservative list may cover most or all of a deck.
Use these original slide numbers with `scripts/preview_deck.py`; inspect a
contact sheet of every slide for large technical decks and the selected slides
at readable size. Record actual coverage and unresolved findings. This report
contains neither PNG inspection nor native PowerPoint verification. Preserve
the generated PPTX and inspect native export from a scratch copy when available.
