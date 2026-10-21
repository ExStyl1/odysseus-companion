# Document Tools

Nessy Desktop ships a set of document tools so the agent can read, convert, and produce common office formats — Word, Excel, PowerPoint, PDF, images, and calendar files — without leaving the conversation. Each tool is a self-contained Python script bundled in the app and run through a packaged `uv` runtime.

## Available Tools

| Tool           | Purpose | Formats |
| -------------- | ------------------------------------------- | --------------------------------------------------- |
| **markitdown** | Convert a document to Markdown | `.docx`, `.xlsx`, `.pptx`, `.pdf`, `.html`, `.ipynb`, and more |
| **pdf-tool**   | Extract, merge, split, rotate, convert, redact | `.pdf` |
| **xlsx-tool**  | Read and write spreadsheets, export to CSV | `.xlsx`, `.csv` |
| **docx-tool**  | Create and edit Word documents | `.docx` |
| **pptx-tool**  | Read and inspect presentations | `.pptx` |
| **img-tool**   | Resize, convert, read metadata | `.png`, `.jpg`, `.webp`, `.gif`, `.svg` |
| **doc-diff**   | Compare two documents | Any two files |
| **ical-tool**  | Parse calendar files | `.ics` |

## Common Tasks

### Read a Document as Text

The most frequent operation is turning a binary document into something the agent can reason over:

```text
"Summarise this Word document"
"What's in this spreadsheet?"
"Pull the text out of this PDF"
```

**markitdown** acts as the universal reader, converting Word, Excel, PowerPoint, PDF, HTML, and notebook files into Markdown.

### Work with PDFs

```text
"Merge these three PDFs"
"Extract pages 5 to 10"
"How many pages is this?"
```

**pdf-tool** covers organizing (extract, merge, split, rotate, reorder), editing (watermark, crop, compress, fill forms), security (encrypt, decrypt, redact), and conversion (to and from images, to `.docx` or `.pptx`).

### Process Spreadsheets

```text
"Read the Sales sheet"
"Export this to a new Excel file"
"Convert this CSV to Excel"
```

**xlsx-tool** reads and writes multi-sheet Excel files and can export to CSV.

### Create Word Documents

```text
"Turn this summary into a .docx"
"Write this plan as a Word document"
```

**docx-tool** builds Word files from text or Markdown, with headings and basic formatting.

### Process Images

```text
"Resize this to 800px wide"
"Convert this PNG to JPEG"
"What are this image's dimensions?"
```

**img-tool** handles resizing, format conversion, and metadata for common image types.

### Compare Documents

```text
"What changed between these two contract versions?"
```

**doc-diff** reports the differences between two files — useful for reviewing revisions.

### Parse Calendars

```text
"What events are in this .ics file?"
```

**ical-tool** extracts event details (title, date, time, location, attendees) from `.ics` files.

::: tip
Not sure what a tool can do? Ask — "what can the pdf-tool do?" — and the agent will describe its commands. When the agent hits a binary file it can't read directly, it falls back to markitdown on its own.
:::

## How They Run

The tools are Python scripts declaring their dependencies inline (PEP 723). The app bundles a per-platform `uv` binary and puts it on the tool path, so no system Python is required.

On first use, `uv` downloads a matching CPython (Python 3.12) — a few seconds, then cached — and fetches each script's Python packages from PyPI. Subsequent runs reuse the cache and start immediately.

::: info
Where does output go? Created or converted files land in the current working directory unless you specify a path, and the agent tells you the exact location. You can chain steps in one request — "read this PDF, extract the revenue figures, and build a spreadsheet from them" — and the agent runs the tools in sequence.
:::

## Networks That Block PyPI

Because first use fetches CPython and wheels from public package hosts, the document tools need network access to PyPI (or an approved mirror) the first time each dependency set is installed. On locked-down networks, point `uv` at your internal index or allow PyPI access before relying on these tools.

If the runtime cannot install a script's dependencies, only that document operation fails — it reports an error for the file in question. Chat, sources, and every other part of the app keep working.
