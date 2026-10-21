/**
 * Reasoning extraction. We are an API consumer: we do not suppress thinking.
 * We separate `<think>...</think>` traces from answer text so callers can
 * surface reasoning without leaking it into user-visible output text.
 */

const OPEN = '<think>';
const CLOSE = '</think>';

/**
 * Pure, whole-string split: pull every complete `<think>...</think>` span, and
 * a trailing unclosed `<think>...` span, out of `text` as reasoning.
 */
export function extractReasoning(text: string): { reasoning: string; answer: string } {
  let reasoning = '';
  let answer = '';
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf(OPEN, i);
    if (open === -1) {
      answer += text.slice(i);
      break;
    }
    answer += text.slice(i, open);
    const close = text.indexOf(CLOSE, open + OPEN.length);
    if (close === -1) {
      reasoning += text.slice(open + OPEN.length);
      i = text.length;
    } else {
      reasoning += text.slice(open + OPEN.length, close);
      i = close + CLOSE.length;
    }
  }
  return { reasoning, answer };
}

/**
 * Stateful splitter for streaming chunks where `<think>` tags may straddle
 * chunk boundaries.
 */
export class StreamingThinkSplitter {
  private inside = false;
  private pending = '';

  push(chunk: string): { reasoning: string; answer: string } {
    this.pending += chunk;
    let reasoning = '';
    let answer = '';
    for (;;) {
      if (!this.inside) {
        const idx = this.pending.indexOf(OPEN);
        if (idx === -1) {
          const safe = this.pending.length - (OPEN.length - 1);
          if (safe > 0) {
            answer += this.pending.slice(0, safe);
            this.pending = this.pending.slice(safe);
          }
          break;
        }
        answer += this.pending.slice(0, idx);
        this.pending = this.pending.slice(idx + OPEN.length);
        this.inside = true;
      } else {
        const idx = this.pending.indexOf(CLOSE);
        if (idx === -1) {
          const safe = this.pending.length - (CLOSE.length - 1);
          if (safe > 0) {
            reasoning += this.pending.slice(0, safe);
            this.pending = this.pending.slice(safe);
          }
          break;
        }
        reasoning += this.pending.slice(0, idx);
        this.pending = this.pending.slice(idx + CLOSE.length);
        this.inside = false;
      }
    }
    return { reasoning, answer };
  }

  /** Drain the buffered tail at stream end. */
  flush(): { reasoning: string; answer: string } {
    const rest = this.pending;
    this.pending = '';
    return this.inside ? { reasoning: rest, answer: '' } : { reasoning: '', answer: rest };
  }
}
