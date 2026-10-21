# Skills navigation and advertising removal, 2026-10-21

Local source build 1.42.1-odysseus.6; no signed packaging or CDP pass claimed.

53 advertising/marketing skills were removed from shared/skills, catalog, active lock entries and selection policy. Recovery copies are kept in .odysseus/removed-marketing-20261021; they are outside runtime discovery. Shared projections are removed through the existing conflict-aware profile sync. Import provenance and original full skill resources remain in the recovery directory. The active shared catalog has 220 skills, including 132 eligible for automatic invocation; the UI adds 27 native agent entries for 247 unique skills.

Skills home displays the role catalog without the native left navigator. Exact native skill detail routes retain the original detail and list panels. PluginsPage is restored to the existing management entry point. The skills sidebar count follows the common UI catalog.

Verification results follow below.

- Root suite: 53 passed. Native focused suite: 30 passed across catalog, navigation reconciliation and navigation history. Installer replay tests passed after the final navigation change.
- Final Electron typecheck and renderer build passed; locale parity/sorting and asset copy passed. No browser-externalized Node warnings.
- Profile sync confirmed 3660 active resources with zero pending changes. Excluded projected SKILL.md files are absent; empty directories were pruned without touching remaining files.
- Native UI confirmed Plugins opens the original management view. The existing external marketplace request returns fetch failed on this network; no package install/uninstall operation was attempted there, and no installed plugin registry was present.
- Native UI plus screenshot confirmed clicking Sources/Skills opens the full-width catalog on the skills route, with 247 entries and four role tabs (General 108, QA 22, DEV 124, SA 21). Fixed the old first-skill auto-selection so the catalog home remains reachable. Exact skill detail URLs still open details.
