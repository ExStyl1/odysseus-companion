/**
 * @license
 * Copyright 2026 Nessy Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '../../core/authType.js';
import type { ProviderConfig } from '../types.js';

/**
 * DP Authentication provider — sign-in via the `dp` CLI binary.
 *
 * Goes through the standard install pipeline (buildInstallPlan →
 * applyProviderInstallPlan → refreshAuth). The plan reduces to setting
 * `security.auth.selectedType = DP_AUTH` because:
 *   - `envKey` is empty (no API key to store; credentials are JWT-cached
 *     in ~/.nessy by `dpTokenManager` after performNessyAuth)
 *   - the model catalog is loaded into the runtime registry on every refresh
 *   - `baseUrl` is a fixed empty string (the DP binary owns the endpoint)
 *
 * `refreshAuth(DP_AUTH)` does the actual work — see `Config.refreshAuth`.
 */
export const dpAuthProvider: ProviderConfig = {
  // [nessy-fork] dp-auth-runtime-model-catalog
  id: 'dp-auth',
  label: 'DP Authentication',
  description: 'Authenticate via DP CLI (shared with IDE plugins)',
  protocol: AuthType.DP_AUTH,
  baseUrl: '',
  envKey: '',
  modelNamePrefix: '',
  uiGroup: 'dp-auth',
};
