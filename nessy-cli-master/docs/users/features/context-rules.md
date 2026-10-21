# Context Rules (.nessy/rules/)

Context rules allow you to define project-specific or global instructions that are automatically injected into the model's system prompt. Rules live in `.nessy/rules/` directories and support conditional loading based on file path patterns.

This feature is useful for encoding team conventions, architectural decisions, coding standards, and domain-specific knowledge that the model should follow when working in your codebase.

## Overview

Context rules provide a structured way to persist and automatically apply knowledge across sessions. Unlike NESSY.md which is a single file, rules can be:

- **Organized hierarchically** — split into multiple files by topic, team, or component
- **Conditionally loaded** — injected only when relevant files are accessed
- **Scoped globally or per-project** — share rules across projects or keep them project-specific

## Directory Structure

Rules are discovered from two locations:

| Location          | Path                          | When loaded                  |
| ----------------- | ----------------------------- | ---------------------------- |
| **Global rules**  | `~/.nessy/rules/`             | Always (across all projects) |
| **Project rules** | `<projectRoot>/.nessy/rules/` | Only when folder is trusted  |

**Note:** Project rules require folder trust. If the project root resolves to the same directory as global rules, duplicates are skipped.

### File Organization

Rules are Markdown files (`.md`) that can be organized in subdirectories:

```
.nessy/rules/
├── general.md              # Baseline rules (always loaded)
├── security.md             # Baseline rules (always loaded)
├── frontend/
│   ├── react.md            # Conditional (src/**/*.tsx)
│   └── styling.md          # Conditional (src/**/*.css)
└── backend/
    ├── api.md              # Conditional (src/api/**/*.ts)
    └── database.md         # Conditional (prisma/**/*.prisma)
```

## Rule File Format

Each rule file is a Markdown document with optional YAML frontmatter.

### Baseline Rules (Always Loaded)

Rules without `paths:` in frontmatter are injected at session start:

```markdown
---
description: General coding standards
---

Always write unit tests for new functionality.
Use descriptive variable and function names.
Add JSDoc comments for public APIs.
```

### Conditional Rules (Lazy Loaded)

Rules with `paths:` are injected only when the model accesses a matching file:

```markdown
---
description: React component guidelines
paths:
  - 'src/**/*.tsx'
  - 'src/**/*.ts'
---

Use React functional components with hooks.
Avoid class components and legacy lifecycle methods.
Co-locate component styles with component code.
```

### Frontmatter Fields

| Field         | Type     | Required | Description                                                |
| ------------- | -------- | -------- | ---------------------------------------------------------- |
| `description` | string   | No       | Human-readable label for the rule (used in logs/debugging) |
| `paths`       | string[] | No       | Glob patterns that determine when this rule applies        |

### Body Content

- Write in natural language (English or your team's preferred language)
- Use clear, imperative statements ("Always...", "Never...", "Prefer...")
- HTML comments (`<!-- ... -->`) are stripped to save tokens
- Empty files or files with only comments are ignored

## Path Patterns

The `paths:` field uses glob patterns matched with [picomatch](https://github.com/micromatch/picomatch):

| Pattern            | Matches                                  |
| ------------------ | ---------------------------------------- |
| `src/**/*.ts`      | All `.ts` files under `src/` (recursive) |
| `*.test.ts`        | Test files in the project root           |
| `**/*.test.ts`     | Test files in any directory              |
| `**/*.prisma`      | All Prisma schema files                  |
| `packages/core/**` | Everything under `packages/core/`        |

**Important:**

- Patterns are matched against paths relative to the project root
- If multiple patterns are specified, the rule applies when at least one pattern matches
- Negative patterns (`!pattern`) do not exclude files matched by other patterns; use separate rules with more precise positive patterns instead
- Use forward slashes (`/`) for cross-platform consistency
- Patterns are case-sensitive

## Configuration

### Folder Trust

Project-level rules (`.nessy/rules/` within your project) are only loaded when the folder is marked as trusted. Global rules (`~/.nessy/rules/`) always load.

To trust a folder:

```bash
/directory add /path/to/your/project
```

## How Rules Are Loaded

### Session Startup

1. **Global rules** are loaded from `~/.nessy/rules/` (all `.md` files, recursively)
2. **Project rules** are loaded from `<project>/.nessy/rules/` (if folder is trusted)
3. Rules are split into:
   - **Baseline rules** (no `paths:`) → injected into system prompt immediately
   - **Conditional rules** (with `paths:`) → stored for lazy loading
4. Files are sorted alphabetically for deterministic ordering

### Turn-Level Lazy Loading

When the model reads or edits a file:

1. The conditional rules registry checks if the file path matches any `paths:` patterns
2. Matching rules that haven't been injected yet are formatted and added to the conversation context
3. Each rule is injected **at most once per session**

This approach:

- Reduces initial token usage
- Keeps the system prompt focused on relevant rules
- Scales to large rule sets without overwhelming the model

## Examples

### Example 1: Team Coding Standards

```markdown
---
description: Backend API conventions
paths:
  - 'src/api/**/*.ts'
---

All API endpoints must:

1. Use async/await for asynchronous operations
2. Validate input with Zod schemas
3. Return consistent error formats using AppError class
4. Log requests with correlation IDs

Database queries must use the repository pattern — no direct Prisma calls in controllers.
```

### Example 2: Security Guidelines

```markdown
---
description: Security rules for handling sensitive data
---

Never log sensitive information:

- API keys, tokens, or credentials
- User passwords or PII
- Database connection strings

Use environment variables for secrets (process.env.XYZ).
Never commit .env files or hardcode credentials.

All user input must be sanitized before database queries.
```

### Example 3: Component-Specific Rules

```markdown
---
description: Payment processing rules
paths:
  - 'src/payments/**/*.ts'
  - 'src/checkout/**/*.tsx'
---

Payment-related code must:

1. Idempotency keys for all charge operations
2. Webhook signatures verified before processing
3. All amounts handled in cents (integers), not decimals
4. PCI-DSS compliance: never log full card numbers

Use the PaymentService abstraction — direct Stripe SDK calls are forbidden.
```

### Example 4: Architecture Decisions

```markdown
---
description: State management architecture
paths:
  - 'src/**/*.tsx'
---

State management hierarchy:

1. Server state → React Query (caching, background refetch)
2. Client state → Zustand (global UI state)
3. Local state → useState/useReducer (component-specific)

Avoid prop drilling — use context or Zustand for shared state.
Never store sensitive data in localStorage.
```

## Best Practices

### Organize by Concern

Split rules into focused files rather than one large file:

```
✅ Good:
.nessy/rules/
  ├── testing.md
  ├── security.md
  ├── api-conventions.md
  └── frontend/
      ├── react.md
      └── css.md

❌ Avoid:
.nessy/rules/
  └── everything.md  (500+ lines)
```

### Use Conditional Loading Wisely

Only add `paths:` when rules are truly context-specific:

```markdown
✅ Good: paths for component-specific rules
paths:

- "src/components/\*_/_.tsx"

❌ Unnecessary: paths for project-wide standards
paths:

- "\*_/_" (just omit paths: and make it baseline)
```

### Write Actionable Rules

Make rules specific and testable:

```markdown
✅ Good:
Always include error boundaries in page components.
Use ISO 8601 format for all date strings (YYYY-MM-DDTHH:mm:ssZ).

❌ Vague:
Write good code.
Follow best practices.
```

### Keep Rules Concise

- Each rule file should be scannable (aim for <200 lines)
- Use bullet points and numbered lists
- Avoid lengthy explanations — link to external docs if needed

### Version Control

Commit `.nessy/rules/` to your repository so the team shares the same context:

```bash
git add .nessy/rules/
git commit -m "Add context rules for API conventions and security"
```

Exclude global rules from version control (they live in `~/.nessy/rules/` per-user).

## Troubleshooting

### Rules Not Loading

**Check folder trust:**

```bash
# Verify project is trusted
/directory list
```

**Verify file location:**

- Global: `~/.nessy/rules/*.md`
- Project: `<project>/.nessy/rules/*.md`

**Check file extension:** Only `.md` files are loaded.

**Review logs:**

```bash
# Look for RULES_DISCOVERY debug output
DEBUG=RULES_DISCOVERY npx nessy
```

### Rules Loading But Not Applied

**Conditional rules may not match:**

- Verify glob patterns match your file paths
- Remember patterns are relative to project root
- Use forward slashes for cross-platform consistency

**Test pattern matching:**

```typescript
import picomatch from 'picomatch';
const isMatch = picomatch('src/**/*.tsx');
console.log(isMatch('src/components/Button.tsx')); // true
```

### Too Many Tokens Used

**Reduce baseline rules:**

- Move context-specific rules to conditional loading with `paths:`
- Split large rule files into smaller, focused files

**Strip unnecessary content:**

- Remove verbose explanations
- Use HTML comments for team-only notes (they're stripped): `<!-- internal note -->`

### Conflicting Rules

When multiple rules apply to the same file, all matching rules are injected. Resolve conflicts by:

1. Consolidating overlapping rules into a single file
2. Using more specific `paths:` patterns
3. Removing or archiving deprecated rules

## Comparison with Related Features

| Feature                | Purpose                                             | When to Use                                                |
| ---------------------- | --------------------------------------------------- | ---------------------------------------------------------- |
| **`.nessy/rules/`**    | Persistent instructions injected into system prompt | Team conventions, architecture decisions, coding standards |
| **`NESSY.md`**         | Single project overview file                        | Quick project onboarding, high-level context               |
| **`AGENTS.md`**        | Instructions for AI agents                          | Workflow guidance, tool usage patterns                     |
| **`.nessy/commands/`** | Custom slash commands                               | Reusable workflows, parameterized actions                  |
| **Skills**             | Complex multi-step capabilities                     | When you need tool orchestration and conditional logic     |

## Technical Details

### Discovery Process

1. Recursive scan of `.nessy/rules/` directories
2. Parse YAML frontmatter (if present)
3. Strip HTML comments from body content
4. Split into baseline vs. conditional rules
5. Sort files alphabetically for deterministic ordering
6. Compile glob patterns with picomatch

### Token Optimization

- HTML comments removed before injection
- Conditional rules loaded lazily (not all at once)
- Each conditional rule injected only once per session
- Empty or comment-only files ignored

### Integration Points

- **System prompt:** Baseline rules injected at session start
- **Tool calls:** Conditional rules injected after `read_file`, `edit`, `write_file`
- **Worktrees:** Rules discovered per-worktree

## FAQ

**Q: Can I use rules in untrusted folders?**
A: Project-level rules require folder trust. Global rules (`~/.nessy/rules/`) always load regardless of trust.

**Q: How do I debug which rules are loaded?**
A: Enable debug logging: `DEBUG=RULES_DISCOVERY npx nessy`. The logs show discovered files, baseline/conditional split, and injection events.

**Q: Can rules reference external documentation?**
A: Yes — include links to your wiki, Notion, or other docs. Rules are plain Markdown, so standard Markdown links work.

**Q: Do rules support variables or templating?**
A: No — rules are static text. For dynamic content, use Skills or Commands with parameters.

**Q: How do I disable a rule temporarily?**
A: Either remove the file, move it outside `.nessy/rules/`, or comment out content with HTML comments (which are stripped).

**Q: Can I have rules in subdirectories?**
A: Yes — `.nessy/rules/` supports arbitrary nesting. Subdirectories help organize large rule sets.

**Q: What happens if I edit a rule file during a session?**
A: Changes take effect on the next session. Restart the session to apply them.

## Related

- [Auto Mode](./auto-mode.md) — `.nessy/rules/` is a protected directory; modifications require classifier approval
- [Skills](./skills.md) — Similar `paths:` mechanism for conditional skill activation
- [Folder Trust](../configuration/trusted-folders.md) — How to trust project directories
- [Memory System](./memory.md) — How context rules interact with auto-memory
