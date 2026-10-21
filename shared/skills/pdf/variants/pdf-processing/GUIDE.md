---
name: "pdf-processing"
description: "Extract text and tables from PDF files, fill forms, merge documents. Use when working with PDF files or when the user mentions PDFs, forms, or document extraction."
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

# PDF Processing

This skill provides utilities for working with PDF documents.

## Quick Start

Use pdfplumber to extract text from PDFs:

```python
import pdfplumber

with pdfplumber.open("document.pdf") as pdf:
    text = pdf.pages[0].extract_text()
    print(text)
```

## Available Operations

1. **Text Extraction**: Extract text content from PDF pages
2. **Table Extraction**: Extract tabular data from PDFs
3. **Form Filling**: Fill PDF forms with provided data
4. **Document Merging**: Combine multiple PDFs into one

## Advanced Features

**Form filling**: See [FORMS.md](FORMS.md) for complete guide

**Utility scripts**: 
- Run `scripts/analyze_form.py` to extract form fields
- Run `scripts/extract_text.py` to extract text from a PDF

## Best Practices

1. Always validate PDF files before processing
2. Handle password-protected PDFs gracefully
3. Check for scanned PDFs that may require OCR
