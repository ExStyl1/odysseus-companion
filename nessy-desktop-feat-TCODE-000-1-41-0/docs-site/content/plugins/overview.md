# Plugins

Plugins package related capabilities — skills, MCP server descriptors, hooks,
settings, commands, and assets — as one installable unit. A package is installed
once into a Nessy-owned immutable, content-addressed cache and activated by
policy for global, Workspace, Project, or session context. Nessy does not copy a
plugin into every Workspace or Project.

The plugin runtime is additive. Installing a plugin does not rewrite
`CONFIG_DIR/workspaces/<workspaceId>/sources`, Workspace skills or automations,
project `.mcp.json`, project `.agents/skills`, or project hook files.

## What Plugins Can Provide

| Capability | How Nessy uses it |
| --- | --- |
| Skills | Exposed as read-only plugin-origin skills from the installed bundle. A one-line `!` context command runs only after qualification and permission admission, through the supervised Pi process path with pinned cwd, timeout, and output bounds. |
| MCP servers | Projected into the runtime MCP pool as plugin capabilities, not as native source slugs. Remote and stdio servers alike are listed in the MCP servers panel with a per-server enable switch; a server needing OAuth or a bearer token holds one global credential per server, shared by every workspace. |
| Command hooks | Registered as plugin hooks that run under the workspace process-isolation profile; each command hook requires explicit trust before it executes. |
| Prompt hooks | Inject a one-shot instruction as bounded hidden context; they do not start a process or grant execution authority. |
| Agent / mcp_tool / http hooks | Execute only through Pi host runners. Agent hooks use the governed child-session port, MCP hooks use the matching session lease, and HTTP hooks are credentialless, permission-checked requests through the existing webhook executor. |
| Prompt/slash commands | Markdown commands are exposed as namespaced prompt templates. They are never executed as shell commands; only the literal `$ARGUMENTS` token is substituted. |
| Agents | Markdown agents are exposed as plugin-origin agent definitions. |
| Language servers (LSP) | A plugin-contained executable, or a verified host-managed runtime, starts through `LspService` and `ProcessSupervisor` for the declared languages. Arbitrary PATH lookup stays disabled. |
| Settings | Declared primitive settings are schema-checked and stored only in the plugin-owned data namespace; they never merge into global Nessy preferences and are removed on uninstall. MCPB `user_config` remains a separate encrypted server configuration path. |
| Monitors and MCP channels | A trusted monitor with an explicit cron schedule projects into the existing scheduler. It reaches the agent only while a turn is running: a tick that fires while the session is idle is skipped, not queued, and `/tasks` lists each such monitor with that note. Bounded `notifications/claude/channel` events reach only sessions holding the matching live server lease, wrapped in a `<channel source="...">` tag. |
| Commands, assets | Stored in the normalized bundle and projected as namespaced Nessy extensions. |

Every supported format is normalized into one lossless Nessy manifest, so the
runtime never depends on where a package came from. A normalized compatibility
profile — not the package format or acquisition source — decides the
environment a bundle sees, and an unrecognized profile fails closed.

| Format | Manifest / discovery | Notes |
| --- | --- | --- |
| Nessy | `plugin.json` (native), `nessy-extension.json` (legacy), standalone `SKILL.md` | Source-of-truth format; legacy manifests normalize conservatively. |
| Codex | `.codex-plugin/plugin.json` | Skills, MCP, hook descriptors, LSP, typed settings, scheduled monitors, and apps/connectors map into governed Nessy capabilities. A connector with a usable MCP transport becomes an MCP-backed Source; an app-only connector ID remains explicitly unsupported. |
| Claude | optional `.claude-plugin/plugin.json` plus default `skills/`, `commands/`, `agents/`, `hooks/hooks.json`, `.mcp.json` | Skills, MCP, hooks, Markdown commands, agents, contained LSP, typed settings, scheduled monitors, and leased MCP channels normalize into governed Nessy capabilities. |
| Claude Desktop extension | `.mcpb` / `.dxt` ZIP with a root `manifest.json` | Node, Python, and native MCP entrypoints normalize into the same runtime. Archive traversal, symlinks, duplicates, oversized payloads, and undeclared executables are rejected before install. |

Provider paths and field names end at the format adapter; they never become
Nessy's canonical storage or runtime layout.

## MCP Authentication

Authentication is classified from the normalized runtime descriptor, never
from a marketplace name, plugin name, or catalog
`policy.authentication` label:

| Requirement | Runtime behavior |
| --- | --- |
| DP | An exact `dp ai mcp ...` command is gated on the one Desktop-owned Spirit SSO broker. One login covers every matching server; child processes cannot log in themselves. |
| OAuth | A remote plugin server declaring OAuth owns a **global credential slot** in `CONFIG_DIR/credentials.enc`, keyed by plugin and server name. One sign-in covers every workspace — there is no per-workspace duplication. |
| Bearer / environment | A declared bearer token is requested once and stored in the same global plugin slot; an environment binding is requested as configuration. Neither shows an OAuth card. |
| None | A remote plugin server with no auth declaration connects without a card or credential. |
| Unsupported app | A Codex app ID without a bundled materializable MCP transport fails install/activation with an unsupported host-connector diagnostic. Nessy does not guess an endpoint. |

DP credentials remain owned by Spirit CLI under `DP_WORKDIR`; they never enter
the Nessy credential vault. A failed generic OAuth card is terminal and
non-actionable; a retry is a separately emitted pending request. A failed DP
attempt keeps its matching server-only replay retryable until cancel or
cleanup. See [MCP authentication](../sources/mcp-servers/authentication).

A server whose credential slot is still empty is not silently dropped: it is
listed in the post-install setup checklist, surfaces again in the session-start
notice, and shows a needs-auth badge in the MCP servers panel until you sign
in. Signing in from any of those surfaces never interrupts a running turn.

## Deferred Components

Unsupported components are never silently dropped. Command, prompt, agent,
mcp_tool, and credentialless HTTP hooks run through their existing host
authorities. Contained LSP, typed plugin settings, explicitly scheduled
monitors, and leased MCP channels are active; disable or uninstall drains their
processes and leases before release. MCPB `user_config` remains supported
through its separate encrypted MCP configuration path. Codex connectors with a
materializable MCP transport run too: a connector normalizes into a
plugin-owned MCP server on the same capability path as every other plugin
server — it never creates a Source — and it authenticates through the plugin's
global credential slot (`ON_INSTALL` / `ON_FIRST_USE` is sign-in timing only,
never a trust grant; denial has no side effect). Codex app-only connector IDs
are reported as unsupported rather than treated as transports. Still deferred: output styles, themes, Claude app-level
settings, and monitors without an explicit schedule. Every deferred declaration stays visible
in the compatibility report. A package whose only declarations are deferred
installs but is not auto-activated.

A declaration that was *refused* rather than deferred — a bundled MCP server
that stood down as a duplicate, or one whose command the runtime could not
accept — is listed with its reason under **Diagnostics** on the plugin's own
page, beside the components that did load. A plugin left with no usable
component at all says so in its state instead of presenting as active. A plugin
installed by an earlier version carries the records it was installed with until
it is updated or repaired (Plugins → the plugin's menu → Repair).

## Marketplace And Lifecycle

The Marketplace is the supply channel: separate **Plugins** and **Skills** tabs
over one server-side search, flat result rows with format and acquisition
badges, an "Installed" strip across the top, and a detail view that shows the
package description, its information, and — once installed — the full inventory
of what it ships (skills, commands, hooks, connectors, and MCP servers), each
component clickable through to its own page. The compatibility state and
actionable diagnostics are shown per item; a package that comes back partial
waits for your explicit confirmation before it activates, and a blocked package
is refused with the reason shown.

Management lives in **Sources**, not the Marketplace: a **Plugins** subsection
under Sources lists every installed plugin, and enable, disable, update, repair,
and uninstall run from there (installing from the Marketplace hands you off to
that page). Enable/disable applies per workspace or per active project, and all
of it refreshes live sessions.

Installing a plugin no longer ends in silence. The install result reports
every outstanding requirement, and a **setup checklist** renders it right
after install: the Developer Platform sign-in is one click (one login unblocks
every DP-backed server at once), a plugin that declares user configuration
opens its configuration prompt from the checklist, and OAuth servers are
listed with a pointer to the session-start notice — no OAuth flow is chained
into the install itself. Nothing in the checklist blocks: skip it and every
entry stays reachable later from the session notice and the plugin page.

When a session starts in a workspace with servers still awaiting sign-in, a
non-blocking **notice** lists them — DP, OAuth, and bearer alike, plus any
server whose startup connection failed. Signing in from the notice runs
without interrupting the conversation. Enabled servers connect at session
start by default; set `sources.connectOnStartup: false` in `config.json` (or
the managed-policy key `connectSourcesOnStartup`) to restore connect-on-first-use.

An extension that declares user configuration shows **Needs configuration** on
its plugin page. All declared values are stored together in one scoped,
encrypted plugin-configuration record; secret field metadata still controls
redaction and editing behavior. Configure, clear, enable, disable, and
uninstall all invalidate the same runtime snapshot. A bundled MCP server never
asks you to create a duplicate Source — plugin servers belong to the plugin
and never appear in the source list.

Individual plugin capabilities — MCP servers, skills, hooks, and commands —
have their own switches, so one MCP server out of ten can be turned off
without losing the other nine. The **MCP servers panel** lists every server —
plugin-owned and user-created together — with its origin, transport, and auth
state, and a per-server enable switch on plugin rows; a plugin's detail page
shows the same rows filtered to that plugin. A capability you disable
leaves live sessions immediately (the shared MCP pool shuts its server down
unless another chat still uses it), renders dimmed with a "Turned off" note,
and comes back the moment you re-enable it. Disabling the whole plugin stays
terminal: per-capability switches never resurrect a suppressed plugin.

The assistant can also drive the same lifecycle through dedicated session tools
(plan, install, status, manage). These tools never run a shell command, never
expose credentials, and never grant executable trust on your behalf.

### Bring Your Own Registry

Beyond installing single plugins, you can add a whole plugin **registry** — a
Git repository, Git URL, or local folder whose catalog manifest
(`marketplace.json` / `plugins.json`) lists many plugins. Add one from
**Marketplace → Create → Add marketplace** (source, optional Git ref, optional
sparse paths); its entries then appear grouped under their own section beside
the built-in market. Upgrade re-fetches a Git registry, Remove takes it away
(with confirmation), and the built-in market cannot be removed. Adding one
opens its section, where a catalog that is still loading or failed to load says
so. A registry whose catalog fails to load is reported inline without hiding the
rest, and while you browse any other section a note reads "Some marketplaces
could not be loaded." The
catalog is fetched server-side through the same governed staging path as a
plugin install — the interface never fetches plugin content directly, and a
registry's on-disk location never crosses into the UI.

### Creating Skills And Plugins

Nessy ships two built-in guide skills — **Skill Creator** and **Plugin
Creator** — seeded into `~/.nessy-agent/skills/` on first run (seeded only when
missing; a skill you have edited is never overwritten). Run **/create-skill**
or **/create-plugin** in the composer, or **Marketplace → Create → Create
plugin**, to open a visible chat that interviews you and scaffolds the skill or
plugin with Nessy's schema and paths, then validates it with the existing
`skill_validate` / plugin-install path. These are guided prompt flows — no new
tool and no elevated access; files are written through the normal
permission-gated path.

Executable trust is user-driven. Command hooks and stdio MCP servers that need
review are listed in a trust panel where you grant or revoke the exact
capability. Installing or enabling a plugin never auto-grants trust, and an
update or a changed bundle returns to review-required.

## Marketplace Safety

Marketplace entries are metadata first. Nessy installs supported `npm`, marketplace file-snapshot, GitLab skill, URL archive, and repository sources through structured install descriptors, but marketplace `install.command` fields and Codex plugin install commands are display-only metadata. They are never executed by the install service. Multi-file skills install from the marketplace's per-file snapshot with every file verified against its published checksum.

Repository URL installs are proposal-based. The agent or UI can propose a typed source from a repository URL on a supported host, but successful installation still goes through backend fetch, staging, normalization, validation, and `PluginStore` commit. Unsupported URLs or unsafe archives return diagnostics instead of writing plugin, skill, source, hook, trust, or lock files.

**Which hosts have a route.** Nessy never clones; it fetches an archive, so the
question a hostname answers is only *which archive shape do we speak to it in*:

| Host | Notes |
| --- | --- |
| `github.com` | The `archive/<ref>.tar.gz` route |
| `gitlab.com` and any `gitlab` DNS label (`gitlab.example.com`) | The documented GitLab v4 archive route |
| `git.tcsbank.ru` | This fork's own git host, known by name, on the same GitLab v4 route |
| Other self-hosted GitLab | Declare it in `NESSY_PLUGIN_GITLAB_HOSTS` — see [environment variables](/reference/config/environment-variables) |
| `bitbucket.org` | The `get/<ref>.tar.gz` route; default branch and tag listing read from Bitbucket's own payload shapes |
| `dev.azure.com` | Azure DevOps Services. Its items route publishes **zip** only, so the pipeline handles that format beside tar |

The GitLab test is a **DNS label**, not a substring: `gitlab.example.com`
resolves, `notgitlab.io` and `gitlab-mirror.example.net` do not, and a host that
looks like GitLab without being one meets a refusal that names the environment
variable rather than looking broken. Azure DevOps **Server** (on-premises), the
legacy `<org>.visualstudio.com` spelling and GitHub Enterprise Server stay
outside the set on purpose — each addresses a repository differently, and a
declared GHES host would resolve its tags against `github.com`. AWS CodeCommit
publishes no archive route at all, so it is structurally unreachable rather than
merely unimplemented.

Local bundle installs copy files into a staging directory first, reject unsafe symlinks, validate paths, normalize metadata, and only then commit into the Nessy-owned plugin cache.

## Storage Ownership

Plugin package, policy, trust, data, and credentials are separate:

| Concern | Location |
| --- | --- |
| Installed package registry | `CONFIG_DIR/plugins/installed.json` and lock/journal state |
| Immutable bundle | `CONFIG_DIR/plugins/cache/<encoded-marketplaceId>/<encoded-pluginId>/<encoded-version>/<bundleHash>` |
| Global activation policy | `CONFIG_DIR/capabilities.json` |
| Workspace activation policy | `CONFIG_DIR/workspaces/<workspaceId>/capabilities.json` |
| Project and executable trust | `CONFIG_DIR/project-trust.json` and `CONFIG_DIR/capability-trust.json` |
| Scoped writable data | `CONFIG_DIR/plugins/data/<encoded-plugin-key>/workspaces/<workspaceId>[/projects/<projectKey>]` |
| OAuth, bearer, and plugin-configuration secrets | Records in `CONFIG_DIR/credentials.enc`; a plugin MCP server's OAuth/bearer slot is global, keyed by plugin and server name |
| DP SSO credentials | Spirit CLI state under `DP_WORKDIR` (never copied into plugin or Nessy credential storage) |

The marketplace, plugin, and version path segments are reversible base64url encodings, not raw external identifiers.

The bundle hash covers the normalized tree, including file contents, paths,
types, executable bits, and symlinks; it is not only a manifest checksum.
Installed bundles are read-only. Writable plugin data is version-independent
and scoped so one Workspace or Project cannot leak state into another.
`installed.json` answers which package instance is installed; it does not own
activation, trust, credentials, or writable data. Lifecycle status is derived
from the operation journal, integrity checks, and current marketplace listing,
not persisted as package enablement.

## Visibility And Trust

Plugin enablement is scoped:

| Scope | Meaning |
| --- | --- |
| `global` | Available across workspaces for this user. |
| `workspace` | Available in one Nessy workspace. |
| `project` | Available for one project root, including `.nessy-agent/config.toml` overlays. |

After bundle/native defaults, policy layers run from global to Workspace to the
trusted active-repository policy, then to the private `(workspaceId, ProjectKey)`
override and session selection. Repository policy is withheld until
whole-project trust is granted; the private override is Nessy-managed state and
is never written into the repository. A matching `enabled: false` is terminal
and a narrower scope cannot re-enable the plugin. Otherwise, narrower
capability-level values can override broader values without changing the whole
plugin.

Marketplace skills are installed as skill-only plugins. By default they enable in the current workspace when one is available; users can explicitly enable a skill for the current project from the installed item actions. Native project, workspace, and global skills keep their normal precedence over plugin-provided skills with the same slug.

Trust is keyed by plugin instance, capability ID, executable hash, and scope.
Changing the command or executable context invalidates the trust decision, so
command hooks cannot silently switch what they run.

Duplicate skills and agents remain addressable by qualified IDs; for non-MCP
compatibility names, the nearest scope wins, then native over plugin. A
plugin's MCP server never gets a short wire name — it always carries a
`plugin_<pluginId>_<serverName>` wire name, whether or not another server
shares its logical name — while a built-in or user-configured server keeps
its own short name regardless of what plugins are installed. When a plugin's
server duplicates one you already run — the same built-in command, or the
same declared endpoint as another plugin's server — the duplicate stands
down and stays visible with a reason instead of running twice, and that
reason also names the plugin's own hooks and skills that referenced the
stood-down server and are therefore inactive. See
[MCP servers](../sources/mcp-servers/overview) for the full rule.

For each turn, the server resolves policy, project trust, exact-hash executable
trust, credential readiness, and session selection once into an immutable,
revision-pinned snapshot. Pi runtime, Composer metadata, and user catalogs are
different safe views of that same snapshot; they do not rediscover files or run
independent precedence rules mid-turn.

## Hooks

Global native hooks live in `CONFIG_DIR/hooks.json`. Workspace hooks live in
the Workspace hook files or config, project hooks live under `.nessy-agent`, and
plugin hooks come from installed plugin projection. Runtime ordering is:

1. internal permission and pre-tool checks
2. native global and workspace hooks
3. project `.nessy-agent` hooks
4. trusted plugin hooks

Plugin hooks are not wired through marketplace commands. Command, prompt,
agent, mcp_tool, and credentialless HTTP actions execute only after pinned
capability/trust revalidation and the effective Pi permission decision. Raw
authentication material in an HTTP descriptor fails closed before policy or
network access.

## Existing Workflows Stay Separate

- Create and authenticate API, MCP, and local-file sources through **Sources**.
- Author editable skills in global, workspace, or project skill folders.
- Manage app-event automations through `automations.json`.
- Use `.nessy-agent` project files for project overlays and project hooks.

Plugins can add capabilities to those runtime views, but they do not become the owner of those existing files.
