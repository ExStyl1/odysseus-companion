/**
 * C3.233 — the three office families stay external, and a flip has to argue
 * with a failing test.
 *
 * P6.470 asked for spreadsheets, documents and presentations to gain an in-app
 * preview on the premise that `classifyFile` was the only thing withholding
 * them. It was closed as REFUTED with an EMPTY sha cell, so the measurement
 * lived in exactly one place — a plan row — and the classifier itself said
 * nothing. The reason is now in `file-classification.ts` beside
 * `EXTERNAL_EXTENSIONS`; this file is the half a future edit cannot walk past:
 *
 * - `MarkdownSpreadsheetBlock` renders a ```spreadsheet fence of model-written
 *   JSON whose `filename` is a LABEL, not a file it opens;
 * - no OOXML reader exists in this tree (`yauzl` is the plugin-archive
 *   extractor, a zip reader that knows nothing about OOXML parts).
 *
 * The positive controls matter as much as the pins: without them a
 * `classifyFile` that returned `canPreview: false` for EVERYTHING would satisfy
 * every assertion below, which is the shape of a guard that has stopped
 * guarding.
 */
import { describe, expect, it } from 'bun:test'

import { FILE_EXTENSIONS_PATTERN, classifyFile } from '../file-classification'

describe('classifyFile — the office families are external by decision', () => {
  const externalByDecision: Record<string, readonly string[]> = {
    spreadsheets: ['xlsx', 'xls', 'xlsm'],
    documents: ['docx', 'doc'],
    presentations: ['pptx', 'ppt'],
  }

  for (const [family, extensions] of Object.entries(externalByDecision)) {
    it(`routes ${family} to the system opener, with no preview type`, () => {
      for (const ext of extensions) {
        const classified = classifyFile(`/tmp/report.${ext}`)
        expect(classified.canPreview, ext).toBe(false)
        expect(classified.type, ext).toBeNull()
        // Upper case reaches the classifier from a real path; the extension is
        // lowercased before the lookup, so this must answer the same way.
        expect(classifyFile(`/tmp/REPORT.${ext.toUpperCase()}`).canPreview, ext).toBe(false)
      }
    })
  }

  it('still DETECTS them as file links — external is not unknown', () => {
    // The distinction the row turns on: these extensions are in
    // `FILE_EXTENSIONS_PATTERN` so linkify sees a file path, and only
    // `classifyFile` withholds the overlay. A flip that dropped them from the
    // pattern would break the system-opener route this decision relies on.
    for (const ext of Object.values(externalByDecision).flat()) {
      expect(FILE_EXTENSIONS_PATTERN.split('|'), ext).toContain(ext)
    }
  })

  it('previews the types it does support — the positive control', () => {
    // Without this, a classifier that answered `canPreview: false` for every
    // input would pass every assertion above.
    expect(classifyFile('/tmp/a.png')).toEqual({ type: 'image', canPreview: true })
    expect(classifyFile('/tmp/a.md')).toEqual({ type: 'markdown', canPreview: true })
    expect(classifyFile('/tmp/a.json')).toEqual({ type: 'json', canPreview: true })
    expect(classifyFile('/tmp/a.ts')).toEqual({ type: 'code', canPreview: true })
    expect(classifyFile('/tmp/a.txt')).toEqual({ type: 'text', canPreview: true })
    // PDF is the one binary format that IS previewed, which is what makes the
    // office families a decision rather than a blanket "no binaries" rule.
    expect(classifyFile('/tmp/a.pdf')).toEqual({ type: 'pdf', canPreview: true })
  })

  it('does not confuse a spreadsheet-shaped NAME with a spreadsheet file', () => {
    // `MarkdownSpreadsheetBlock`'s `filename` field is a label of exactly this
    // shape. A `.csv` really is previewable text and a `.xlsx` really is not,
    // and the two must not be read as one "spreadsheet" family.
    expect(classifyFile('/tmp/Q1_Revenue.csv')).toEqual({ type: 'text', canPreview: true })
    expect(classifyFile('/tmp/Q1_Revenue.xlsx').canPreview).toBe(false)
  })
})
