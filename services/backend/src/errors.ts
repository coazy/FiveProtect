import type { ProtocolError } from '@fiveprotect/protocol';

/**
 * An error with a stable machine-readable code and an HTTP status.
 *
 * The message is for operators and logs. It never explains which check failed to a caller
 * that has not earned that information — the companion in particular learns only whether
 * its report was accepted, never what it implied (ADR 0004).
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  toPayload(requestId?: string): ProtocolError {
    return requestId === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, requestId };
  }

  static badRequest(code: string, message: string): ApiError {
    return new ApiError(400, code, message);
  }

  static unauthorized(message = 'server key is missing or invalid'): ApiError {
    // Deliberately one code for every authentication failure: distinguishing "unknown key"
    // from "wrong key" turns the endpoint into an oracle for enumerating servers.
    return new ApiError(401, 'unauthorized', message);
  }

  static forbidden(code: string, message: string): ApiError {
    return new ApiError(403, code, message);
  }

  static notFound(code: string, message: string): ApiError {
    return new ApiError(404, code, message);
  }

  static conflict(code: string, message: string): ApiError {
    return new ApiError(409, code, message);
  }

  static internal(message = 'internal error'): ApiError {
    return new ApiError(500, 'internal_error', message);
  }
}
