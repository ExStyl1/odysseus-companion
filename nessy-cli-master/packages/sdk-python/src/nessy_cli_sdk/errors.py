"""Error types for nessy_cli_sdk."""

from __future__ import annotations


class NessySDKError(Exception):
    """Base error for all SDK failures."""


class ValidationError(NessySDKError):
    """Raised when query options are invalid."""


class AbortError(NessySDKError):
    """Raised when an operation is aborted by caller or transport."""


class ProcessExitError(NessySDKError):
    """Raised when nessy CLI exits with non-zero status or signal."""

    def __init__(self, message: str, exit_code: int | None = None) -> None:
        super().__init__(message)
        self.exit_code = exit_code


class ControlRequestTimeoutError(NessySDKError):
    """Raised when a control request times out waiting for response."""
