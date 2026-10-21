/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { detectIde, IDE_DEFINITIONS } from './detect-ide.js';

describe('detectIde', () => {
  const ideProcessInfo = { pid: 123, command: 'some/path/to/code' };
  const ideProcessInfoNoCode = { pid: 123, command: 'some/path/to/fork' };

  // Clear all IDE-related environment variables before each test
  beforeEach(() => {
    vi.stubEnv('__COG_BASHRC_SOURCED', '');
    vi.stubEnv('REPLIT_USER', '');
    vi.stubEnv('CURSOR_TRACE_ID', '');
    vi.stubEnv('CODESPACES', '');
    vi.stubEnv('EDITOR_IN_CLOUD_SHELL', '');
    vi.stubEnv('CLOUD_SHELL', '');
    vi.stubEnv('TERM_PRODUCT', '');
    vi.stubEnv('MONOSPACE_ENV', '');
    vi.stubEnv('TERM_PROGRAM', '');
    vi.stubEnv('JB_IDE_NAME', '');
    vi.stubEnv('JB_TERMINAL_SESSION_ID', '');
    vi.stubEnv('TERMINAL_EMULATOR', '');
    vi.stubEnv('IDEA_INITIAL_DIRECTORY', '');
    vi.stubEnv('DETECT_VSCODE', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('should return undefined if TERM_PROGRAM is not vscode and no JetBrains indicators', () => {
    // Use a command that doesn't match any JetBrains executable
    const nonIdeProcessInfo = { pid: 123, command: '/usr/bin/some-other-app' };
    expect(detectIde(nonIdeProcessInfo)).toBeUndefined();
  });

  it('should detect Devin', () => {
    vi.stubEnv('TERM_PROGRAM', 'vscode');
    vi.stubEnv('__COG_BASHRC_SOURCED', '1');
    expect(detectIde(ideProcessInfo)).toBe(IDE_DEFINITIONS.devin);
  });

  it('should detect Replit', () => {
    vi.stubEnv('TERM_PROGRAM', 'vscode');
    vi.stubEnv('REPLIT_USER', 'testuser');
    expect(detectIde(ideProcessInfo)).toBe(IDE_DEFINITIONS.replit);
  });

  it('should detect Cursor', () => {
    vi.stubEnv('TERM_PROGRAM', 'vscode');
    vi.stubEnv('CURSOR_TRACE_ID', 'some-id');
    expect(detectIde(ideProcessInfo)).toBe(IDE_DEFINITIONS.cursor);
  });

  it('should detect Codespaces', () => {
    vi.stubEnv('TERM_PROGRAM', 'vscode');
    vi.stubEnv('CODESPACES', 'true');
    expect(detectIde(ideProcessInfo)).toBe(IDE_DEFINITIONS.codespaces);
  });

  it('should detect Cloud Shell via EDITOR_IN_CLOUD_SHELL', () => {
    vi.stubEnv('TERM_PROGRAM', 'vscode');
    vi.stubEnv('EDITOR_IN_CLOUD_SHELL', 'true');
    expect(detectIde(ideProcessInfo)).toBe(IDE_DEFINITIONS.cloudshell);
  });

  it('should detect Cloud Shell via CLOUD_SHELL', () => {
    vi.stubEnv('TERM_PROGRAM', 'vscode');
    vi.stubEnv('CLOUD_SHELL', 'true');
    expect(detectIde(ideProcessInfo)).toBe(IDE_DEFINITIONS.cloudshell);
  });

  it('should detect Trae', () => {
    vi.stubEnv('TERM_PROGRAM', 'vscode');
    vi.stubEnv('TERM_PRODUCT', 'Trae');
    expect(detectIde(ideProcessInfo)).toBe(IDE_DEFINITIONS.trae);
  });

  it('should detect Firebase Studio via MONOSPACE_ENV', () => {
    vi.stubEnv('TERM_PROGRAM', 'vscode');
    vi.stubEnv('MONOSPACE_ENV', 'true');
    expect(detectIde(ideProcessInfo)).toBe(IDE_DEFINITIONS.firebasestudio);
  });

  it('should detect VSCode when no other IDE is detected and command includes "code"', () => {
    vi.stubEnv('TERM_PROGRAM', 'vscode');
    vi.stubEnv('MONOSPACE_ENV', '');
    expect(detectIde(ideProcessInfo)).toBe(IDE_DEFINITIONS.vscode);
  });

  it('should detect VSCodeFork when no other IDE is detected and command does not include "code"', () => {
    vi.stubEnv('TERM_PROGRAM', 'vscode');
    vi.stubEnv('MONOSPACE_ENV', '');
    expect(detectIde(ideProcessInfoNoCode)).toBe(IDE_DEFINITIONS.vscodefork);
  });

  it('should detect IntelliJ IDEA via JB_IDE_NAME', () => {
    vi.stubEnv('JB_IDE_NAME', 'IntelliJ IDEA');
    // Should detect even without TERM_PROGRAM=vscode
    vi.stubEnv('TERM_PROGRAM', '');
    expect(detectIde(ideProcessInfo)).toBe(IDE_DEFINITIONS.intellij);
  });

  it('should detect JetBrains IDE via JB_IDE_NAME', () => {
    vi.stubEnv('JB_IDE_NAME', 'WebStorm');
    vi.stubEnv('TERM_PROGRAM', '');
    expect(detectIde(ideProcessInfo)).toBe(IDE_DEFINITIONS.jetbrains);
  });

  it('should detect JetBrains IDE via TERMINAL_EMULATOR=JetBrains-JediTerm', () => {
    vi.stubEnv('TERMINAL_EMULATOR', 'JetBrains-JediTerm');
    vi.stubEnv('TERM_PROGRAM', '');
    expect(detectIde(ideProcessInfo)).toBe(IDE_DEFINITIONS.intellij);
  });

  it('should detect IntelliJ IDEA via IDEA_INITIAL_DIRECTORY', () => {
    vi.stubEnv('IDEA_INITIAL_DIRECTORY', '/path/to/project');
    vi.stubEnv('TERM_PROGRAM', '');
    expect(detectIde(ideProcessInfo)).toBe(IDE_DEFINITIONS.intellij);
  });

  it('should detect JetBrains IDE via JB_TERMINAL_SESSION_ID', () => {
    vi.stubEnv('JB_TERMINAL_SESSION_ID', '12345');
    vi.stubEnv('TERM_PROGRAM', '');
    // JB_TERMINAL_SESSION_ID alone should trigger JetBrains detection
    const result = detectIde(ideProcessInfo);
    expect(result).toBe(IDE_DEFINITIONS.jetbrains);
  });
});

describe('detectIde with ideInfoFromFile', () => {
  const ideProcessInfo = { pid: 123, command: 'some/path/to/code' };

  beforeEach(() => {
    vi.stubEnv('__COG_BASHRC_SOURCED', '');
    vi.stubEnv('REPLIT_USER', '');
    vi.stubEnv('CURSOR_TRACE_ID', '');
    vi.stubEnv('CODESPACES', '');
    vi.stubEnv('EDITOR_IN_CLOUD_SHELL', '');
    vi.stubEnv('CLOUD_SHELL', '');
    vi.stubEnv('TERM_PRODUCT', '');
    vi.stubEnv('MONOSPACE_ENV', '');
    vi.stubEnv('TERM_PROGRAM', '');
    vi.stubEnv('JB_IDE_NAME', '');
    vi.stubEnv('JB_TERMINAL_SESSION_ID', '');
    vi.stubEnv('TERMINAL_EMULATOR', '');
    vi.stubEnv('IDEA_INITIAL_DIRECTORY', '');
    vi.stubEnv('DETECT_VSCODE', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('should use the name and displayName from the file', () => {
    const ideInfoFromFile = {
      name: 'custom-ide',
      displayName: 'Custom IDE',
    };
    expect(detectIde(ideProcessInfo, ideInfoFromFile)).toEqual(ideInfoFromFile);
  });

  it('should fall back to env detection if name is missing', () => {
    const ideInfoFromFile = { displayName: 'Custom IDE' };
    vi.stubEnv('TERM_PROGRAM', 'vscode');
    expect(detectIde(ideProcessInfo, ideInfoFromFile)).toBe(
      IDE_DEFINITIONS.vscode,
    );
  });

  it('should fall back to env detection if displayName is missing', () => {
    const ideInfoFromFile = { name: 'custom-ide' };
    vi.stubEnv('TERM_PROGRAM', 'vscode');
    expect(detectIde(ideProcessInfo, ideInfoFromFile)).toBe(
      IDE_DEFINITIONS.vscode,
    );
  });
});
