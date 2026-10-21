
## Odysseus: user-approved supplied skill

This skill was explicitly added by the user as an exception to the base
local/browser/Obsidian catalog. The services, local applications and MCP/CLI
integrations required by this skill are permitted for its requested workflow.
The local-only restriction of unrelated skills does not disable this exception.

Importing the skill does not connect a service, install a runtime or authorize
sending messages, publishing artifacts or changing external records by itself.
Use the host's available tools and the user's actual task authorization.
Resolve bundled scripts, assets and references from this installed skill's own
root; write task outputs in the user's working project. If a required tool,
connection or referenced resource is absent, report the exact dependency rather
than inventing a successful result.

---


# Mermaid Diagram Renderer

Render Mermaid diagrams using `beautiful-mermaid` library. Supports 5 diagram types with dual output modes.

## Quick Start

> Dependencies (`beautiful-mermaid`) auto-install on first run.

### SVG Output (Default)

```bash
# From file
npx tsx scripts/render.ts diagram.mmd --output diagram.svg

# From stdin
echo "graph LR; A-->B-->C" | npx tsx scripts/render.ts --stdin --output flow.svg
```

### ASCII Output (Terminal)

```bash
# ASCII art for terminal display
npx tsx scripts/render.ts diagram.mmd --ascii

# Pipe directly
echo "graph TD; Start-->End" | npx tsx scripts/render.ts --stdin --ascii
```

Output example:

```
┌───────┐     ┌─────┐
│ Start │────▶│ End │
└───────┘     └─────┘
```

## Supported Diagrams

| Type      | Syntax            | Best For                |
| --------- | ----------------- | ----------------------- |
| Flowchart | `graph TD/LR`     | Processes, decisions    |
| Sequence  | `sequenceDiagram` | API calls, interactions |
| State     | `stateDiagram-v2` | State machines          |
| Class     | `classDiagram`    | OOP design              |
| ER        | `erDiagram`       | Database schemas        |

## Theming (SVG only)

```bash
npx tsx scripts/render.ts diagram.mmd --theme github-dark --output out.svg
```

Use invalid theme name to see available themes list (e.g., `--theme ?`)

## Resources

- `scripts/render.ts` - Main rendering script
- `references/syntax.md` - Mermaid syntax quick reference
