/**
 * @license
 * Copyright 2025 Nessy CLI Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { getProjectHash } from '@nestor/nessy-cli-core';
import { getRuntimeBaseDir } from '../utils/paths.js';
import type { NessySession } from './nessySessionReader.js';

/**
 * Nessy Session Manager
 *
 * This service provides direct filesystem access to load sessions.
 *
 * Note: Sessions are auto-saved by the CLI's ChatRecordingService.
 * This class is primarily used as a fallback mechanism for loading sessions
 * when ACP methods are unavailable or fail.
 */
export class NessySessionManager {
  /**
   * Get the session directory for a project with backward compatibility
   */
  private getSessionDir(workingDir: string): string {
    const projectHash = getProjectHash(workingDir);
    const sessionDir = path.join(
      getRuntimeBaseDir(),
      'tmp',
      projectHash,
      'chats',
    );
    return sessionDir;
  }

  /**
   * Generate a new session ID
   */
  private generateSessionId(): string {
    return crypto.randomUUID();
  }

  /**
   * Load a saved session by name
   *
   * @param sessionName - Name/tag of the session to load
   * @param workingDir - Current working directory
   * @returns Loaded session or null if not found
   */
  async loadSession(
    sessionId: string,
    workingDir: string,
  ): Promise<NessySession | null> {
    try {
      const sessionDir = this.getSessionDir(workingDir);
      const filename = `session-${sessionId}.json`;
      const filePath = path.join(sessionDir, filename);

      if (!fs.existsSync(filePath)) {
        console.log(`[NessySessionManager] Session file not found: ${filePath}`);
        return null;
      }

      const content = fs.readFileSync(filePath, 'utf-8');
      const session = JSON.parse(content) as NessySession;

      console.log(`[NessySessionManager] Session loaded: ${filePath}`);
      return session;
    } catch (error) {
      console.error('[NessySessionManager] Failed to load session:', error);
      return null;
    }
  }

  /**
   * List all saved sessions
   *
   * @param workingDir - Current working directory
   * @returns Array of session objects
   */
  async listSessions(workingDir: string): Promise<NessySession[]> {
    try {
      const sessionDir = this.getSessionDir(workingDir);

      if (!fs.existsSync(sessionDir)) {
        return [];
      }

      const files = fs
        .readdirSync(sessionDir)
        .filter(
          (file) => file.startsWith('session-') && file.endsWith('.json'),
        );

      const sessions: NessySession[] = [];
      for (const file of files) {
        try {
          const filePath = path.join(sessionDir, file);
          const content = fs.readFileSync(filePath, 'utf-8');
          const session = JSON.parse(content) as NessySession;
          sessions.push(session);
        } catch (error) {
          console.error(
            `[NessySessionManager] Failed to read session file ${file}:`,
            error,
          );
        }
      }

      // Sort by last updated time (newest first)
      sessions.sort(
        (a, b) =>
          new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime(),
      );

      return sessions;
    } catch (error) {
      console.error('[NessySessionManager] Failed to list sessions:', error);
      return [];
    }
  }

  /**
   * Delete a saved session
   *
   * @param sessionId - ID of the session to delete
   * @param workingDir - Current working directory
   * @returns True if deleted successfully, false otherwise
   */
  async deleteSession(sessionId: string, workingDir: string): Promise<boolean> {
    try {
      const sessionDir = this.getSessionDir(workingDir);
      const filename = `session-${sessionId}.json`;
      const filePath = path.join(sessionDir, filename);

      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`[NessySessionManager] Session deleted: ${filePath}`);
        return true;
      }

      return false;
    } catch (error) {
      console.error('[NessySessionManager] Failed to delete session:', error);
      return false;
    }
  }
}
