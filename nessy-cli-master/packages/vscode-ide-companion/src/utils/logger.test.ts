import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { createLogger } from './logger.js';

vi.mock('vscode', () => ({}));

describe('createLogger', () => {
  it('writes messages in production mode', () => {
    const appendLine = vi.fn();
    const context = {
      extensionMode: 2,
    } as vscode.ExtensionContext;
    const outputChannel = {
      appendLine,
    } as unknown as vscode.OutputChannel;

    createLogger(context, outputChannel)('Extension activated');

    expect(appendLine).toHaveBeenCalledWith('Extension activated');
  });
});
