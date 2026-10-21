# Third-party assets shipped with this skill

`license: proprietary` in `SKILL.md` covers the skill itself. The binary
assets below travel inside the package and carry their own terms.

## Fonts — `assets/fonts/T-Sans_2026_TTF/`

Three faces of T-Sans: Regular, Medium (weight 500), Bold. Version 1.002.
Their own `name` table states:

> Copyright (c) 2025 JSC TBank. All rights reserved.
> T-Sans is a registered trademark of JSC TBank.
> This typeface is the sole property of JSC TBank must not be used by anyone
> outside IPJSC T-TECHNOLOGIES Group.

**Internal use only.** A deck built by this skill must not be redistributed
outside the group with the fonts embedded in it.

Embedding is permitted by the fonts themselves: `OS/2 fsType` is `0x0000`
(installable embedding) on all three files. `scripts/deckkit/html2pptx/
font_embed.py` checks that flag and writes the faces into the `.pptx`, because
the name "T-Sans Medium" is not resolved by every reader and weight 500
otherwise draws as regular.

## Icons — `assets/icons/icons.zip`

355 raster icons, one PNG per member, indexed by `INDEX.json` and reached by
meaning through `CONCEPTS.json`. They are read at build time and drawn into
the deck; the archive itself is never unpacked to disk beyond the single
member being placed.

**Provenance is not recorded in this repository.** Before publishing outside
the group, confirm with the design team which set this is and under what terms
it may be redistributed, and replace this paragraph with the answer.

## Backgrounds and patterns — `assets/images/`

Exported from the corporate template's Figma source. Same terms as the
template: internal use.
