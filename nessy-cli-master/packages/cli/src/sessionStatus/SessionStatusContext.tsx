/**
 * @license
 * Copyright 2026 Nessy Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createContext, useContext } from 'react';
import type { SessionStatusReporter } from './session-status-reporter.js';

export const SessionStatusContext = createContext<SessionStatusReporter | null>(
  null,
);
export const useSessionStatus = () => useContext(SessionStatusContext);
