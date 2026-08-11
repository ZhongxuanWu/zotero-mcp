export type ZoteroApiErrorCode =
  | "authentication_failed"
  | "permission_denied"
  | "not_found"
  | "rate_limited"
  | "service_unavailable"
  | "timeout"
  | "network_error"
  | "invalid_response"
  | "invalid_request"
  | "outside_collection_scope"
  | "request_failed";

export interface ZoteroApiErrorOptions {
  status?: number;
  retryAfterMs?: number;
}

/** An intentionally sanitized error safe to pass to an MCP client. */
export class ZoteroApiError extends Error {
  readonly code: ZoteroApiErrorCode;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(
    code: ZoteroApiErrorCode,
    message: string,
    options: ZoteroApiErrorOptions = {},
  ) {
    super(message);
    this.name = "ZoteroApiError";
    this.code = code;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}
