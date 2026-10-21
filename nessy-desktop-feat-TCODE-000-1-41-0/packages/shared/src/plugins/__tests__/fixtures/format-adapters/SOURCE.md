# Fixture source references

The fixtures under `fixtures/format-adapters/` and `fixtures/catalog-adapters/`
are modeled on the documented external plugin/marketplace formats described at:

- Codex plugin structure and bundled capabilities:
  https://learn.chatgpt.com/docs/build-plugins
- Codex product overview:
  https://help.openai.com/en/articles/20001256-plugins-in-codex/
  (bot-blocked, HTTP 403 — kept only because it is the URL the format was
  originally attributed to. It is NOT where the contract lives.)

The Codex format's actual specification, found 2026-07-29 (R16). Every page has
a Markdown twin at `<url>.md`; fetch that with `curl`:

- Codex plugin manifest, file layout and path rules:
  https://developers.openai.com/plugins/build/plugins
- Codex plugin-bundled hooks, handler fields and event schema:
  https://learn.chatgpt.com/docs/hooks
- Codex field-level validation contract (per-field types, limits, and the
  warnings naming what the loader ignores):
  https://developers.openai.com/plugins/deploy/submission-errors
- Claude plugin reference:
  https://code.claude.com/docs/en/plugins-reference
- Claude Agent SDK local-plugin loading:
  https://code.claude.com/docs/en/agent-sdk/plugins
- Nessy internal marketplace:
  https://skills-market.t-tech.team/api

## Provenance statement

Every fixture file under `fixtures/format-adapters/` and `fixtures/catalog-adapters/`
is AUTHORED, hand-written synthetic content produced for this test suite. None of
it is copied from any real Codex bundle, Claude bundle, marketplace catalog, or
any other upstream/proprietary source. Fixture content contains no secrets, no
real credentials or tokens, no absolute user home paths, and no real hostnames —
every URL in these fixtures uses the placeholder host `example.invalid`. All
names, ids, commands and descriptions are invented placeholders chosen only to
be structurally valid examples of the documented formats.
