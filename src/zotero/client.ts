import { ZoteroApiError } from "./errors.js";
import {
  libraryApiPath,
  requireCollectionKey,
  requireLibraryLocator,
} from "./library.js";
import type {
  LibraryLocator,
  ZoteroCollection,
  ZoteroCollectionEntry,
  ZoteroCollectionPage,
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
const COLLECTION_PAGE_SIZE = 100;
const MAX_COLLECTION_PAGES = 1_000;
const ITEM_KEY_BATCH_SIZE = 50;
const FALLBACK_RETRY_DELAY_MS = 1_000;

interface RequestResult<T> {
  data: T;
  response: Response;
}

interface CollectionSnapshot {
  entries: ZoteroCollectionEntry[];
  visibleEntries: ZoteroCollectionEntry[];
  visibleKeys: Set<string>;
  version: number | null;
}

class CollectionVersionChangedError extends Error {}

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

function addSearchParameters(
  query: URLSearchParams,
  options: ZoteroSearchItemsOptions,
): void {
  if (options.q !== undefined) query.set("q", options.q);
  if (options.qmode !== undefined) query.set("qmode", options.qmode);
  if (options.itemType !== undefined) query.set("itemType", options.itemType);
  if (options.tag !== undefined) {
    const tags = typeof options.tag === "string" ? [options.tag] : options.tag;
    for (const tag of tags) query.append("tag", tag);
  }
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

function validateCollection(value: unknown): ZoteroCollection {
  if (!isRecord(value) || !isRecord(value.data)) {
    throw new ZoteroApiError(
      "invalid_response",
      "Zotero returned an invalid collection response.",
    );
  }

  const { data } = value;
  if (
    typeof value.key !== "string" ||
    !Number.isSafeInteger(value.version) ||
    typeof data.key !== "string" ||
    !Number.isSafeInteger(data.version) ||
    typeof data.name !== "string" ||
    !(
      data.parentCollection === false ||
      typeof data.parentCollection === "string"
    )
  ) {
    throw new ZoteroApiError(
      "invalid_response",
      "Zotero returned an invalid collection response.",
    );
  }

  if (isRecord(value.meta)) {
    for (const field of ["numCollections", "numItems"] as const) {
      const fieldValue = value.meta[field];
      if (
        fieldValue !== undefined &&
        (!Number.isSafeInteger(fieldValue) || (fieldValue as number) < 0)
      ) {
        throw new ZoteroApiError(
          "invalid_response",
          "Zotero returned an invalid collection response.",
        );
      }
    }
  }

  return value as unknown as ZoteroCollection;
}

function parseObjectKeys(value: string, totalResults: number): string[] {
  const keys = value
    .split(/\r?\n/)
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
  if (
    keys.length !== totalResults ||
    keys.some((key) => !/^[A-Z0-9]{8}$/.test(key)) ||
    new Set(keys).size !== keys.length
  ) {
    throw new ZoteroApiError(
      "invalid_response",
      "Zotero returned an invalid item-key response.",
    );
  }
  return keys;
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
  readonly #apiKey: string | undefined;
  readonly #library: LibraryLocator | undefined;
  readonly #collectionKey: string | undefined;
  readonly #fetch: typeof globalThis.fetch;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #now: () => number;

  #keyInfo: ZoteroKeyInfo | undefined;
  #keyInfoPromise: Promise<ZoteroKeyInfo> | undefined;
  #collectionSnapshot: CollectionSnapshot | undefined;
  #collectionSnapshotPromise: Promise<CollectionSnapshot> | undefined;
  #observedLibraryVersion: number | null = null;
  readonly #authorizedItemKeys = new Set<string>();
  #blockedUntilMs = 0;
  #requestQueue: Promise<void> = Promise.resolve();

  constructor(options: ZoteroClientOptions) {
    const apiKey = options.apiKey?.trim() || undefined;
    const library =
      options.library === undefined
        ? undefined
        : requireLibraryLocator(options.library);
    const collectionKey =
      options.collectionKey === undefined
        ? undefined
        : requireCollectionKey(options.collectionKey);
    if (apiKey === undefined && library === undefined) {
      throw new ZoteroApiError(
        "authentication_failed",
        "A Zotero API key is required when no library is configured.",
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
    this.#library = library;
    this.#collectionKey = collectionKey;
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
    const libraryPath = await this.#getLibraryPath();
    if (this.#collectionKey !== undefined) {
      return this.#searchScopedItems(libraryPath, options, page);
    }

    const query = new URLSearchParams({
      limit: String(page.limit),
      start: String(page.start),
    });
    addSearchParameters(query, options);

    return this.#getItemsPage(`${libraryPath}/items/top`, query, page);
  }

  async listCollections(
    options: ZoteroPageOptions = {},
  ): Promise<ZoteroCollectionPage> {
    const page = requirePageOptions(options);
    const snapshot = await this.#getCollectionSnapshot();
    const entries = snapshot.visibleEntries.slice(
      page.start,
      page.start + page.limit,
    );
    const candidateNext = page.start + entries.length;
    return {
      items: entries,
      totalResults: snapshot.visibleEntries.length,
      start: page.start,
      limit: page.limit,
      nextStart:
        entries.length > 0 && candidateNext < snapshot.visibleEntries.length
          ? candidateNext
          : null,
      focusedCollectionKey: this.#collectionKey ?? null,
    };
  }

  async getItem(itemKey: string): Promise<ZoteroItem> {
    const key = requireItemKey(itemKey);
    const item = await this.#getRawItem(key);
    await this.#assertItemInScope(item, new Set());
    return item;
  }

  async getItemChildren(
    itemKey: string,
    options: ZoteroPageOptions = {},
  ): Promise<ZoteroPage<ZoteroItem>> {
    const key = requireItemKey(itemKey);
    const page = requirePageOptions(options);
    const libraryPath = await this.#getLibraryPath();
    if (this.#collectionKey !== undefined) {
      await this.#assertItemKeyInScope(key);
    }
    const query = new URLSearchParams({
      limit: String(page.limit),
      start: String(page.start),
    });

    const children = await this.#getItemsPage(
      `${libraryPath}/items/${encodeURIComponent(key)}/children`,
      query,
      page,
    );
    if (this.#collectionKey !== undefined) {
      for (const child of children.items) {
        this.#authorizedItemKeys.add(child.key);
      }
    }
    return children;
  }

  async getFulltext(attachmentKey: string): Promise<ZoteroFulltext> {
    const key = requireItemKey(attachmentKey);
    const libraryPath = await this.#getLibraryPath();
    if (this.#collectionKey !== undefined) {
      await this.#assertItemKeyInScope(key);
    }
    const result = await this.#requestJson<unknown>(
      `${libraryPath}/items/${encodeURIComponent(key)}/fulltext`,
    );
    return validateFulltext(result.data);
  }

  async #searchScopedItems(
    libraryPath: string,
    options: ZoteroSearchItemsOptions,
    page: Required<ZoteroPageOptions>,
  ): Promise<ZoteroPage<ZoteroItem>> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const snapshot = await this.#getCollectionSnapshot();
      const orderedKeys: string[] = [];
      const seenKeys = new Set<string>();

      for (const entry of snapshot.visibleEntries) {
        const query = new URLSearchParams({ format: "keys" });
        addSearchParameters(query, options);
        const result = await this.#requestText(
          `${libraryPath}/collections/${encodeURIComponent(entry.collection.key)}/items/top`,
          query,
        );
        const totalResults = parseNonNegativeInteger(
          result.response.headers.get("Total-Results"),
        );
        if (totalResults === null) {
          throw new ZoteroApiError(
            "invalid_response",
            "Zotero did not return a valid Total-Results header.",
          );
        }
        for (const key of parseObjectKeys(result.data, totalResults)) {
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            orderedKeys.push(key);
          }
        }
      }

      const pageKeys = orderedKeys.slice(page.start, page.start + page.limit);
      const items = await this.#getItemsByKeys(libraryPath, pageKeys);
      if (this.#snapshotIsCurrent(snapshot)) {
        for (const item of items) this.#authorizedItemKeys.add(item.key);
        const candidateNext = page.start + items.length;
        return {
          items,
          totalResults: orderedKeys.length,
          start: page.start,
          limit: page.limit,
          nextStart:
            items.length > 0 && candidateNext < orderedKeys.length
              ? candidateNext
              : null,
        };
      }
    }

    throw new ZoteroApiError(
      "request_failed",
      "The Zotero collection hierarchy changed during the search. Try again.",
    );
  }

  async #getItemsByKeys(
    libraryPath: string,
    keys: readonly string[],
  ): Promise<ZoteroItem[]> {
    const itemsByKey = new Map<string, ZoteroItem>();
    for (let index = 0; index < keys.length; index += ITEM_KEY_BATCH_SIZE) {
      const batch = keys.slice(index, index + ITEM_KEY_BATCH_SIZE);
      const query = new URLSearchParams({
        itemKey: batch.join(","),
        limit: String(batch.length),
      });
      const result = await this.#requestJson<unknown>(
        `${libraryPath}/items/top`,
        query,
      );
      if (!Array.isArray(result.data)) {
        throw new ZoteroApiError(
          "invalid_response",
          "Zotero returned an invalid item-list response.",
        );
      }
      for (const item of result.data.map(validateItem)) {
        if (!batch.includes(item.key) || itemsByKey.has(item.key)) {
          throw new ZoteroApiError(
            "invalid_response",
            "Zotero returned unexpected items for an item-key request.",
          );
        }
        itemsByKey.set(item.key, item);
      }
    }
    if (itemsByKey.size !== keys.length) {
      throw new ZoteroApiError(
        "invalid_response",
        "Zotero omitted items from an item-key request.",
      );
    }
    return keys.map((key) => itemsByKey.get(key) as ZoteroItem);
  }

  async #getRawItem(itemKey: string): Promise<ZoteroItem> {
    const libraryPath = await this.#getLibraryPath();
    const result = await this.#requestJson<unknown>(
      `${libraryPath}/items/${encodeURIComponent(itemKey)}`,
    );
    return validateItem(result.data);
  }

  async #assertItemKeyInScope(itemKey: string): Promise<void> {
    if (
      this.#collectionKey === undefined ||
      this.#authorizedItemKeys.has(itemKey)
    ) {
      return;
    }
    const item = await this.#getRawItem(itemKey);
    await this.#assertItemInScope(item, new Set());
  }

  async #assertItemInScope(
    item: ZoteroItem,
    visitedKeys: Set<string>,
  ): Promise<void> {
    if (this.#collectionKey === undefined) return;
    if (this.#authorizedItemKeys.has(item.key)) return;
    if (visitedKeys.has(item.key)) {
      throw new ZoteroApiError(
        "invalid_response",
        "Zotero returned a cyclic parent-item relationship.",
      );
    }
    visitedKeys.add(item.key);

    if (item.data.parentItem !== undefined) {
      const parentKey = requireItemKey(item.data.parentItem);
      const parent = await this.#getRawItem(parentKey);
      await this.#assertItemInScope(parent, visitedKeys);
      this.#authorizedItemKeys.add(item.key);
      return;
    }

    const memberships = item.data.collections ?? [];
    if (
      !Array.isArray(memberships) ||
      memberships.some((key) => typeof key !== "string")
    ) {
      throw new ZoteroApiError(
        "invalid_response",
        "Zotero returned invalid collection membership for an item.",
      );
    }
    const snapshot = await this.#getCollectionSnapshot();
    if (memberships.some((key) => snapshot.visibleKeys.has(key))) {
      this.#authorizedItemKeys.add(item.key);
      return;
    }

    throw new ZoteroApiError(
      "outside_collection_scope",
      `Zotero item ${item.key} is outside configured collection ${this.#collectionKey}.`,
    );
  }

  async #getCollectionSnapshot(): Promise<CollectionSnapshot> {
    if (
      this.#collectionSnapshot !== undefined &&
      this.#snapshotIsCurrent(this.#collectionSnapshot)
    ) {
      return this.#collectionSnapshot;
    }
    if (this.#collectionSnapshotPromise !== undefined) {
      return this.#collectionSnapshotPromise;
    }

    this.#collectionSnapshotPromise = this.#loadCollectionSnapshot();
    try {
      const snapshot = await this.#collectionSnapshotPromise;
      this.#collectionSnapshot = snapshot;
      return snapshot;
    } finally {
      this.#collectionSnapshotPromise = undefined;
    }
  }

  async #loadCollectionSnapshot(): Promise<CollectionSnapshot> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.#loadCollectionSnapshotOnce();
      } catch (error) {
        if (!(error instanceof CollectionVersionChangedError) || attempt > 0) {
          throw error;
        }
      }
    }
    throw new ZoteroApiError(
      "request_failed",
      "The Zotero collection hierarchy changed while it was being read.",
    );
  }

  async #loadCollectionSnapshotOnce(): Promise<CollectionSnapshot> {
    const libraryPath = await this.#getLibraryPath();
    const collections: ZoteroCollection[] = [];
    let start = 0;
    let expectedTotal: number | undefined;
    let snapshotVersion: number | null = null;

    for (
      let pageNumber = 0;
      pageNumber < MAX_COLLECTION_PAGES;
      pageNumber += 1
    ) {
      const page = { limit: COLLECTION_PAGE_SIZE, start };
      const query = new URLSearchParams({
        limit: String(page.limit),
        start: String(page.start),
      });
      const result = await this.#requestJson<unknown>(
        `${libraryPath}/collections`,
        query,
      );
      if (!Array.isArray(result.data)) {
        throw new ZoteroApiError(
          "invalid_response",
          "Zotero returned an invalid collection-list response.",
        );
      }
      const responseVersion = parseNonNegativeInteger(
        result.response.headers.get("Last-Modified-Version"),
      );
      if (
        snapshotVersion !== null &&
        responseVersion !== null &&
        responseVersion !== snapshotVersion
      ) {
        throw new CollectionVersionChangedError();
      }
      snapshotVersion ??= responseVersion;
      const total = parseNonNegativeInteger(
        result.response.headers.get("Total-Results"),
      );
      if (
        total === null ||
        (expectedTotal !== undefined && total !== expectedTotal)
      ) {
        throw new ZoteroApiError(
          "invalid_response",
          "Zotero did not return consistent collection pagination metadata.",
        );
      }
      expectedTotal = total;
      collections.push(...result.data.map(validateCollection));
      if (collections.length >= total) break;
      if (result.data.length === 0) {
        throw new ZoteroApiError(
          "invalid_response",
          "Zotero returned invalid collection pagination.",
        );
      }
      start += result.data.length;
    }

    if (expectedTotal === undefined || collections.length !== expectedTotal) {
      throw new ZoteroApiError(
        "invalid_response",
        "The Zotero library has too many collections to read safely.",
      );
    }
    return this.#buildCollectionSnapshot(collections, snapshotVersion);
  }

  #buildCollectionSnapshot(
    collections: readonly ZoteroCollection[],
    version: number | null,
  ): CollectionSnapshot {
    const byKey = new Map<string, ZoteroCollection>();
    for (const collection of collections) {
      if (byKey.has(collection.key) || collection.data.key !== collection.key) {
        throw new ZoteroApiError(
          "invalid_response",
          "Zotero returned duplicate or inconsistent collection keys.",
        );
      }
      byKey.set(collection.key, collection);
    }
    const children = new Map<string | null, ZoteroCollection[]>();
    for (const collection of collections) {
      const parent = collection.data.parentCollection;
      const parentKey = parent === false ? null : parent;
      if (parentKey !== null && !byKey.has(parentKey)) {
        throw new ZoteroApiError(
          "invalid_response",
          "Zotero returned a collection with a missing parent.",
        );
      }
      const siblings = children.get(parentKey) ?? [];
      siblings.push(collection);
      children.set(parentKey, siblings);
    }
    const compareCollections = (
      left: ZoteroCollection,
      right: ZoteroCollection,
    ) =>
      left.data.name.localeCompare(right.data.name, "en", {
        sensitivity: "base",
      }) || left.key.localeCompare(right.key);
    for (const siblings of children.values()) siblings.sort(compareCollections);

    const entries: ZoteroCollectionEntry[] = [];
    const entriesByKey = new Map<string, ZoteroCollectionEntry>();
    const visiting = new Set<string>();
    const visit = (
      collection: ZoteroCollection,
      parentPath: readonly string[],
    ) => {
      if (visiting.has(collection.key) || entriesByKey.has(collection.key)) {
        throw new ZoteroApiError(
          "invalid_response",
          "Zotero returned a cyclic collection hierarchy.",
        );
      }
      visiting.add(collection.key);
      const path = [...parentPath, collection.data.name];
      const entry = { collection, path, depth: path.length - 1 };
      entries.push(entry);
      entriesByKey.set(collection.key, entry);
      for (const child of children.get(collection.key) ?? [])
        visit(child, path);
      visiting.delete(collection.key);
    };
    for (const root of children.get(null) ?? []) visit(root, []);
    if (entries.length !== collections.length) {
      throw new ZoteroApiError(
        "invalid_response",
        "Zotero returned an invalid collection hierarchy.",
      );
    }

    let visibleEntries = entries;
    if (this.#collectionKey !== undefined) {
      const rootEntry = entriesByKey.get(this.#collectionKey);
      if (rootEntry === undefined) {
        throw new ZoteroApiError(
          "not_found",
          `Configured Zotero collection ${this.#collectionKey} was not found in the selected library.`,
        );
      }
      const visibleKeySet = new Set<string>();
      const includeSubtree = (collection: ZoteroCollection) => {
        visibleKeySet.add(collection.key);
        for (const child of children.get(collection.key) ?? []) {
          includeSubtree(child);
        }
      };
      includeSubtree(rootEntry.collection);
      visibleEntries = entries.filter((entry) =>
        visibleKeySet.has(entry.collection.key),
      );
    }
    return {
      entries,
      visibleEntries,
      visibleKeys: new Set(visibleEntries.map((entry) => entry.collection.key)),
      version,
    };
  }

  #snapshotIsCurrent(snapshot: CollectionSnapshot): boolean {
    return (
      snapshot.version === null ||
      this.#observedLibraryVersion === null ||
      snapshot.version === this.#observedLibraryVersion
    );
  }

  async #getLibraryPath(): Promise<string> {
    if (this.#library !== undefined) {
      return libraryApiPath(this.#library);
    }

    const user = await this.getCurrentUser();
    return libraryApiPath({ type: "user", id: user.userID });
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

  #requestText(
    path: string,
    query?: URLSearchParams,
  ): Promise<RequestResult<string>> {
    const request = this.#requestQueue.then(
      () => this.#executeTextRequest(path, query),
      () => this.#executeTextRequest(path, query),
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
        this.#observeLibraryVersion(response);
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

  async #executeTextRequest(
    path: string,
    query?: URLSearchParams,
  ): Promise<RequestResult<string>> {
    const url = new URL(`${this.#baseUrl}${path}`);
    if (query !== undefined) url.search = query.toString();

    for (let attempt = 0; attempt <= this.#maxRetries; attempt += 1) {
      await this.#waitForRequestWindow();
      const response = await this.#fetchOnce(url);
      this.#recordBackoff(response.headers.get("Backoff"));

      if (response.ok) {
        this.#observeLibraryVersion(response);
        return { data: await response.text(), response };
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
      if (canRetry) continue;
      throw this.#httpError(response.status, retryAfterMs);
    }

    throw new ZoteroApiError(
      "request_failed",
      "The Zotero request could not be completed.",
    );
  }

  #observeLibraryVersion(response: Response): void {
    const version = parseNonNegativeInteger(
      response.headers.get("Last-Modified-Version"),
    );
    if (version === null) return;
    if (
      this.#observedLibraryVersion !== null &&
      version !== this.#observedLibraryVersion
    ) {
      this.#collectionSnapshot = undefined;
      this.#authorizedItemKeys.clear();
    }
    this.#observedLibraryVersion = version;
  }

  async #fetchOnce(url: URL): Promise<Response> {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.#timeoutMs);

    try {
      const headers: Record<string, string> = {
        Accept: "application/json",
        "Zotero-API-Version": "3",
      };
      if (this.#apiKey !== undefined) {
        headers["Zotero-API-Key"] = this.#apiKey;
      }

      return await this.#fetch(url, {
        method: "GET",
        headers,
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
          "Zotero denied access to the configured library. It may be private, or the API key may be missing, invalid, or lack permission.",
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
