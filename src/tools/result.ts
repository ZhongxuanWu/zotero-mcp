import type { CallToolResult } from "@modelcontextprotocol/server";

import { ZoteroApiError } from "../zotero/errors.js";
import type { ToolErrorDetails, ToolErrorEnvelope } from "./types.js";

export class ToolFailure extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details: ToolErrorDetails | undefined;

  constructor(
    code: string,
    message: string,
    options: { retryable?: boolean; details?: ToolErrorDetails } = {},
  ) {
    super(message);
    this.name = "ToolFailure";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

function errorEnvelope(error: unknown): ToolErrorEnvelope {
  if (error instanceof ToolFailure) {
    return {
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    };
  }

  if (error instanceof ZoteroApiError) {
    const details: ToolErrorDetails = {};
    if (error.status !== undefined) details.status = error.status;
    if (error.retryAfterMs !== undefined) {
      details.retry_after_ms = error.retryAfterMs;
    }
    return {
      error: {
        code: error.code,
        message: error.message,
        retryable: [
          "rate_limited",
          "service_unavailable",
          "timeout",
          "network_error",
        ].includes(error.code),
        ...(Object.keys(details).length === 0 ? {} : { details }),
      },
    };
  }

  return {
    error: {
      code: "zotero_request_failed",
      message: "The Zotero Web API request failed.",
      retryable: false,
    },
  };
}

export function toolSuccess(
  structuredContent: Record<string, unknown>,
  text: string,
): CallToolResult {
  return {
    content: [{ type: "text", text }],
    structuredContent,
  };
}

export function toolError(error: unknown): CallToolResult {
  const envelope = errorEnvelope(error);
  return {
    content: [
      {
        type: "text",
        text: `${envelope.error.code}: ${envelope.error.message}`,
      },
    ],
    structuredContent: envelope,
    isError: true,
  };
}
