/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AgentSideConnection,
  FileSystemCapabilities,
  ReadTextFileRequest,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from '@agentclientprotocol/sdk';
import { RequestError } from '@agentclientprotocol/sdk';
import type {
  FileSystemService,
  LineEnding,
  ReadTextFileResponse,
} from '@nestor/nessy-cli-core';

const RESOURCE_NOT_FOUND_CODE = -32002;

function getErrorCode(error: unknown): unknown {
  if (error instanceof RequestError) {
    return error.code;
  }

  if (typeof error === 'object' && error !== null && 'code' in error) {
    return (error as { code?: unknown }).code;
  }

  return undefined;
}

function createEnoentError(filePath: string): NodeJS.ErrnoException {
  const err = new Error(`File not found: ${filePath}`) as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  err.errno = -2;
  err.path = filePath;
  return err;
}

export class AcpFileSystemService implements FileSystemService {
  constructor(
    private readonly connection: AgentSideConnection,
    private readonly sessionId: string,
    private readonly capabilities: FileSystemCapabilities,
    private readonly fallback: FileSystemService,
  ) {}

  async readTextFile(
    params: Omit<ReadTextFileRequest, 'sessionId'>,
  ): Promise<ReadTextFileResponse> {
    if (!this.capabilities.readTextFile) {
      return this.fallback.readTextFile(params);
    }

    let response: Awaited<ReturnType<AgentSideConnection['readTextFile']>>;
    try {
      response = await this.connection.readTextFile({
        ...params,
        sessionId: this.sessionId,
      });
    } catch (error) {
      const errorCode = getErrorCode(error);

      if (errorCode === RESOURCE_NOT_FOUND_CODE) {
        throw createEnoentError(params.path);
      }

      throw error;
    }

    // SDK 0.21 types `_meta` as an open object; narrow it to the fields the
    // core service exposes.
    // [nessy-fork] acp-elicitation-ask-user-question
    const meta = response._meta;
    return {
      content: response.content,
      ...(meta && typeof meta === 'object'
        ? {
            _meta: {
              bom: meta['bom'] as boolean | undefined,
              encoding: meta['encoding'] as string | undefined,
              originalLineCount: meta['originalLineCount'] as
                | number
                | undefined,
              lineEnding: meta['lineEnding'] as LineEnding | undefined,
            },
          }
        : {}),
    };
  }

  async writeTextFile(
    params: Omit<WriteTextFileRequest, 'sessionId'>,
  ): Promise<WriteTextFileResponse> {
    if (!this.capabilities.writeTextFile) {
      return this.fallback.writeTextFile(params);
    }

    const finalContent =
      params._meta?.['bom'] && params.content.charCodeAt(0) !== 0xfeff
        ? '\uFEFF' + params.content
        : params.content;

    await this.connection.writeTextFile({
      ...params,
      content: finalContent,
      sessionId: this.sessionId,
    });

    return { _meta: params._meta };
  }

  findFiles(fileName: string, searchPaths: readonly string[]): string[] {
    return this.fallback.findFiles(fileName, searchPaths);
  }
}
