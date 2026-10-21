# OpenAPI Reference

Nessy Desktop v1 does not publish an OpenAPI specification. The desktop app, CLI, and headless server communicate over an internal WebSocket RPC channel whose shape can change between releases, so it is deliberately not documented as a public API. If a stable public API ships in a later release, its specification will land on this page.

In the meantime, the supported integration points are:

- [CLI Reference](../reference/cli) — scriptable commands against a local or remote server.
- [API Sources](../sources/apis/overview) — how the agent calls external REST APIs you connect.
- [Config File](../reference/config/config-file) — the on-disk formats under `~/.nessy-agent`.
