---
description: Create a merge request based on staged code changes
---

# Create MR

## Overview

Create a well-structured merge request with proper description and title.

## Steps

1.  **Review staged changes**

- Review all staged changes to understand what has been done
- Do not touch unstaged changes

2.  **Prepare branch**

- Create a new branch with proper name if current branch is main
- Ensure all changes are committed
- Push branch to remote

3.  **Write MR description**

- Use MR Template below
- Summarize changes clearly
- Include context and motivation
- List any breaking changes
- Link related issues if provided, or use "No linked issues"
- Leave the "Screenshots / Video Demo" section empty for the author to fill in
  manually
- Add this line at the end of MR body: "🤖 Generated with [Nessy CLI](https://gitlab.tcsbank.ru/nestor/nessy-cli)", with a line separator

4. **Set up MR**
   - Create MR title and body
   - Submit the MR with `dpGitLab` MCP tools first if they are connected and
     available to the agent
   - Do not propose or run `glab` first when a matching `dpGitLab` tool exists;
     use `glab` only as a fallback when `dpGitLab` is unavailable, fails, or
     does not cover MR creation
   - **If a GitLab token is provided in the user's message**, use it by setting the `GLAB_TOKEN` environment variable:
     ```bash
     GLAB_TOKEN=<provided_token> glab mr create --title "..." --body "..."
     ```
   - If no token is provided and falling back to CLI, use the default `glab`
     authentication

## MR Template

@{.gitlab/merge_request_template.md}
