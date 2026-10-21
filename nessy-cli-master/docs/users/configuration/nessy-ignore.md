# Ignoring Files

This document provides an overview of the Nessy Ignore (`.nessyignore`) feature of Nessy CLI. Nessy CLI also recognizes custom ignore files configured by `context.fileFiltering.customIgnoreFiles`, which defaults to the compatibility files `.agentignore` and `.aiignore`.

Nessy CLI includes the ability to automatically ignore files, similar to `.gitignore` (used by Git). Adding paths to `.nessyignore` or a configured custom ignore file will exclude them from tools that support this feature, although they will still be visible to other services (such as Git).

## How it works

When you add a path to one of these ignore files, tools that respect Nessy ignore rules will exclude matching files and directories from their operations. For example, when you use the [`read_many_files`](../../developers/tools/multi-file) command, any paths in `.nessyignore` or configured custom ignore files will be automatically excluded.

For the most part, these ignore files follow the conventions of `.gitignore` files:

- Blank lines and lines starting with `#` are ignored.
- Standard glob patterns are supported (such as `*`, `?`, and `[]`).
- Putting a `/` at the end will only match directories.
- Putting a `/` at the beginning anchors the path relative to the ignore file.
- `!` negates a pattern.

You can update these ignore files at any time. To apply the changes, you must restart your Nessy CLI session.

## How to use ignore files

| Step                    | Description                                                                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Enable ignore rules** | Create `.nessyignore`, a default custom file (`.agentignore` / `.aiignore`), or a configured custom ignore file in your project root directory |
| **Add ignore rules**    | Open the ignore file and add paths to ignore, example: `/archive/` or `apikeys.txt`                                                           |

By default, Nessy CLI reads `.nessyignore`, `.agentignore`, and `.aiignore`.
To use a different custom ignore file, configure:

```json
{
  "context": {
    "fileFiltering": {
      "customIgnoreFiles": [".cursorignore"]
    }
  }
}
```

`.nessyignore` is always included when `context.fileFiltering.respectNessyIgnore`
is enabled. Custom ignore file paths are relative to the project root.

### Ignore file examples

You can use any supported ignore file to ignore directories and files:

```
# Exclude your /packages/ directory and all subdirectories
/packages/

# Exclude your apikeys.txt file
apikeys.txt
```

You can use wildcards in your ignore file with `*`:

```
# Exclude all .md files
*.md
```

Finally, you can exclude files and directories from exclusion with `!`:

```
# Exclude all .md files except README.md
*.md
!README.md
```

To remove paths from an ignore file, delete the relevant lines.
