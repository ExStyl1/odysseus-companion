/**
 * DP Authentication error types
 */

// [nessy-fork] dp-auth
export enum DpAuthError {
  CantInit = 'Failed to initialize dp',
  CantLogin = 'Failed to login',
  ExecDp = 'Unexpected error while calling dp',
  TokenExchangeFailed = 'Token exchange failed',
  DownloadFailed = 'Failed to download dp',
  ChecksumMismatch = 'Checksum mismatch',
  // [nessy-fork] dp-auth-runtime-model-catalog
  ModelsUnavailable = 'DP model list is unavailable',
}

export class DpAuthServiceError extends Error {
  constructor(
    public type: DpAuthError,
    public override cause?: unknown,
  ) {
    const causeMsg =
      cause instanceof Error ? cause.message : cause ? String(cause) : '';
    super(causeMsg ? `${type}: ${causeMsg}` : type);
    this.name = 'DpAuthServiceError';
  }
}
