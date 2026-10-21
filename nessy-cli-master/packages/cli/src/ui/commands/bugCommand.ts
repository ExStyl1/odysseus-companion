/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import process from 'node:process';
import open from 'open';
import {
  type CommandContext,
  type SlashCommand,
  CommandKind,
} from './types.js';
import {
  buildNestorAuthHeaders,
  DEFAULT_NESTOR_BUG_REPORT_URL,
  InstallationManager,
  performNessyAuth,
} from '@nestor/nessy-cli-core';
import { MessageType } from '../types.js';
import { getExtendedSystemInfo } from '../../utils/systemInfo.js';
import { getSystemInfoFields } from '../../utils/systemInfoFields.js';
import { t } from '../../i18n/index.js';

const BUG_REPORT_TIMEOUT_MS = 30_000;
const installationManager = new InstallationManager();

interface BugReportMetadataField {
  label: string;
  value: string;
}

interface CLIBugReportResponse {
  message?: string;
  url?: string;
}

export const bugCommand: SlashCommand = {
  name: 'bug',
  get description() {
    return t('submit a bug report');
  },
  kind: CommandKind.BUILT_IN,
  action: async (context: CommandContext, args?: string): Promise<void> => {
    try {
      const systemInfo = await getExtendedSystemInfo(context);
      const fields = getSystemInfoFields(systemInfo);
      const bugReportResponse = await submitBugReport(context, args, fields);
      context.ui.addItem(
        {
          type: MessageType.INFO,
          text: formatBugReportResponseMessage(bugReportResponse),
        },
        Date.now(),
      );
      if (bugReportResponse.url?.trim()) {
        await openBugReportUrl(context, bugReportResponse.url.trim());
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      context.ui.addItem(
        {
          type: MessageType.ERROR,
          text: `Could not submit bug report: ${errorMessage}`,
        },
        Date.now(),
      );
    }
  },
};

async function submitBugReport(
  context: CommandContext,
  args: string | undefined,
  fields: BugReportMetadataField[],
): Promise<CLIBugReportResponse> {
  const config = context.services.config;
  if (!config) {
    throw new Error('Configuration is not available');
  }

  const dpCredentials = await performNessyAuth(config);

  const requestBody = {
    description: (args || '').trim(),
    metadata: fields,
    raw_command: context.invocation?.raw,
  };
  const requestId = randomUUID();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), BUG_REPORT_TIMEOUT_MS);
  const signal = context.abortSignal
    ? AbortSignal.any([context.abortSignal, controller.signal])
    : controller.signal;
  let response: Response;

  try {
    response = await fetch(getBugReportRequestUrl(), {
      method: 'POST',
      headers: buildBugReportHeaders(
        dpCredentials.jwt,
        config.getCliVersion() || 'unknown',
        requestId,
      ),
      body: JSON.stringify(requestBody),
      signal,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === 'AbortError' || controller.signal.aborted)
    ) {
      throw new Error('Bug report request timed out');
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    let responseText = '';
    try {
      responseText = await response.text();
    } catch {
      // Ignore response parsing errors for failed requests.
    }
    const details = responseText ? ` ${responseText}` : '';
    throw new Error(
      `Backend returned ${response.status} ${response.statusText}.${details}`.trim(),
    );
  }

  const data = (await response.json()) as CLIBugReportResponse;
  if (!data.message && !data.url) {
    throw new Error('Backend response does not contain message or URL');
  }

  return data;
}

function formatBugReportResponseMessage(
  response: CLIBugReportResponse,
): string {
  const message = response.message?.trim();
  const url = response.url?.trim();

  if (message && url) {
    return `${message}\n${url}`;
  }
  if (message) {
    return message;
  }
  if (url) {
    return `Bug report submitted successfully.\n${url}`;
  }
  return 'Bug report submitted successfully.';
}

function buildBugReportHeaders(
  token: string,
  cliVersion: string,
  requestId: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...buildNestorAuthHeaders(token),
    'User-Agent': `NessyCLI/${cliVersion} (${process.platform}; ${process.arch})`,
    'X-Request-Id': requestId,
  };

  const deviceID = installationManager.getInstallationId();
  if (deviceID) {
    headers['device-id'] = deviceID;
  }

  return headers;
}

function getBugReportRequestUrl(): string {
  return DEFAULT_NESTOR_BUG_REPORT_URL;
}

async function openBugReportUrl(
  context: CommandContext,
  bugReportUrl: string,
): Promise<void> {
  try {
    await open(bugReportUrl);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    context.ui.addItem(
      {
        type: MessageType.ERROR,
        text: `Could not open URL in browser: ${errorMessage}`,
      },
      Date.now(),
    );
  }
}
