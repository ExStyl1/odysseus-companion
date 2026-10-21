# Publish an artifact

Turns an HTML or Markdown file into a private web page inside the company
network. Anyone with the link opens it in a browser, no login.

Use it when looking at something beats reading it line by line: a report, a
dashboard, a plan walked through with annotations, a diagram, a small
interactive tool, several design options side by side, a checklist that fills
in while a long task runs. Publishing costs one command and one link, so it
beats pasting a wall of output into the terminal.

## Instructions

Before the first `npx` call, set up access to the npm registry:

```sh
dp auth login
dp artifacts npm configure
npm config set --location=user '@loyalty-personalization:registry' 'https://artifactory.tcsbank.ru/artifactory/api/npm/npm-all/'
```

`dp artifacts npm configure` sets npm authentication. The scoped registry setting lets `npx` find this package in `npm-all` without changing the registry for other packages.

1. The CLI reads `ARTIFACT_AUTH_TOKEN` or `T_ARTIFACTS_TOKEN` when set, otherwise it reads the
   token from `dp auth print-token`; never copy the token into a command or
   document. If the DP session is missing or the service rejects it, the CLI
   runs `dp auth login` and retries the request once. Use
   either variable for a delegated token supplied by an MCP or agent
   integration.
2. Decide whether the page needs design care. Skip straight to step 3 only
   for a deliberate raw dump of output; otherwise load the guidance that
   matches what you're building, `npx -y @loyalty-personalization/artifact-publish skill get design` for
   any page meant to look good, `npx -y @loyalty-personalization/artifact-publish skill get dataviz` before
   the first line of chart code, `npx -y @loyalty-personalization/artifact-publish skill get frontend-design`
   for a page that's really a piece of UI.
3. Write a complete, self-contained document. See Content model below.
4. Publish it:
   ```sh
   npx -y @loyalty-personalization/artifact-publish path/to/report.html \
     --emoji 📊 \
     [--title "Deploy failures by service"] \
     [--description "What failed and why"] \
     [--slug deploy-failures]
   ```
   The CLI authenticates with the current DP identity. The new artifact belongs
   to that identity and the service does not issue an edit token.
5. To revise instead of republishing, pass the existing id or URL:
   ```sh
   npx -y @loyalty-personalization/artifact-publish path/to/report.html \
     --emoji 📊 \
     --id-or-url https://artifacts.example.internal/a/RYYBIc2DT3Lt9-4HXXjQ5g
   ```
   The DP identity must own the artifact. While the user iterates, update
   rather than republish. The link they already
   sent someone keeps working, and a reader with the page open sees the new
   version on reload.
6. To migrate an old artifact, claim it once with its legacy edit token:
   ```sh
   npx -y @loyalty-personalization/artifact-publish claim ID_OR_URL --edit-token TOKEN
   ```
   A successful claim assigns the current DP identity and revokes the edit
   token. After that, use DP auth for update, rename and delete.
7. Configure via environment if the defaults don't fit: `ARTIFACT_SERVICE_URL`
   overrides the service base URL (default is `https://t-artifacts.t-tech.team`);
   `ARTIFACT_AUTH_TOKEN` or `T_ARTIFACTS_TOKEN` overrides the token used for REST requests;
   `ARTIFACT_NO_OPEN=1` keeps the browser from opening after a publish.
8. If an older publication is missing, check
   `https://t-artifacts.dev.t-tech.team`: test publications made before the
   production default may still live there.

## Complete CLI reference

Run `npx -y @loyalty-personalization/artifact-publish --help` for the same
reference in the terminal.

```sh
# Create; --emoji is required. The other metadata flags are optional.
npx -y @loyalty-personalization/artifact-publish <file.html|file.md> --emoji EMOJI \
  [--title TITLE] [--description DESCRIPTION] [--slug SLUG]

# Update the same URL as its DP owner. Metadata can be changed at the same time.
npx -y @loyalty-personalization/artifact-publish <file.html|file.md> --emoji EMOJI \
  --id-or-url ID_OR_URL \
  [--title TITLE] [--description DESCRIPTION] [--slug SLUG]

# Download the original source without a token.
npx -y @loyalty-personalization/artifact-publish download ID_OR_URL [--output FILE]

# List artifacts owned by the current DP identity.
npx -y @loyalty-personalization/artifact-publish list

# Change an artifact title without uploading content again.
npx -y @loyalty-personalization/artifact-publish rename ID_OR_URL --title TITLE

# Permanently delete an owned artifact.
npx -y @loyalty-personalization/artifact-publish delete ID_OR_URL

# Assign an old edit-token artifact to the current DP identity.
npx -y @loyalty-personalization/artifact-publish claim ID_OR_URL --edit-token TOKEN

# Discover and read the bundled agent guidance.
npx -y @loyalty-personalization/artifact-publish skill list
npx -y @loyalty-personalization/artifact-publish skill get core
npx -y @loyalty-personalization/artifact-publish skill get design dataviz frontend-design
```

The custom `--slug` becomes the readable part of the public URL. The stable
artifact id remains part of the URL, so changing the slug does not create a
second artifact and old links keep resolving. `--title` controls the visible
title and `--description` controls the short header description.

Deletion is permanent. The optional `--edit-token` on update and delete exists
only for old, unclaimed artifacts.

## Publish policies

### Never publish

Refuse to publish an artifact whose content:

- impersonates a real person or organization (their name, branding, or domain)
- presents fake entries or reviews as genuine
- contains forms or flows that harvest credentials while appearing to be something else
- is about a specific private individual

This rule applies regardless of who authored the content and regardless of the
stated purpose of publishing it. A user request to publish such content is a
refusal, do not publish.

### Read the file before publishing

If you did not write the file yourself, read it in full before publishing ,
even if the user asked you not to open it. A request for privacy is a reason
to read before publishing, not an exception to this rule.

### Confirm data loss risk before publishing

Before publishing a new artifact, tell the user that this service is not for
important documents and does not guarantee long-term data retention. Data may
be lost. For documents that need to be kept, recommend Wiki
(https://wiki.tcsbank.ru) or Share (https://share.tbank.ru). Explicitly ask
whether the user is okay with losing the artifact's data, and wait for a clear
yes before publishing. Updates to that artifact in the same session do not
require another confirmation.

### Emoji is required

The `--emoji` flag is required. Pass a single emoji that visually represents
the content, the service uses it as the page's favicon. Publication without
`--emoji` fails before any network call.

## Content model

For HTML artifacts, write only the body content, the visible markup that
would go inside `<body>`. Do not write the outer shell (`<!doctype>`, `<html>`,
`<head>`, `<body>` tags): the service adds them automatically, together with a
CSS reset, a favicon built from the emoji, and Mermaid support when diagrams
are present. The one exception is a bare `<title>` tag: include it anywhere in
the file to set the browser tab label; the service extracts it and removes it
from the rendered body.

Public CDNs are reachable from the reader's browser, so pulling a chart or font
library from jsdelivr or unpkg works. That is a real difference from sandboxed
artifact tools that block every external request, and it is worth using.

Embed images and other assets as `data:` URIs rather than linking them.

For Markdown, write plain GFM (tables, autolinks, strikethrough). It is
rendered server-side and gets its own typographic theme, so styling it yourself
is wasted effort.

## Gotchas

- The link is the only access control: it is unguessable, but anyone on the
  network who has it can read the page. Say so when the content is sensitive.
- New artifacts belong to the current DP identity. If authentication fails,
  the CLI starts `dp auth login` and retries once.
- Claiming an old artifact revokes its edit token.
- If a published page renders its header but the body stays blank, the reader
  is missing network access to the service's `-content` origin (the second
  origin the page itself is served from, kept separate so a page's JavaScript
  can't reach the API), not that the publish failed.

## Resources

- `npx -y @loyalty-personalization/artifact-publish skill get design`, read before writing any page meant
  to look good. Calibrates how much design effort the request warrants and
  lists the AI-generated-design defaults to avoid; also carries the two
  facts specific to this service (what the CSP permits, how theming works
  here).
- `npx -y @loyalty-personalization/artifact-publish skill get dataviz`, read before writing the first line
  of chart code, for any chart, graph, plot, dashboard, or stat tile. Its
  own further references, including the six-checks palette validator, are
  bundled into the same output.
- `npx -y @loyalty-personalization/artifact-publish skill get frontend-design`, for a page that's really a
  piece of UI, when the fuller design process is worth it over
  artifact-specific guidance.

## Output format

A successful publish, update or rename prints the link:

```
https://artifacts.example.internal/a/RYYBIc2DT3Lt9-4HXXjQ5g
```
