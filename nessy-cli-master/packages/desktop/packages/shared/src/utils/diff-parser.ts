// [nessy-fork] desktop-permission-request-ui
/**
 * Unified diff parser for permission request UI
 * Parses git-style unified diff format and extracts lines with type information
 */

export interface DiffLine {
  type: 'add' | 'del' | 'context' | 'hunk' | 'header' | 'other';
  oldLine?: number;
  newLine?: number;
  content: string;
}

/**
 * Parses unified diff format and returns structured lines with line numbers
 */
export function parseUnifiedDiff(diffContent: string): DiffLine[] {
  const lines = diffContent.split('\n');
  const result: DiffLine[] = [];
  let currentOldLine = 0;
  let currentNewLine = 0;
  let inHunk = false;
  const hunkHeaderRegex = /^@@ -(\d+),?\d* \+(\d+),?\d* @@/;

  for (const line of lines) {
    // Check for hunk header
    const hunkMatch = line.match(hunkHeaderRegex);
    if (hunkMatch) {
      currentOldLine = parseInt(hunkMatch[1]!, 10);
      currentNewLine = parseInt(hunkMatch[2]!, 10);
      inHunk = true;
      result.push({ type: 'hunk', content: line });
      // Adjust starting point (first line number applies to first change)
      currentOldLine--;
      currentNewLine--;
      continue;
    }

    // Skip file headers
    if (!inHunk) {
      if (
        line.startsWith('diff --git') ||
        line.startsWith('--- ') ||
        line.startsWith('+++ ') ||
        line.startsWith('index ') ||
        line.startsWith('new file mode') ||
        line.startsWith('deleted file mode')
      ) {
        result.push({ type: 'header', content: line });
        continue;
      }
      // Skip other header lines
      if (line.trim() === '') {
        continue;
      }
      result.push({ type: 'other', content: line });
      continue;
    }

    // Process hunk lines
    if (line.startsWith('+')) {
      currentNewLine++;
      result.push({
        type: 'add',
        newLine: currentNewLine,
        content: line.substring(1),
      });
    } else if (line.startsWith('-')) {
      currentOldLine++;
      result.push({
        type: 'del',
        oldLine: currentOldLine,
        content: line.substring(1),
      });
    } else if (line.startsWith(' ')) {
      // Context line
      currentOldLine++;
      currentNewLine++;
      result.push({
        type: 'context',
        oldLine: currentOldLine,
        newLine: currentNewLine,
        content: line.substring(1),
      });
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file"
      result.push({ type: 'other', content: line });
    } else if (line.trim() === '') {
      // Empty line in diff
      result.push({ type: 'context', oldLine: currentOldLine + 1, newLine: currentNewLine + 1, content: '' });
      currentOldLine++;
      currentNewLine++;
    } else {
      // Other lines (shouldn't happen in valid unified diff)
      result.push({ type: 'other', content: line });
    }
  }

  return result;
}

/**
 * Extracts filename from unified diff content
 */
export function extractFilename(diffContent: string): string | null {
  const lines = diffContent.split('\n');
  for (const line of lines) {
    if (line.startsWith('+++ b/')) {
      return line.substring(6);
    }
    if (line.startsWith('+++ ')) {
      return line.substring(4);
    }
  }
  return null;
}

/**
 * Checks if diff represents a new file (only additions, no deletions)
 */
export function isNewFile(diffContent: string): boolean {
  const parsed = parseUnifiedDiff(diffContent);
  return parsed.every(
    (line) =>
      line.type === 'add' ||
      line.type === 'hunk' ||
      line.type === 'header' ||
      line.type === 'other' ||
      line.content.startsWith('diff --git') ||
      line.content.startsWith('new file mode'),
  );
}

/**
 * Returns statistics about the diff
 */
export function getDiffStats(diffContent: string): {
  additions: number;
  deletions: number;
  totalChanges: number;
} {
  const parsed = parseUnifiedDiff(diffContent);
  let additions = 0;
  let deletions = 0;

  for (const line of parsed) {
    if (line.type === 'add') additions++;
    if (line.type === 'del') deletions++;
  }

  return {
    additions,
    deletions,
    totalChanges: additions + deletions,
  };
}
