/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export const IDE_DEFINITIONS = {
  devin: { name: 'devin', displayName: 'Devin' },
  replit: { name: 'replit', displayName: 'Replit' },
  cursor: { name: 'cursor', displayName: 'Cursor' },
  cloudshell: { name: 'cloudshell', displayName: 'Cloud Shell' },
  codespaces: { name: 'codespaces', displayName: 'GitHub Codespaces' },
  firebasestudio: { name: 'firebasestudio', displayName: 'Firebase Studio' },
  trae: { name: 'trae', displayName: 'Trae' },
  vscode: { name: 'vscode', displayName: 'VS Code' },
  vscodefork: { name: 'vscodefork', displayName: 'IDE' },
  intellij: { name: 'intellij', displayName: 'IntelliJ IDEA' },
  jetbrains: { name: 'jetbrains', displayName: 'JetBrains IDE' },
} as const;

export interface IdeInfo {
  name: string;
  displayName: string;
}

export function isCloudShell(): boolean {
  return !!(process.env['EDITOR_IN_CLOUD_SHELL'] || process.env['CLOUD_SHELL']);
}

// [nessy-fork] vscode-internal-companion
export function detectIdeFromEnv(): IdeInfo {
  if (process.env['__COG_BASHRC_SOURCED']) {
    return IDE_DEFINITIONS.devin;
  }
  if (process.env['REPLIT_USER']) {
    return IDE_DEFINITIONS.replit;
  }
  if (process.env['CURSOR_TRACE_ID']) {
    return IDE_DEFINITIONS.cursor;
  }
  if (process.env['CODESPACES']) {
    return IDE_DEFINITIONS.codespaces;
  }
  if (isCloudShell()) {
    return IDE_DEFINITIONS.cloudshell;
  }
  if (process.env['TERM_PRODUCT'] === 'Trae') {
    return IDE_DEFINITIONS.trae;
  }
  if (process.env['MONOSPACE_ENV']) {
    return IDE_DEFINITIONS.firebasestudio;
  }
  // Detect IntelliJ IDEA and other JetBrains IDEs
  // JB_IDE_NAME is set by JetBrains IDEs (e.g., "IntelliJ IDEA", "WebStorm", "PyCharm")
  if (process.env['JB_IDE_NAME']) {
    const ideName = process.env['JB_IDE_NAME'].toLowerCase();
    if (ideName.includes('intellij')) {
      return IDE_DEFINITIONS.intellij;
    }
    return IDE_DEFINITIONS.jetbrains;
  }
  // Fallback for JetBrains terminal integration
  if (process.env['JB_TERMINAL_SESSION_ID']) {
    return IDE_DEFINITIONS.jetbrains;
  }
  return IDE_DEFINITIONS.vscode;
}

function verifyVSCode(
  ide: IdeInfo,
  ideProcessInfo: {
    pid: number;
    command: string;
  },
): IdeInfo {
  if (ide.name !== IDE_DEFINITIONS.vscode.name) {
    return ide;
  }
  if (
    ideProcessInfo.command &&
    ideProcessInfo.command.toLowerCase().includes('code')
  ) {
    return IDE_DEFINITIONS.vscode;
  }
  return IDE_DEFINITIONS.vscodefork;
}

export function detectIde(
  ideProcessInfo: {
    pid: number;
    command: string;
  },
  ideInfoFromFile?: { name?: string; displayName?: string },
): IdeInfo | undefined {
  if (ideInfoFromFile?.name && ideInfoFromFile.displayName) {
    return {
      name: ideInfoFromFile.name,
      displayName: ideInfoFromFile.displayName,
    };
  }

  const termProgram = process.env['TERM_PROGRAM'];

  // Check for JetBrains IDEs first (they don't set TERM_PROGRAM=vscode)
  // But only if TERM_PROGRAM is not set to vscode (to avoid false positives in tests)
  if (termProgram !== 'vscode') {
    const jetbrainsIde = detectJetBrainsIde();
    if (jetbrainsIde) {
      return jetbrainsIde;
    }
  }

  // Only VSCode-based integrations are currently supported.
  if (termProgram !== 'vscode') {
    return undefined;
  }

  const ide = detectIdeFromEnv();
  return verifyVSCode(ide, ideProcessInfo);
}

function detectJetBrainsIde(): IdeInfo | undefined {
  // Primary detection: JetBrains terminal sets TERMINAL_EMULATOR=JetBrains-JediTerm
  // This is the most reliable indicator
  if (process.env['TERMINAL_EMULATOR'] === 'JetBrains-JediTerm') {
    // Check for specific IDE name if available
    const ideName = process.env['JB_IDE_NAME']?.toLowerCase() || '';
    if (ideName.includes('intellij')) {
      return IDE_DEFINITIONS.intellij;
    }
    if (ideName.includes('webstorm')) {
      return IDE_DEFINITIONS.jetbrains;
    }
    if (ideName.includes('pycharm')) {
      return IDE_DEFINITIONS.jetbrains;
    }
    // Default to IntelliJ IDEA if no specific name
    return IDE_DEFINITIONS.intellij;
  }

  // Secondary detection: JB_IDE_NAME set by newer JetBrains plugin versions
  if (process.env['JB_IDE_NAME']) {
    const ideName = process.env['JB_IDE_NAME'].toLowerCase();
    if (ideName.includes('intellij')) {
      return IDE_DEFINITIONS.intellij;
    }
    return IDE_DEFINITIONS.jetbrains;
  }

  // Tertiary detection: IDEA_INITIAL_DIRECTORY set in IntelliJ-based IDEs
  if (process.env['IDEA_INITIAL_DIRECTORY']) {
    return IDE_DEFINITIONS.intellij;
  }

  // Quaternary detection: JB_TERMINAL_SESSION_ID
  if (process.env['JB_TERMINAL_SESSION_ID']) {
    return IDE_DEFINITIONS.jetbrains;
  }

  return undefined;
}
