// [nessy-fork] desktop-permission-request-ui
import { describe, it, expect } from 'vitest'
import {
  parseUnifiedDiff,
  extractFilename,
  isNewFile,
  getDiffStats,
  type DiffLine,
} from '../diff-parser'

describe('diff-parser', () => {
  const sampleDiff = `diff --git a/test.md b/test.md
index 1234567..abcdefg 100644
--- a/test.md
+++ b/test.md
@@ -1,5 +1,6 @@
 # Title
 
-Old line
+New line
+Added line
 Context line
 Another context`

  describe('parseUnifiedDiff', () => {
    it('should parse unified diff with hunks', () => {
      const result = parseUnifiedDiff(sampleDiff)
      
      expect(result.length).toBeGreaterThan(0)
      expect(result.some((l) => l.type === 'hunk')).toBe(true)
      expect(result.some((l) => l.type === 'add')).toBe(true)
      expect(result.some((l) => l.type === 'del')).toBe(true)
      expect(result.some((l) => l.type === 'context')).toBe(true)
    })

    it('should extract line numbers for additions and deletions', () => {
      const result = parseUnifiedDiff(sampleDiff)
      
      const addedLines = result.filter((l) => l.type === 'add')
      const deletedLines = result.filter((l) => l.type === 'del')
      
      expect(addedLines.length).toBe(2)
      expect(addedLines[0]?.newLine).toBeDefined()
      expect(deletedLines.length).toBe(1)
      expect(deletedLines[0]?.oldLine).toBeDefined()
    })

    it('should handle context lines with both old and new line numbers', () => {
      const result = parseUnifiedDiff(sampleDiff)
      
      const contextLines = result.filter((l) => l.type === 'context')
      
      expect(contextLines.length).toBeGreaterThan(0)
      contextLines.forEach((line) => {
        expect(line.oldLine).toBeDefined()
        expect(line.newLine).toBeDefined()
      })
    })

    it('should skip file headers', () => {
      const result = parseUnifiedDiff(sampleDiff)
      
      const headerLines = result.filter((l) => l.type === 'header')
      expect(headerLines.length).toBeGreaterThan(0)
    })

    it('should handle empty diff', () => {
      const result = parseUnifiedDiff('')
      expect(result).toEqual([])
    })

    it('should handle diff with no changes (only context)', () => {
      const contextOnlyDiff = `--- a/test.txt
+++ b/test.txt
@@ -1,3 +1,3 @@
 line 1
 line 2
 line 3`
      
      const result = parseUnifiedDiff(contextOnlyDiff)
      expect(result.some((l) => l.type === 'context')).toBe(true)
      expect(result.some((l) => l.type === 'add')).toBe(false)
      expect(result.some((l) => l.type === 'del')).toBe(false)
    })
  })

  describe('extractFilename', () => {
    it('should extract filename from +++ line', () => {
      const filename = extractFilename(sampleDiff)
      expect(filename).toBe('test.md')
    })

    it('should return null for diff without filename', () => {
      const noFilenameDiff = `@@ -1,3 +1,3 @@
 line 1
 line 2`
      
      const filename = extractFilename(noFilenameDiff)
      expect(filename).toBeNull()
    })
  })

  describe('isNewFile', () => {
    it('should detect new file (only additions)', () => {
      const newFileDiff = `diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+Line 1
+Line 2`
      
      expect(isNewFile(newFileDiff)).toBe(true)
    })

    it('should return false for file with deletions', () => {
      expect(isNewFile(sampleDiff)).toBe(false)
    })
  })

  describe('getDiffStats', () => {
    it('should count additions and deletions', () => {
      const stats = getDiffStats(sampleDiff)
      
      expect(stats.additions).toBe(2)
      expect(stats.deletions).toBe(1)
      expect(stats.totalChanges).toBe(3)
    })

    it('should return zero for empty diff', () => {
      const stats = getDiffStats('')
      
      expect(stats.additions).toBe(0)
      expect(stats.deletions).toBe(0)
      expect(stats.totalChanges).toBe(0)
    })

    it('should handle new file (only additions)', () => {
      const newFileDiff = `diff --git a/new.txt b/new.txt
new file mode 100644
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,3 @@
+Line 1
+Line 2
+Line 3`
      
      const stats = getDiffStats(newFileDiff)
      expect(stats.additions).toBe(3)
      expect(stats.deletions).toBe(0)
    })
  })

  describe('edge cases', () => {
    it('should handle "No newline at end of file" marker', () => {
      const diffWithNoNewline = `--- a/test.txt
+++ b/test.txt
@@ -1 +1 @@
-old content
\\ No newline at end of file
+new content`
      
      const result = parseUnifiedDiff(diffWithNoNewline)
      expect(result.some((l) => l.type === 'other')).toBe(true)
    })

    it('should handle multiple hunks', () => {
      const multiHunkDiff = `--- a/test.txt
+++ b/test.txt
@@ -1,3 +1,3 @@
 line 1
-old line
+new line
 line 3
@@ -10,3 +10,4 @@
 line 10
+added line
 line 11
 line 12`
      
      const result = parseUnifiedDiff(multiHunkDiff)
      const hunks = result.filter((l) => l.type === 'hunk')
      expect(hunks.length).toBe(2)
    })

    it('should handle empty lines in diff', () => {
      const diffWithEmptyLines = `--- a/test.txt
+++ b/test.txt
@@ -1,4 +1,4 @@
 line 1

-old
+new

 line 4`
      
      const result = parseUnifiedDiff(diffWithEmptyLines)
      expect(result.length).toBeGreaterThan(0)
    })
  })
})
