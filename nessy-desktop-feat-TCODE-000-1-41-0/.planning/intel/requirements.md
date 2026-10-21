# Requirements (from PRD-classified docs)

**No entries. Absent, not omitted.**

Zero of the 37 ingested documents were classified `PRD`. The manifest
(`.planning/ingest-manifest.yaml`) assigns every document one of `ADR` (11),
`SPEC` (20) or `DOC` (6), and every classification in
`.planning/intel/classifications/` carries `manifest_override: true`, so no
heuristic could have produced a PRD either. This is unchanged from the first
synthesis run; the cycle waiver released 11 documents and none of them is a PRD.

Consequences for downstream consumers:

- There is no product-requirement source in this ingest set. Requirements for
  `REQUIREMENTS.md` must come from the user or from a later ingest that
  includes PRD-typed documents.
- No competing acceptance variants exist, because no acceptance criteria were
  ingested at all. The `competing-variants` bucket in
  `.planning/INGEST-CONFLICTS.md` therefore carries no PRD entries.
- Do not synthesize requirements from `.planning/intel/constraints.md`. Those
  entries are SPEC-derived conformance and defect records against an external
  contract (Claude Code's documentation), not statements of what this product
  must do for a user.
- The closest thing to a requirement backlog in this set is the plan slicing in
  `docs/superpowers/specs/2026-08-02-claude-doc-sweep-worklist.md` (46 units,
  each with a "what the user gets" sentence). It is recorded under
  `constraints.md`, and INFO-9 in the conflicts report explains why its 124
  findings must not be read as 124 open items.
