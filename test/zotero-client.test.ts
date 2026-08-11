import { afterEach, describe, expect, it, vi } from "vitest";

import { ZoteroClient } from "../src/zotero/client.js";
import { ZoteroApiError } from "../src/zotero/errors.js";
import type { ZoteroCollection, ZoteroItem } from "../src/zotero/types.js";

const API_KEY = "super-secret-zotero-key";
const USER_ID = 12345;

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(body), { ...init, headers });
}

function keyResponse(
  access: Record<string, unknown> = { library: true },
  headers?: ConstructorParameters<typeof Headers>[0],
): Response {
  return jsonResponse(
    {
      userID: USER_ID,
      username: "researcher",
      access: { user: access, groups: {} },
    },
    headers === undefined ? {} : { headers },
  );
}

function item(
  key: string,
  itemType = "journalArticle",
  fields: Record<string, unknown> = {},
): ZoteroItem {
  return {
    key,
    version: 7,
    data: {
      key,
      version: 7,
      itemType,
      title: `Title for ${key}`,
      ...fields,
    },
  };
}

function collection(
  key: string,
  name: string,
  parentCollection: string | false = false,
): ZoteroCollection {
  return {
    key,
    version: 3,
    meta: { numItems: 2, numCollections: 1 },
    data: { key, version: 3, name, parentCollection, relations: {} },
  };
}

function collectionResponse(
  collections: ZoteroCollection[],
  version = 10,
): Response {
  return jsonResponse(collections, {
    headers: {
      "Total-Results": String(collections.length),
      "Last-Modified-Version": String(version),
    },
  });
}

function keysResponse(keys: readonly string[], version = 10): Response {
  return new Response(keys.length === 0 ? "" : `${keys.join("\n")}\n`, {
    headers: {
      "Content-Type": "text/plain",
      "Total-Results": String(keys.length),
      "Last-Modified-Version": String(version),
    },
  });
}

function mockFetch(...responses: Response[]): typeof fetch {
  const mock = vi.fn<typeof fetch>();
  for (const response of responses) {
    mock.mockResolvedValueOnce(response);
  }
  return mock;
}

function requestedUrl(fetchMock: typeof fetch, index: number): URL {
  const mock = vi.mocked(fetchMock);
  const call = mock.mock.calls[index];
  if (call === undefined) throw new Error(`Missing fetch call ${index}`);
  return new URL(String(call[0]));
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ZoteroClient authentication and requests", () => {
  it("requires either an API key or an explicit library", () => {
    expect(() => new ZoteroClient({})).toThrowError(
      expect.objectContaining({
        name: "ZoteroApiError",
        code: "authentication_failed",
      }),
    );
  });

  it("discovers and caches the current user while authenticating with headers", async () => {
    const fetchMock = mockFetch(
      keyResponse(),
      jsonResponse([item("ITEM0001")], {
        headers: { "Total-Results": "7" },
      }),
      jsonResponse([item("ITEM0002")], {
        headers: { "Total-Results": "7" },
      }),
    );
    const client = new ZoteroClient({ apiKey: API_KEY, fetch: fetchMock });

    const firstUser = await client.getCurrentUser();
    const secondUser = await client.getCurrentUser();
    expect(firstUser.userID).toBe(USER_ID);
    expect(secondUser).toBe(firstUser);

    const firstPage = await client.searchItems({ limit: 1, start: 2 });
    const secondPage = await client.searchItems({ limit: 1, start: 3 });
    expect(firstPage.nextStart).toBe(3);
    expect(secondPage.nextStart).toBe(4);
    expect(vi.mocked(fetchMock)).toHaveBeenCalledTimes(3);

    const [keyInput, keyInit] = vi.mocked(fetchMock).mock.calls[0] ?? [];
    expect(String(keyInput)).toBe("https://api.zotero.org/keys/current");
    const headers = new Headers(keyInit?.headers);
    expect(headers.get("Zotero-API-Key")).toBe(API_KEY);
    expect(headers.get("Zotero-API-Version")).toBe("3");
    expect(headers.get("Accept")).toBe("application/json");
    expect(String(keyInput)).not.toContain(API_KEY);
  });

  it("reads an explicit public group without key discovery or authentication headers", async () => {
    const parent = item("PARENT01");
    const attachment = item("ATTACH01", "attachment", {
      parentItem: "PARENT01",
      contentType: "application/pdf",
    });
    const fetchMock = mockFetch(
      jsonResponse([parent], { headers: { "Total-Results": "1" } }),
      jsonResponse(parent),
      jsonResponse([attachment], { headers: { "Total-Results": "1" } }),
      jsonResponse({ content: "Public indexed text" }),
    );
    const client = new ZoteroClient({
      library: { type: "group", id: 98765 },
      fetch: fetchMock,
    });

    await client.searchItems();
    await client.getItem("PARENT01");
    await client.getItemChildren("PARENT01");
    await client.getFulltext("ATTACH01");

    expect(
      vi
        .mocked(fetchMock)
        .mock.calls.map(([input]) => new URL(String(input)).pathname),
    ).toEqual([
      "/groups/98765/items/top",
      "/groups/98765/items/PARENT01",
      "/groups/98765/items/PARENT01/children",
      "/groups/98765/items/ATTACH01/fulltext",
    ]);
    for (const [, init] of vi.mocked(fetchMock).mock.calls) {
      const headers = new Headers(init?.headers);
      expect(headers.has("Zotero-API-Key")).toBe(false);
      expect(headers.get("Zotero-API-Version")).toBe("3");
    }
  });

  it("optionally authenticates requests to an explicit user library", async () => {
    const fetchMock = mockFetch(
      jsonResponse([], { headers: { "Total-Results": "0" } }),
    );
    const client = new ZoteroClient({
      apiKey: API_KEY,
      library: { type: "user", id: 24680 },
      fetch: fetchMock,
    });

    await client.searchItems();

    expect(requestedUrl(fetchMock, 0).pathname).toBe("/users/24680/items/top");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = vi.mocked(fetchMock).mock.calls[0] ?? [];
    expect(new Headers(init?.headers).get("Zotero-API-Key")).toBe(API_KEY);
  });

  it("rejects invalid programmatic library locators", () => {
    for (const library of [
      { type: "group", id: 0 },
      { type: "group", id: -1 },
      { type: "group", id: 1.5 },
      { type: "collection", id: 123 },
    ]) {
      expect(
        () =>
          new ZoteroClient({
            library: library as never,
          }),
      ).toThrowError(expect.objectContaining({ code: "invalid_request" }));
    }
  });

  it("rejects keys without personal-library read permission", async () => {
    const fetchMock = mockFetch(keyResponse({ library: false }));
    const client = new ZoteroClient({ apiKey: API_KEY, fetch: fetchMock });

    await expect(client.getCurrentUser()).rejects.toMatchObject({
      name: "ZoteroApiError",
      code: "permission_denied",
      status: 403,
    });
  });

  it("shares one in-flight key discovery request", async () => {
    let resolveResponse: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((resolve) => {
          resolveResponse = resolve;
        }),
    );
    const client = new ZoteroClient({ apiKey: API_KEY, fetch: fetchMock });

    const first = client.getCurrentUser();
    const second = client.getCurrentUser();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    resolveResponse?.(keyResponse());

    await expect(first).resolves.toMatchObject({ userID: USER_ID });
    await expect(second).resolves.toMatchObject({ userID: USER_ID });
  });
});

describe("ZoteroClient resource reads", () => {
  it("lists a focused collection tree and recursively paginates deduplicated search results", async () => {
    const root = collection("ROOT0001", "Research");
    const child = collection("CHILD001", "Methods", root.key);
    const grandchild = collection("GRAND001", "Models", child.key);
    const unrelated = collection("OTHER001", "Unrelated");
    const first = item("ITEM0001", "journalArticle", {
      collections: [root.key],
    });
    const duplicate = item("DUPL0001", "journalArticle", {
      collections: [root.key, child.key],
    });
    const second = item("ITEM0002", "journalArticle", {
      collections: [child.key],
    });
    const fetchMock = mockFetch(
      collectionResponse([unrelated, grandchild, child, root]),
      keysResponse([first.key, duplicate.key]),
      keysResponse([duplicate.key, second.key]),
      keysResponse([]),
      jsonResponse([second, duplicate], {
        headers: {
          "Total-Results": "2",
          "Last-Modified-Version": "10",
        },
      }),
    );
    const client = new ZoteroClient({
      library: { type: "group", id: 98765 },
      collectionKey: "root0001",
      fetch: fetchMock,
    });

    await expect(client.listCollections({ limit: 2 })).resolves.toMatchObject({
      items: [
        { collection: { key: root.key }, path: ["Research"], depth: 0 },
        {
          collection: { key: child.key },
          path: ["Research", "Methods"],
          depth: 1,
        },
      ],
      totalResults: 3,
      nextStart: 2,
      focusedCollectionKey: root.key,
    });
    const result = await client.searchItems({
      q: "cortical model",
      qmode: "everything",
      itemType: "journalArticle",
      tag: "methods",
      limit: 2,
      start: 1,
    });

    expect(result).toMatchObject({
      items: [{ key: duplicate.key }, { key: second.key }],
      totalResults: 3,
      start: 1,
      limit: 2,
      nextStart: null,
    });
    const urls = vi
      .mocked(fetchMock)
      .mock.calls.map(([input]) => new URL(String(input)));
    expect(urls[0]?.pathname).toBe("/groups/98765/collections");
    expect(urls.slice(1, 4).map(({ pathname }) => pathname)).toEqual([
      "/groups/98765/collections/ROOT0001/items/top",
      "/groups/98765/collections/CHILD001/items/top",
      "/groups/98765/collections/GRAND001/items/top",
    ]);
    for (const url of urls.slice(1, 4)) {
      expect(url?.searchParams.get("format")).toBe("keys");
      expect(url?.searchParams.get("q")).toBe("cortical model");
      expect(url?.searchParams.get("qmode")).toBe("everything");
      expect(url?.searchParams.get("itemType")).toBe("journalArticle");
      expect(url?.searchParams.get("tag")).toBe("methods");
    }
    expect(urls[4]?.pathname).toBe("/groups/98765/items/top");
    expect(urls[4]?.searchParams.get("itemKey")).toBe("DUPL0001,ITEM0002");
  });

  it("enforces collection scope while allowing children of in-scope parents", async () => {
    const root = collection("ROOT0001", "Research");
    const parent = item("PARENT01", "journalArticle", {
      collections: [root.key],
    });
    const attachment = item("ATTACH01", "attachment", {
      parentItem: parent.key,
      contentType: "application/pdf",
      filename: "paper.pdf",
    });
    const fetchMock = mockFetch(
      jsonResponse(parent, { headers: { "Last-Modified-Version": "10" } }),
      collectionResponse([root]),
      jsonResponse(attachment, {
        headers: { "Last-Modified-Version": "10" },
      }),
      jsonResponse(parent, { headers: { "Last-Modified-Version": "10" } }),
      jsonResponse(
        { content: "Scoped text" },
        {
          headers: { "Last-Modified-Version": "10" },
        },
      ),
    );
    const client = new ZoteroClient({
      library: { type: "group", id: 98765 },
      collectionKey: root.key,
      fetch: fetchMock,
    });

    await expect(client.getItem(parent.key)).resolves.toEqual(parent);
    await expect(client.getFulltext(attachment.key)).resolves.toEqual({
      content: "Scoped text",
    });
  });

  it("rejects top-level items outside the configured collection tree", async () => {
    const root = collection("ROOT0001", "Research");
    const unrelated = collection("OTHER001", "Unrelated");
    const outside = item("OUTSIDE1", "journalArticle", {
      collections: [unrelated.key],
    });
    const fetchMock = mockFetch(
      jsonResponse(outside, { headers: { "Last-Modified-Version": "10" } }),
      collectionResponse([root, unrelated]),
    );
    const client = new ZoteroClient({
      library: { type: "group", id: 98765 },
      collectionKey: root.key,
      fetch: fetchMock,
    });

    await expect(client.getItem(outside.key)).rejects.toMatchObject({
      code: "outside_collection_scope",
    });
  });

  it("fetches scoped result bodies in Zotero's 50-key batches", async () => {
    const root = collection("ROOT0001", "Research");
    const keys = Array.from(
      { length: 51 },
      (_, index) => `I${String(index).padStart(7, "0")}`,
    );
    const items = keys.map((key) =>
      item(key, "journalArticle", { collections: [root.key] }),
    );
    const fetchMock = mockFetch(
      collectionResponse([root]),
      keysResponse(keys),
      jsonResponse(items.slice(0, 50), {
        headers: {
          "Total-Results": "50",
          "Last-Modified-Version": "10",
        },
      }),
      jsonResponse(items.slice(50), {
        headers: {
          "Total-Results": "1",
          "Last-Modified-Version": "10",
        },
      }),
    );
    const client = new ZoteroClient({
      library: { type: "group", id: 98765 },
      collectionKey: root.key,
      fetch: fetchMock,
    });

    const result = await client.searchItems({ limit: 100 });
    expect(result.items).toHaveLength(51);
    const urls = vi
      .mocked(fetchMock)
      .mock.calls.map(([input]) => new URL(String(input)));
    expect(urls[2]?.searchParams.get("itemKey")?.split(",")).toHaveLength(50);
    expect(urls[3]?.searchParams.get("itemKey")?.split(",")).toHaveLength(1);
  });

  it("invalidates the collection tree when Zotero's library version changes", async () => {
    const root = collection("ROOT0001", "Research");
    const child = collection("CHILD001", "New child", root.key);
    const movedItem = item("MOVED001", "journalArticle", {
      collections: [child.key],
    });
    const fetchMock = mockFetch(
      collectionResponse([root], 10),
      jsonResponse(movedItem, {
        headers: { "Last-Modified-Version": "11" },
      }),
      collectionResponse([root, child], 11),
    );
    const client = new ZoteroClient({
      library: { type: "group", id: 98765 },
      collectionKey: root.key,
      fetch: fetchMock,
    });

    await client.listCollections();
    await expect(client.getItem(movedItem.key)).resolves.toEqual(movedItem);
    expect(
      vi
        .mocked(fetchMock)
        .mock.calls.map(([input]) => new URL(String(input)).pathname),
    ).toEqual([
      "/groups/98765/collections",
      "/groups/98765/items/MOVED001",
      "/groups/98765/collections",
    ]);
  });

  it("reports a missing configured collection", async () => {
    const fetchMock = mockFetch(
      collectionResponse([collection("ROOT0001", "Research")]),
    );
    const client = new ZoteroClient({
      library: { type: "group", id: 98765 },
      collectionKey: "MISSING1",
      fetch: fetchMock,
    });

    await expect(client.listCollections()).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("encodes all top-item search parameters and returns Total-Results pagination", async () => {
    const fetchMock = mockFetch(
      keyResponse(),
      jsonResponse([item("ITEM0001"), item("ITEM0002")], {
        headers: { "Total-Results": "9" },
      }),
    );
    const client = new ZoteroClient({ apiKey: API_KEY, fetch: fetchMock });

    const result = await client.searchItems({
      q: "memory & learning",
      qmode: "everything",
      itemType: "journalArticle",
      tag: ["review", "human study"],
      limit: 2,
      start: 4,
    });

    const url = requestedUrl(fetchMock, 1);
    expect(url.pathname).toBe(`/users/${USER_ID}/items/top`);
    expect(url.searchParams.get("q")).toBe("memory & learning");
    expect(url.searchParams.get("qmode")).toBe("everything");
    expect(url.searchParams.get("itemType")).toBe("journalArticle");
    expect(url.searchParams.getAll("tag")).toEqual(["review", "human study"]);
    expect(url.searchParams.get("limit")).toBe("2");
    expect(url.searchParams.get("start")).toBe("4");
    expect(result).toMatchObject({
      totalResults: 9,
      start: 4,
      limit: 2,
      nextStart: 6,
    });
    expect(result.items.map(({ key }) => key)).toEqual([
      "ITEM0001",
      "ITEM0002",
    ]);
  });

  it("reads an item, its children, and attachment full text", async () => {
    const parent = item("PARENT01");
    const attachment = item("ATTACH01", "attachment", {
      parentItem: "PARENT01",
      contentType: "application/pdf",
      filename: "paper.pdf",
    });
    const fetchMock = mockFetch(
      keyResponse(),
      jsonResponse(parent),
      jsonResponse([attachment], {
        headers: { "Total-Results": "1" },
      }),
      jsonResponse({
        content: "Indexed paper text",
        indexedPages: 8,
        totalPages: 10,
      }),
    );
    const client = new ZoteroClient({ apiKey: API_KEY, fetch: fetchMock });

    await expect(client.getItem("PARENT01")).resolves.toEqual(parent);
    await expect(
      client.getItemChildren("PARENT01", { limit: 100, start: 0 }),
    ).resolves.toMatchObject({
      items: [attachment],
      totalResults: 1,
      nextStart: null,
    });
    await expect(client.getFulltext("ATTACH01")).resolves.toEqual({
      content: "Indexed paper text",
      indexedPages: 8,
      totalPages: 10,
    });

    expect(requestedUrl(fetchMock, 1).pathname).toBe(
      `/users/${USER_ID}/items/PARENT01`,
    );
    expect(requestedUrl(fetchMock, 2).pathname).toBe(
      `/users/${USER_ID}/items/PARENT01/children`,
    );
    expect(requestedUrl(fetchMock, 3).pathname).toBe(
      `/users/${USER_ID}/items/ATTACH01/fulltext`,
    );
  });

  it("validates paging and keys before making a request", async () => {
    const fetchMock = mockFetch();
    const client = new ZoteroClient({ apiKey: API_KEY, fetch: fetchMock });

    await expect(client.searchItems({ limit: 101 })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(client.searchItems({ start: -1 })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(client.getItem("   ")).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malformed list and full-text responses", async () => {
    const fetchMock = mockFetch(
      keyResponse(),
      jsonResponse([item("ITEM0001")]),
      jsonResponse({ content: "text", indexedPages: -1 }),
    );
    const client = new ZoteroClient({ apiKey: API_KEY, fetch: fetchMock });

    await expect(client.searchItems()).rejects.toMatchObject({
      code: "invalid_response",
    });
    await expect(client.getFulltext("ATTACH01")).rejects.toMatchObject({
      code: "invalid_response",
    });
  });
});

describe("ZoteroClient throttling and failures", () => {
  it("serializes concurrent API requests", async () => {
    let releaseFirstRequest: (() => void) | undefined;
    const firstRequestGate = new Promise<void>((resolve) => {
      releaseFirstRequest = resolve;
    });
    let activeRequests = 0;
    let maximumActiveRequests = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/keys/current") return keyResponse();

      activeRequests += 1;
      maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
      if (url.pathname.endsWith("/ITEM0001")) await firstRequestGate;
      const key = url.pathname.endsWith("/ITEM0001") ? "ITEM0001" : "ITEM0002";
      activeRequests -= 1;
      return jsonResponse(item(key));
    });
    const client = new ZoteroClient({ apiKey: API_KEY, fetch: fetchMock });
    await client.getCurrentUser();

    const first = client.getItem("ITEM0001");
    const second = client.getItem("ITEM0002");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(maximumActiveRequests).toBe(1);

    releaseFirstRequest?.();
    await expect(Promise.all([first, second])).resolves.toEqual([
      item("ITEM0001"),
      item("ITEM0002"),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(maximumActiveRequests).toBe(1);
  });

  it("honors Backoff on successful responses before the next request", async () => {
    let now = 1_000;
    const sleep = vi.fn(async (milliseconds: number) => {
      now += milliseconds;
    });
    const fetchMock = mockFetch(
      keyResponse({ library: true }, { Backoff: "2" }),
      jsonResponse([], { headers: { "Total-Results": "0" } }),
    );
    const client = new ZoteroClient({
      apiKey: API_KEY,
      fetch: fetchMock,
      sleep,
      now: () => now,
    });

    await client.searchItems();
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(2_000);
  });

  it("honors Retry-After and retries 429 responses", async () => {
    let now = 1_000;
    const sleep = vi.fn(async (milliseconds: number) => {
      now += milliseconds;
    });
    const fetchMock = mockFetch(
      keyResponse(),
      new Response(null, {
        status: 429,
        headers: { "Retry-After": "3" },
      }),
      jsonResponse([], { headers: { "Total-Results": "0" } }),
    );
    const client = new ZoteroClient({
      apiKey: API_KEY,
      fetch: fetchMock,
      maxRetries: 1,
      sleep,
      now: () => now,
    });

    await expect(client.searchItems()).resolves.toMatchObject({
      totalResults: 0,
    });
    expect(sleep).toHaveBeenCalledWith(3_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("uses bounded exponential retries for 503 and returns a typed error", async () => {
    let now = 1_000;
    const sleep = vi.fn(async (milliseconds: number) => {
      now += milliseconds;
    });
    const fetchMock = mockFetch(
      keyResponse(),
      new Response(null, { status: 503 }),
      new Response(null, { status: 503 }),
      new Response(null, { status: 503 }),
    );
    const client = new ZoteroClient({
      apiKey: API_KEY,
      fetch: fetchMock,
      maxRetries: 2,
      sleep,
      now: () => now,
    });

    await expect(client.searchItems()).rejects.toMatchObject({
      code: "service_unavailable",
      status: 503,
    });
    expect(sleep.mock.calls).toEqual([[1_000], [2_000]]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("preserves a terminal Retry-After delay for the following request", async () => {
    let now = 1_000;
    const sleep = vi.fn(async (milliseconds: number) => {
      now += milliseconds;
    });
    const fetchMock = mockFetch(
      new Response(null, {
        status: 429,
        headers: { "Retry-After": "2" },
      }),
      keyResponse(),
    );
    const client = new ZoteroClient({
      apiKey: API_KEY,
      fetch: fetchMock,
      maxRetries: 0,
      sleep,
      now: () => now,
    });

    await expect(client.getCurrentUser()).rejects.toMatchObject({
      code: "rate_limited",
      retryAfterMs: 2_000,
    });
    await expect(client.getCurrentUser()).resolves.toMatchObject({
      userID: USER_ID,
    });
    expect(sleep).toHaveBeenCalledWith(2_000);
  });

  it("maps full-text 404 to a safe not-found error", async () => {
    const fetchMock = mockFetch(
      keyResponse(),
      new Response("missing or not indexed", { status: 404 }),
    );
    const client = new ZoteroClient({ apiKey: API_KEY, fetch: fetchMock });

    await expect(client.getFulltext("ATTACH01")).rejects.toMatchObject({
      code: "not_found",
      status: 404,
      message: "The requested Zotero resource was not found.",
    });
  });

  it("aborts requests after the default 15-second timeout", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>((_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error(`request containing ${API_KEY} was aborted`));
        });
      });
    });
    const client = new ZoteroClient({ apiKey: API_KEY, fetch: fetchMock });

    const request = client.getCurrentUser();
    const assertion = expect(request).rejects.toMatchObject({
      code: "timeout",
      message: "The Zotero request timed out after 15000 milliseconds.",
    });
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
  });

  it("never leaks the API key in network or HTTP errors", async () => {
    const networkFetch = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error(`failed with credential ${API_KEY}`));
    const networkClient = new ZoteroClient({
      apiKey: API_KEY,
      fetch: networkFetch,
    });

    const networkError = await networkClient
      .getCurrentUser()
      .catch((error: unknown) => error);
    expect(networkError).toBeInstanceOf(ZoteroApiError);
    expect(String(networkError)).not.toContain(API_KEY);

    const httpFetch = mockFetch(
      new Response(`server echoed ${API_KEY}`, { status: 403 }),
    );
    const httpClient = new ZoteroClient({ apiKey: API_KEY, fetch: httpFetch });
    const httpError = await httpClient
      .getCurrentUser()
      .catch((error: unknown) => error);
    expect(httpError).toBeInstanceOf(ZoteroApiError);
    expect(String(httpError)).not.toContain(API_KEY);
  });
});
