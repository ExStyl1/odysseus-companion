import { describe, it, expect, beforeEach } from 'vitest';
import { ThoughtStreamParser } from './thoughtStreamParser.js';

describe('ThoughtStreamParser', () => {
  let parser: ThoughtStreamParser;

  beforeEach(() => {
    parser = new ThoughtStreamParser();
  });

  describe('sync — no <think>, has </think>', () => {
    it('extracts thought before </think> and visible text after', () => {
      const result = parser.parseChunk('thinking\n</think>\n\nresponse');
      expect(result.thoughts).toEqual(['thinking\n']);
      expect(result.visibleText).toBe('\n\nresponse');
    });
  });

  describe('streaming — no <think>, </think> in later chunk', () => {
    it('buffers during detecting phase and splits on </think>', () => {
      const r1 = parser.parseChunk('think');
      expect(r1.thoughts).toEqual([]);
      expect(r1.visibleText).toBe('');

      const r2 = parser.parseChunk('ing\n</think>');
      expect(r2.thoughts).toEqual(['thinking\n']);
      expect(r2.visibleText).toBe('');

      const r3 = parser.parseChunk('\nresponse');
      expect(r3.thoughts).toEqual([]);
      expect(r3.visibleText).toBe('\nresponse');
    });
  });

  describe('streaming — no tags at all', () => {
    it('keeps buffering across \\n\\n until flush(); orphan thoughts may contain paragraph breaks', () => {
      const r1 = parser.parseChunk('hello');
      expect(r1.visibleText).toBe('');

      const r2 = parser.parseChunk('\n\nworld');
      expect(r2.visibleText).toBe('');
      expect(r2.thoughts).toEqual([]);

      const flushed = parser.flush();
      expect(flushed.visibleText).toBe('hello\n\nworld');
      expect(flushed.thoughts).toEqual([]);
    });

    it('splits orphan thought containing \\n\\n on </think> in a later chunk', () => {
      const r1 = parser.parseChunk('Paragraph one.\n\n');
      expect(r1.thoughts).toEqual([]);
      expect(r1.visibleText).toBe('');

      const r2 = parser.parseChunk('Paragraph two.\n</think>\n\nAnswer.');
      expect(r2.thoughts).toEqual(['Paragraph one.\n\nParagraph two.\n']);
      expect(r2.visibleText).toBe('\n\nAnswer.');
    });
  });

  describe('standard <think>...</think>', () => {
    it('works in sync mode', () => {
      const result = parser.parseChunk('<think>reasoning</think>visible');
      expect(result.thoughts).toEqual(['reasoning']);
      expect(result.visibleText).toBe('visible');
    });

    it('works across streaming chunks', () => {
      const r1 = parser.parseChunk('<think>reas');
      expect(r1.thoughts).toEqual([]);
      expect(r1.visibleText).toBe('');

      const r2 = parser.parseChunk('oning</think>text');
      expect(r2.thoughts).toEqual(['reasoning']);
      expect(r2.visibleText).toBe('text');
    });
  });

  describe('<think> in second chunk', () => {
    it('switches to normal mode when <think> appears', () => {
      const r1 = parser.parseChunk('<think>reasoning');
      expect(r1.visibleText).toBe('');

      const r2 = parser.parseChunk('</think>text');
      expect(r2.thoughts).toEqual(['reasoning']);
      expect(r2.visibleText).toBe('text');
    });
  });

  describe('flush() in detecting phase', () => {
    it('returns buffer as visibleText', () => {
      parser.parseChunk('partial content');
      const result = parser.flush();
      expect(result.thoughts).toEqual([]);
      expect(result.visibleText).toBe('partial content');
    });
  });

  describe('flush() with empty buffer', () => {
    it('returns empty result', () => {
      const result = parser.flush();
      expect(result.thoughts).toEqual([]);
      expect(result.visibleText).toBe('');
    });
  });

  describe('reset()', () => {
    it('resets phase back to detecting', () => {
      parser.parseChunk('<think>x</think>y');
      parser.reset();
      // After reset, should be back in detecting phase
      const r = parser.parseChunk('thought\n</think>\nvisible');
      expect(r.thoughts).toEqual(['thought\n']);
      expect(r.visibleText).toBe('\nvisible');
    });
  });
});
