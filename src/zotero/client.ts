import { ZoteroApiError } from "./errors.js";
import type {
  ZoteroClientOptions,
  ZoteroFulltext,
  ZoteroItem,
  ZoteroKeyInfo,
  ZoteroPage,
  ZoteroPageOptions,
  ZoteroSearchItemsOptions,
} from "./types.js";

const DEFAULT_BASE_URL = "https://api.zotero.org";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const FALLBACK_RETRY_DELAY_MS = 1_000;

interface RequestResult<T> {
  data: T;
  response: Response;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseNonNegativeInteger(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) {
    return null;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function requirePageOptions(
  options: ZoteroPageOptions,
): Required<ZoteroPageOptions> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const start = options.start ?? 0;

  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new ZoteroApiError(
      "invalid_request",
      `limit must be an integer between 1 and ${MAX_LIMIT}.`,
    );
  }
  if (!Number.isInteger(start) || start < 0) {
    throw new ZoteroApiError(
      "invalid_request",
      "start must be a non-negative integer.",
    );
  }

  return { limit, start };
}

function requireItemKey(itemKey: string): string {
  const normalized = itemKey.trim();
  if (normalized.length === 0) {
    throw new ZoteroApiError("invalid_request", "itemKey must not be empty.");
  }
  return normalized;
}

function parseRetryHeader(value: string | null, now: number): number | null {
  if (value === null) {
    return null;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1_000);
  }

  const date = Date.parse(value);
  if (Number.isNaN(date)) {
    return null;
  }
  return Math.max(0, date - now);
}

function validateItem(value: unknown): ZoteroItem {
  if (!isRecord(value) || !isRecord(value.data)) {
    throw new ZoteroApiError(
      "invalid_response",
      "Zotero returned an invalid item response.",
    );
  }

  const { data } = value;
  if (
    typeof value.key !== "string" ||
    !Number.isSafeInteger(value.version) ||
    typeof data.key !== "string" ||
    !Number.isSafeInteger(data.version) ||
    typeof data.itemType !== "string"
  ) {
    throw new ZoteroApiError(
      "invalid_response",
      "Zotero returned an invalid item response.",
    );
  }

  return value as unknown as ZoteroItem;
}

function validateFulltext(value: unknown): ZoteroFulltext {
  if (!isRecord(value) || typeof value.content !== "string") {
    throw new ZoteroApiError(
      "invalid_response",
      "Zotero returned an invalid full-text response.",
    );
  }

  for (const field of [
    "indexedPages",
    "totalPages",
    "indexedChars",
    "totalChars",
  ] as const) {
    const fieldValue = value[field];
    if (
      fieldValue !== undefined &&
      (!Number.isSafeInteger(fieldValue) || (fieldValue as number) < 0)
    ) {
      throw new ZoteroApiError(
        "invalid_response",
        "Zotero returned an invalid full-text response.",
      );
    }
  }

  return value as unknown as ZoteroFulltext;
}

export class ZoteroClient {
  readonly #apiKey: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #now: () => number;

  #keyInfo: ZoteroKeyInfo | undefined;
  #keyInfoPromise: Promise<ZoteroKeyInfo> | undefined;
  #blockedUntilMs = 0;
  #requestQueue: Promise<void> = Promise.resolve();

  constructor(options: ZoteroClientOptions) {
    const apiKey = options.apiKey.trim();
    if (apiKey.length === 0) {
      throw new ZoteroApiError(
        "authentication_failed",
        "A Zotero API key is required.",
      );
    }
    if (
      options.timeoutMs !== undefined &&
      (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
    ) {
      throw new ZoteroApiError(
        "invalid_request",
        "timeoutMs must be a positive number.",
      );
    }
    if (
      options.maxRetries !== undefined &&
      (!Number.isInteger(options.maxRetries) || options.maxRetries < 0)
    ) {
      throw new ZoteroApiError(
        "invalid_request",
        "maxRetries must be a non-negative integer.",
      );
    }

    this.#apiKey = apiKey;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#now = options.now ?? Date.now;
  }

  async getCurrentUser(): Promise<ZoteroKeyInfo> {
    if (this.#keyInfo !== undefined) {
      return this.#keyInfo;
    }
    if (this.#keyInfoPromise !== undefined) {
      return this.#keyInfoPromise;
    }

    this.#keyInfoPromise = this.#discoverCurrentUser();
    try {
      this.#keyInfo = await this.#keyInfoPromise;
      return this.#keyInfo;
    } finally {
      this.#keyInfoPromise = undefined;
    }
  }

  async searchItems(
    options: ZoteroSearchItemsOptions = {},
  ): Promise<ZoteroPage<ZoteroItem>> {
    const page = requirePageOptions(options);
    const user = await this.getCurrentUser();
    const query = new URLSearchParams({
      limit: String(page.limit),
      start: String(page.start),
    });

    if (options.q !== undefined) query.set("q", options.q);
    if (options.qmode !== undefined) query.set("qmode", options.qmode);
    if (options.itemType !== undefined) query.set("itemType", options.itemType);
    if (options.tag !== undefined) {
      const tags =
        typeof options.tag === "string" ? [options.tag] : options.tag;
      for (const tag of tags) query.append("tag", tag);
    }

    return this.#getItemsPage(`/users/${user.userID}/items/top`, query, page);
  }

  async getItem(itemKey: string): Promise<ZoteroItem> {
    const key = requireItemKey(itemKey);
    const user = await this.getCurrentUser();
    const result = await this.#requestJson<unknown>(
      `/users/${user.userID}/items/${encodeURIComponent(key)}`,
    );
    return validateItem(result.data);
  }

  async getItemChildren(
    itemKey: string,
    options: ZoteroPageOptions = {},
  ): Promise<ZoteroPage<ZoteroItem>> {
    const key = requireItemKey(itemKey);
    const page = requirePageOptions(options);
    const user = await this.getCurrentUser();
    const query = new URLSearchParams({
      limit: String(page.limit),
      start: String(page.start),
    });

    return this.#getItemsPage(
      `/users/${user.userID}/items/${encodeURIComponent(key)}/children`,
      query,
      page,
    );
  }

  async getFulltext(attachmentKey: string): Promise<ZoteroFulltext> {
    const key = requireItemKey(attachmentKey);
    const user = await this.getCurrentUser();
    const result = await this.#requestJson<unknown>(
      `/users/${user.userID}/items/${encodeURIComponent(key)}/fulltext`,
    );
    return validateFulltext(result.data);
  }

  async #discoverCurrentUser(): Promise<ZoteroKeyInfo> {
    const result = await this.#requestJson<unknown>("/keys/current");
    if (!isRecord(result.data)) {
      throw new ZoteroApiError(
        "invalid_response",
        "Zotero returned invalid API-key information.",
      );
    }

    const userID = result.data.userID;
    const access = result.data.access;
    if (
      !Number.isSafeInteger(userID) ||
      (userID as number) <= 0 ||
      !isRecord(access)
    ) {
      throw new ZoteroApiError(
        "invalid_response",
        "Zotero returned invalid API-key information.",
      );
    }

    const userAccess = access.user;
    if (!isRecord(userAccess) || userAccess.library !== true) {
      throw new ZoteroApiError(
        "permission_denied",
        "The Zotero API key does not grant access to the personal library.",
        { status: 403 },
      );
    }

    return result.data as unknown as ZoteroKeyInfo;
  }

  async #getItemsPage(
    path: string,
    query: URLSearchParams,
    page: Required<ZoteroPageOptions>,
  ): Promise<ZoteroPage<ZoteroItem>> {
    const result = await this.#requestJson<unknown>(path, query);
    if (!Array.isArray(result.data)) {
      throw new ZoteroApiError(
        "invalid_response",
        "Zotero returned an invalid item-list response.",
      );
    }

    const items = result.data.map(validateItem);
    const totalHeader = parseNonNegativeInteger(
      result.response.headers.get("Total-Results"),
    );
    if (totalHeader === null) {
      throw new ZoteroApiError(
        "invalid_response",
        "Zotero did not return a valid Total-Results header.",
      );
    }

    const candidateNext = page.start + items.length;
    return {
      items,
      totalResults: totalHeader,
      start: page.start,
      limit: page.limit,
      nextStart:
        items.length > 0 && candidateNext < totalHeader ? candidateNext : null,
    };
  }

  #requestJson<T>(
    path: string,
    query?: URLSearchParams,
  ): Promise<RequestResult<T>> {
    const request = this.#requestQueue.then(
      () => this.#executeJsonRequest<T>(path, query),
      () => this.#executeJsonRequest<T>(path, query),
    );
    this.#requestQueue = request.then(
      () => undefined,
      () => undefined,
    );
    return request;
  }

  async #executeJsonRequest<T>(
    path: string,
    query?: URLSearchParams,
  ): Promise<RequestResult<T>> {
    const url = new URL(`${this.#baseUrl}${path}`);
    if (query !== undefined) {
      url.search = query.toString();
    }

    for (let attempt = 0; attempt <= this.#maxRetries; attempt += 1) {
      await this.#waitForRequestWindow();
      const response = await this.#fetchOnce(url);
      this.#recordBackoff(response.headers.get("Backoff"));

      if (response.ok) {
        let data: unknown;
        try {
          data = await response.json();
        } catch {
          throw new ZoteroApiError(
            "invalid_response",
            "Zotero returned a response that was not valid JSON.",
            { status: response.status },
          );
        }
        return { data: data as T, response };
      }

      const canRetry =
        (response.status === 429 || response.status === 503) &&
        attempt < this.#maxRetries;
      const retryAfterMs = parseRetryHeader(
        response.headers.get("Retry-After"),
        this.#now(),
      );

      if (response.status === 429 || response.status === 503) {
        this.#blockFor(retryAfterMs ?? FALLBACK_RETRY_DELAY_MS * 2 ** attempt);
      }

      if (canRetry) {
        continue;
      }

      throw this.#httpError(response.status, retryAfterMs);
    }

    throw new ZoteroApiError(
      "request_failed",
      "The Zotero request could not be completed.",
    );
  }

  async #fetchOnce(url: URL): Promise<Response> {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.#timeoutMs);

    try {
      return await this.#fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "Zotero-API-Key": this.#apiKey,
          "Zotero-API-Version": "3",
        },
        signal: controller.signal,
      });
    } catch {
      if (timedOut || controller.signal.aborted) {
        throw new ZoteroApiError(
          "timeout",
          `The Zotero request timed out after ${this.#timeoutMs} milliseconds.`,
        );
      }
      throw new ZoteroApiError(
        "network_error",
        "The Zotero API could not be reached.",
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  #recordBackoff(value: string | null): void {
    if (value === null) return;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) {
      this.#blockFor(Math.ceil(seconds * 1_000));
    }
  }

  #blockFor(milliseconds: number): void {
    this.#blockedUntilMs = Math.max(
      this.#blockedUntilMs,
      this.#now() + milliseconds,
    );
  }

  async #waitForRequestWindow(): Promise<void> {
    const target = this.#blockedUntilMs;
    const delay = target - this.#now();
    if (delay <= 0) return;

    await this.#sleep(delay);
    if (this.#blockedUntilMs === target) {
      this.#blockedUntilMs = 0;
    }
  }

  #httpError(status: number, retryAfterMs: number | null): ZoteroApiError {
    const options = {
      status,
      ...(retryAfterMs === null ? {} : { retryAfterMs }),
    };

    switch (status) {
      case 401:
      case 403:
        return new ZoteroApiError(
          "authentication_failed",
          "Zotero rejected the API key or its permissions.",
          options,
        );
      case 404:
        return new ZoteroApiError(
          "not_found",
          "The requested Zotero resource was not found.",
          options,
        );
      case 429:
        return new ZoteroApiError(
          "rate_limited",
          "Zotero rate-limited the request.",
          options,
        );
      case 503:
        return new ZoteroApiError(
          "service_unavailable",
          "The Zotero service is temporarily unavailable.",
          options,
        );
      default:
        return new ZoteroApiError(
          "request_failed",
          `Zotero returned HTTP status ${status}.`,
          options,
        );
    }
  }
}
