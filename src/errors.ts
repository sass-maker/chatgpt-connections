import type { ErrorCode } from "./contracts.js";

export class ConnectionError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "ConnectionError";
    this.code = code;
    this.retryable = retryable;
  }
}

export function errorFromStatus(status: number): ConnectionError {
  if (status === 401 || status === 403) {
    return new ConnectionError("unauthorized", "The application rejected the read credential.");
  }
  if (status === 404) {
    return new ConnectionError("not_found", "The requested record was not found.");
  }
  if (status === 429) {
    return new ConnectionError("rate_limited", "The application rate-limited this read.", true);
  }
  if (status >= 500) {
    return new ConnectionError(
      "upstream_unavailable",
      "The application is temporarily unavailable.",
      true,
    );
  }
  return new ConnectionError(
    "invalid_upstream_response",
    `The application returned an unsupported status (${status}).`,
  );
}

export function asConnectionError(error: unknown): ConnectionError {
  if (error instanceof ConnectionError) return error;
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return new ConnectionError("timeout", "The application read timed out.", true);
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new ConnectionError("timeout", "The application read timed out.", true);
  }
  return new ConnectionError("upstream_unavailable", "The application read failed.", true);
}
