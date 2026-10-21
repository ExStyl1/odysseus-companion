---
name: "brainstorm"
description: "Превращение идей в дизайны через совместный диалог перед реализацией."
---

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


# Brainstorm Skill for Nessy CLI

Turn ideas into designs through collaborative dialogue before implementation.

## Available MCP Tools

Use these tools during **Phase 1: Understand the Idea** to gather context:

| Tool | When to Use |
|------|-------------|
| **Jira** (`dp_jira_*`) | User mentions task links (e.g., `DPIAM-123`, `https://jira/...`) — fetch requirements, acceptance criteria, related issues |
| **Wiki** (`dp_wixie_*`) | User mentions Confluence links or docs — fetch existing documentation, architectural decisions |
| **Sage** (`dp_sage_*`) | User mentions errors, performance issues — analyze logs for current system behavior |
| **GitLab** (`dp_gitlab_*`) | User mentions repositories, MRs — check recent changes, existing implementations |
| **Code Search** (`dp_code-search_*`) | Search codebase for existing patterns, implementations |
| **Context7** (`mcp__context7__*`) | User mentions external libraries — fetch documentation, code examples |

**Guideline**: Use MCP tools when user provides links or references. Do not over-fetch — only gather context directly relevant to the brainstorm topic.

## Activation Triggers

- "brainstorm", "let's brainstorm"
- "help me design", "explore options for"
- "think through", "analyze this feature"
- "what are the approaches to"

## Process

### Phase 1: Understand the Idea

Check project context first, then ask questions one at a time:

1. **Gather context** - check files, docs, recent commits relevant to the idea
2. **Ask questions one at a time** - prefer multiple choice when possible
3. **Focus on**: purpose, constraints, success criteria, integration points

**Do not overwhelm with multiple questions. One question per message.**

### Phase 2: Explore Approaches

Once the problem is understood:

1. **Propose 2-3 different approaches** with trade-offs
2. **Lead with recommended option** and explain reasoning
3. **Present conversationally** - not a formal document yet

Example format:

```
I see three approaches:

**Option A: [name]** (recommended)
- how it works: ...
- pros: ...
- cons: ...

**Option B: [name]**
- how it works: ...
- pros: ...
- cons: ...

Which direction appeals to you?
```

### Phase 3: Present Design

After approach is selected:

1. **Break design into sections** of 200-300 words each
2. **Ask after each section** whether it looks right
3. **Cover**: architecture, components, data flow, error handling, testing
4. **Be ready to backtrack** if something doesn't make sense

**Do not present entire design at once. Incremental validation catches misunderstandings early.**

### Phase 4: Next Steps

After design is validated, offer next steps:

- **Write plan** - Create `docs/plans/YYYY-MM-DD-<topic>.md` with implementation steps
- **Plan mode** - Enter structured implementation planning
- **Start now** - Begin implementing directly if design is simple

## Key Principles

- **One question at a time** - do not overwhelm with multiple questions
- **Multiple choice preferred** - easier to answer than open-ended when possible
- **YAGNI ruthlessly** - remove unnecessary features, keep scope minimal
- **Explore alternatives** - always propose 2-3 approaches before settling
- **Incremental validation** - present design in sections, validate each
- **Be flexible** - go back and clarify when something doesn't make sense
- **Lead with recommendation** - have an opinion, explain why, but let user decide
- **Duplication vs abstraction** - when code repeats, ask user preference: duplication (simpler, no coupling) or
  abstraction (DRY but adds complexity)

## Task Tracking

When implementing after brainstorm:

- Track implementation tasks using todo list
- Mark each task as completed immediately when done (do not batch)
- Keep user informed of progress through status updates
