/** Mattermost post character limit. */
const MAX_POST_LENGTH = 16383;

/**
 * Split a long message into chunks that fit within the Mattermost post limit.
 * Tries to split at paragraph/newline boundaries first, then at word boundaries.
 */
export function splitMessage(text: string): string[] {
  if (text.length <= MAX_POST_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_POST_LENGTH) {
      chunks.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf('\n\n', MAX_POST_LENGTH);
    if (splitAt < MAX_POST_LENGTH / 2) {
      splitAt = remaining.lastIndexOf('\n', MAX_POST_LENGTH);
    }
    if (splitAt < MAX_POST_LENGTH / 2) {
      splitAt = remaining.lastIndexOf(' ', MAX_POST_LENGTH);
    }
    if (splitAt < MAX_POST_LENGTH / 2) {
      splitAt = MAX_POST_LENGTH;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}
