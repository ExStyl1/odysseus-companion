# Document Tools

Nessy Desktop поставляет set of document tools, чтобы агент мог read, convert and produce common office formats — Word, Excel, PowerPoint, PDF, images and calendar files — without leaving conversation. Each tool is self-contained Python script bundled in app and run through packaged `uv` runtime.

## Available Tools

| Tool | Purpose | Formats |
| ---- | ------- | ------- |
| **markitdown** | Convert document to Markdown | `.docx`, `.xlsx`, `.pptx`, `.pdf`, `.html`, `.ipynb`, and more |
| **pdf-tool** | Extract, merge, split, rotate, convert, redact | `.pdf` |
| **xlsx-tool** | Read/write spreadsheets, export to CSV | `.xlsx`, `.csv` |
| **docx-tool** | Create/edit Word documents | `.docx` |
| **pptx-tool** | Read/inspect presentations | `.pptx` |
| **img-tool** | Resize, convert, read metadata | `.png`, `.jpg`, `.webp`, `.gif`, `.svg` |
| **doc-diff** | Compare two documents | Any two files |
| **ical-tool** | Parse calendar files | `.ics` |

## Common Tasks

### Read a Document as Text

Самая frequent operation — превратить binary document в текст, над которым агент может reason:

```text
"Summarise this Word document"
"What's in this spreadsheet?"
"Pull the text out of this PDF"
```

**markitdown** works as universal reader, converting Word, Excel, PowerPoint, PDF, HTML and notebook files into Markdown.

### Work with PDFs

```text
"Merge these three PDFs"
"Extract pages 5 to 10"
"How many pages is this?"
```

**pdf-tool** covers organizing (extract, merge, split, rotate, reorder), editing (watermark, crop, compress, fill forms), security (encrypt, decrypt, redact) and conversion (to/from images, to `.docx` or `.pptx`).

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

**img-tool** handles resizing, format conversion and metadata for common image types.

### Compare Documents

```text
"What changed between these two contract versions?"
```

**doc-diff** reports differences between two files — useful for reviewing revisions.

### Parse Calendars

```text
"What events are in this .ics file?"
```

**ical-tool** extracts event details (title, date, time, location, attendees) from `.ics` files.

::: tip
Not sure what tool can do? Ask — "what can the pdf-tool do?" — and agent describes commands. When agent hits binary file it cannot read directly, it falls back to markitdown on its own.
:::

## How They Run

Tools are Python scripts declaring dependencies inline (PEP 723). App bundles per-platform `uv` binary and puts it on tool path, so system Python not required.

On first use, `uv` downloads matching CPython (Python 3.12) — a few seconds, then cached — and fetches each script's Python packages from PyPI. Later runs reuse cache and start immediately.

::: info
Where does output go? Created or converted files land in current working directory unless you specify path, and agent tells exact location. You can chain steps in one request — "read this PDF, extract the revenue figures, and build a spreadsheet from them" — and agent runs tools in sequence.
:::

## Networks That Block PyPI

Because first use fetches CPython and wheels from public package hosts, document tools need network access to PyPI (or approved mirror) first time each dependency set is installed. On locked-down networks, point `uv` at internal index or allow PyPI access before relying on these tools.

If runtime cannot install script dependencies, only that document operation fails — it reports error for that file. Chat, sources and every other part of app keep working.
