/* global console, process, setTimeout, clearTimeout */

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const COMMAND_TIMEOUT_MS = 180_000;
const STARTUP_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 60_000;
const CLOSE_TIMEOUT_MS = 5_000;
const FULLTEXT_CHUNK_SIZE = 256;
const MAX_CAPTURED_STDERR_CHARS = 32_000;
const TOOL_NAMES = [
  "zotero_list_collections",
  "zotero_search_items",
  "zotero_get_item",
  "zotero_get_fulltext",
];

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "..");
const fixturePath = join(
  projectRoot,
  "test",
  "e2e",
  "public-library-fixture.json",
);

class FixtureConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "FixtureConfigurationError";
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function inspect(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function validateExactKeys(value, expectedKeys, field, problems) {
  if (!isRecord(value)) {
    problems.push(`${field} must be an object`);
    return false;
  }

  const unexpectedKeys = Object.keys(value).filter(
    (key) => !expectedKeys.includes(key),
  );
  if (unexpectedKeys.length > 0) {
    problems.push(
      `${field} has unexpected ${unexpectedKeys.length === 1 ? "field" : "fields"}: ${unexpectedKeys.join(", ")}`,
    );
  }
  return true;
}

function readRequiredString(value, field, problems, options = {}) {
  if (typeof value !== "string" || value.trim().length === 0) {
    problems.push(`${field} must be a non-empty string`);
    return undefined;
  }
  if (value !== value.trim()) {
    problems.push(`${field} must not have leading or trailing whitespace`);
  }
  if (
    options.minimumLength !== undefined &&
    value.length < options.minimumLength
  ) {
    problems.push(
      `${field} must contain at least ${String(options.minimumLength)} characters`,
    );
  }
  if (
    options.maximumLength !== undefined &&
    value.length > options.maximumLength
  ) {
    problems.push(
      `${field} must contain at most ${String(options.maximumLength)} characters`,
    );
  }
  return value;
}

function loadFixture() {
  let rawFixture;
  try {
    rawFixture = JSON.parse(readFileSync(fixturePath, "utf8"));
  } catch (error) {
    throw new FixtureConfigurationError(
      `Could not read ${fixturePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const problems = [];
  if (
    !validateExactKeys(
      rawFixture,
      ["groupId", "collection", "item", "attachment"],
      "fixture",
      problems,
    )
  ) {
    throwFixtureError(problems);
  }

  const groupId = rawFixture.groupId;
  if (!Number.isSafeInteger(groupId) || groupId <= 0) {
    problems.push("groupId must be a positive integer");
  }

  const collection = rawFixture.collection;
  const collectionIsRecord = validateExactKeys(
    collection,
    ["key", "name", "outsideItemKey", "outsideItemTitle"],
    "collection",
    problems,
  );
  const collectionKey = collectionIsRecord
    ? readRequiredString(collection.key, "collection.key", problems, {
        minimumLength: 8,
        maximumLength: 8,
      })
    : undefined;
  const collectionName = collectionIsRecord
    ? readRequiredString(collection.name, "collection.name", problems, {
        maximumLength: 256,
      })
    : undefined;
  const outsideItemKey = collectionIsRecord
    ? readRequiredString(
        collection.outsideItemKey,
        "collection.outsideItemKey",
        problems,
        { minimumLength: 8, maximumLength: 8 },
      )
    : undefined;
  const outsideItemTitle = collectionIsRecord
    ? readRequiredString(
        collection.outsideItemTitle,
        "collection.outsideItemTitle",
        problems,
        { maximumLength: 512 },
      )
    : undefined;
  for (const [key, field] of [
    [collectionKey, "collection.key"],
    [outsideItemKey, "collection.outsideItemKey"],
  ]) {
    if (key !== undefined && !/^[A-Z0-9]{8}$/.test(key)) {
      problems.push(`${field} must be an eight-character Zotero object key`);
    }
  }

  const item = rawFixture.item;
  const itemIsRecord = validateExactKeys(
    item,
    ["key", "title", "itemType", "tag"],
    "item",
    problems,
  );
  const itemKey = itemIsRecord
    ? readRequiredString(item.key, "item.key", problems, {
        minimumLength: 8,
        maximumLength: 8,
      })
    : undefined;
  const title = itemIsRecord
    ? readRequiredString(item.title, "item.title", problems, {
        maximumLength: 512,
      })
    : undefined;
  const itemType = itemIsRecord
    ? readRequiredString(item.itemType, "item.itemType", problems, {
        maximumLength: 64,
      })
    : undefined;
  const tag = itemIsRecord
    ? readRequiredString(item.tag, "item.tag", problems, {
        maximumLength: 256,
      })
    : undefined;
  if (itemType !== undefined && !/^[a-z][A-Za-z0-9]*$/.test(itemType)) {
    problems.push(
      "item.itemType must be a Zotero item type such as journalArticle",
    );
  }
  if (itemKey !== undefined && !/^[A-Z0-9]{8}$/.test(itemKey)) {
    problems.push("item.key must be an eight-character Zotero item key");
  }

  const attachment = rawFixture.attachment;
  const attachmentIsRecord = validateExactKeys(
    attachment,
    [
      "key",
      "filename",
      "linkMode",
      "fulltextSearchQuery",
      "firstChunkText",
      "continuationText",
    ],
    "attachment",
    problems,
  );
  const attachmentKey = attachmentIsRecord
    ? readRequiredString(attachment.key, "attachment.key", problems, {
        minimumLength: 8,
        maximumLength: 8,
      })
    : undefined;
  const filename = attachmentIsRecord
    ? readRequiredString(attachment.filename, "attachment.filename", problems, {
        maximumLength: 255,
      })
    : undefined;
  const linkMode = attachmentIsRecord
    ? readRequiredString(attachment.linkMode, "attachment.linkMode", problems, {
        maximumLength: 64,
      })
    : undefined;
  const fulltextSearchQuery = attachmentIsRecord
    ? readRequiredString(
        attachment.fulltextSearchQuery,
        "attachment.fulltextSearchQuery",
        problems,
        { minimumLength: 16, maximumLength: 128 },
      )
    : undefined;
  const firstChunkText = attachmentIsRecord
    ? readRequiredString(
        attachment.firstChunkText,
        "attachment.firstChunkText",
        problems,
        { minimumLength: 16, maximumLength: 128 },
      )
    : undefined;
  const continuationText = attachmentIsRecord
    ? readRequiredString(
        attachment.continuationText,
        "attachment.continuationText",
        problems,
        { minimumLength: 16, maximumLength: 128 },
      )
    : undefined;

  if (filename !== undefined && !filename.toLowerCase().endsWith(".pdf")) {
    problems.push("attachment.filename must end in .pdf");
  }
  if (attachmentKey !== undefined && !/^[A-Z0-9]{8}$/.test(attachmentKey)) {
    problems.push("attachment.key must be an eight-character Zotero item key");
  }
  if (linkMode !== undefined && !/^imported_(?:file|url)$/.test(linkMode)) {
    problems.push(
      "attachment.linkMode must identify a stored Zotero attachment",
    );
  }
  if (itemKey !== undefined && itemKey === attachmentKey) {
    problems.push("item.key and attachment.key must be different");
  }

  if (problems.length > 0) {
    throwFixtureError(problems);
  }

  return {
    groupId,
    collection: {
      key: collectionKey,
      name: collectionName,
      outsideItemKey,
      outsideItemTitle,
    },
    item: { key: itemKey, title, itemType, tag },
    attachment: {
      key: attachmentKey,
      filename,
      linkMode,
      fulltextSearchQuery,
      firstChunkText,
      continuationText,
    },
  };
}

function throwFixtureError(problems) {
  throw new FixtureConfigurationError(
    [
      "The committed public Zotero E2E fixture is invalid.",
      `Update ${fixturePath} only after verifying the pinned public group, collection scope, item, attachment, searches, and extracted text against the Zotero API.`,
      `Place firstChunkText within extracted characters 0-${String(FULLTEXT_CHUNK_SIZE - 1)}, and continuationText within characters ${String(FULLTEXT_CHUNK_SIZE)}-${String(FULLTEXT_CHUNK_SIZE * 2 - 1)}.`,
      "Invalid or missing fields:",
      ...problems.map((problem) => `- ${problem}`),
    ].join("\n"),
  );
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: COMMAND_TIMEOUT_MS,
    ...options,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(
      `${command} ${args.join(" ")} exited with ${String(result.status)}${output.length === 0 ? "" : `\n${output}`}`,
    );
  }

  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function runNpm(args, options = {}) {
  if (process.env.npm_execpath) {
    return run(process.execPath, [process.env.npm_execpath, ...args], options);
  }

  return run(process.platform === "win32" ? "npm.cmd" : "npm", args, {
    ...options,
    shell: process.platform === "win32",
  });
}

function parsePackReport(output) {
  const trimmed = output.trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    const arrayStart = trimmed.lastIndexOf("\n[");
    if (arrayStart === -1) {
      throw new Error(`Could not parse npm pack JSON output:\n${trimmed}`);
    }
    return JSON.parse(trimmed.slice(arrayStart + 1));
  }
}

function requireRecord(value, field) {
  invariant(
    isRecord(value),
    `${field} must be an object; received ${inspect(value)}.`,
  );
  return value;
}

function requireArray(value, field) {
  invariant(
    Array.isArray(value),
    `${field} must be an array; received ${inspect(value)}.`,
  );
  return value;
}

function requireString(value, field) {
  invariant(typeof value === "string", `${field} must be a string.`);
  return value;
}

function requireInteger(value, field) {
  invariant(Number.isSafeInteger(value), `${field} must be an integer.`);
  return value;
}

function toolErrorText(result) {
  const textBlocks = Array.isArray(result.content)
    ? result.content
        .filter(
          (block) =>
            isRecord(block) &&
            block.type === "text" &&
            typeof block.text === "string",
        )
        .map((block) => block.text)
    : [];
  return textBlocks.length > 0
    ? textBlocks.join("\n")
    : inspect(result.structuredContent ?? result.content);
}

function structuredToolOutput(result, toolName) {
  invariant(
    result.isError !== true,
    `${toolName} returned an MCP tool error: ${toolErrorText(result)}`,
  );
  return requireRecord(
    result.structuredContent,
    `${toolName}.structuredContent`,
  );
}

function validateIndexingMetadata(output, field) {
  const indexedPages = output.indexed_pages;
  const totalPages = output.total_pages;
  const indexedChars = output.indexed_chars;
  const totalChars = output.total_chars;
  const hasPageMetadata =
    Number.isSafeInteger(indexedPages) && Number.isSafeInteger(totalPages);
  const hasCharacterMetadata =
    Number.isSafeInteger(indexedChars) && Number.isSafeInteger(totalChars);

  invariant(
    hasPageMetadata || hasCharacterMetadata,
    `${field} did not contain Zotero indexing page or character metadata.`,
  );
  if (hasPageMetadata) {
    invariant(indexedPages > 0, `${field}.indexed_pages must be positive.`);
    invariant(totalPages > 0, `${field}.total_pages must be positive.`);
    invariant(
      indexedPages <= totalPages,
      `${field}.indexed_pages must not exceed total_pages.`,
    );
  }
  if (hasCharacterMetadata) {
    invariant(
      indexedChars >= 0,
      `${field}.indexed_chars must be non-negative.`,
    );
    invariant(totalChars >= 0, `${field}.total_chars must be non-negative.`);
    invariant(
      indexedChars <= totalChars,
      `${field}.indexed_chars must not exceed total_chars.`,
    );
  }
  invariant(
    typeof output.partial_index === "boolean",
    `${field}.partial_index must be a boolean.`,
  );
}

function requestOptions() {
  return { timeout: REQUEST_TIMEOUT_MS, maxTotalTimeout: REQUEST_TIMEOUT_MS };
}

async function callTool(client, name, args) {
  return client.callTool({ name, arguments: args }, requestOptions());
}

function withTimeout(promise, timeoutMs, operation) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(`${operation} timed out after ${String(timeoutMs)} ms.`),
        ),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function cleanEnvironment() {
  const environment = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) environment[name] = value;
  }
  delete environment.ZOTERO_API_KEY;
  return environment;
}

async function verifyProtocol(client, packageVersion) {
  const serverVersion = client.getServerVersion();
  invariant(
    serverVersion?.name === "zotero-mcp",
    "Unexpected MCP server name.",
  );
  invariant(
    serverVersion.version === packageVersion,
    `Expected server version ${packageVersion}, received ${inspect(serverVersion.version)}.`,
  );

  const { tools } = await client.listTools(undefined, requestOptions());
  invariant(
    inspect(tools.map((tool) => tool.name)) === inspect(TOOL_NAMES),
    `Expected exactly ${TOOL_NAMES.join(", ")}; received ${tools.map((tool) => tool.name).join(", ")}.`,
  );
  for (const tool of tools) {
    invariant(
      tool.annotations?.readOnlyHint === true &&
        tool.annotations.destructiveHint === false &&
        tool.annotations.idempotentHint === true &&
        tool.annotations.openWorldHint === true,
      `${tool.name} did not advertise the expected read-only annotations.`,
    );
  }
}

async function verifyFixtureTools(client, fixture) {
  const collectionList = structuredToolOutput(
    await callTool(client, "zotero_list_collections", {
      limit: 10,
      start: 0,
    }),
    "zotero_list_collections",
  );
  const collections = requireArray(
    collectionList.collections,
    "collection list",
  ).map((value, index) =>
    requireRecord(value, `collection list item ${index}`),
  );
  invariant(
    collectionList.focused_collection_key === fixture.collection.key &&
      collectionList.total_results === 1 &&
      collectionList.next_start === null &&
      collections.length === 1 &&
      collections[0].key === fixture.collection.key &&
      collections[0].name === fixture.collection.name &&
      inspect(collections[0].path) === inspect([fixture.collection.name]) &&
      collections[0].depth === 0,
    `Expected only the configured public collection scope; received ${inspect(collectionList)}.`,
  );

  const outsideSearch = structuredToolOutput(
    await callTool(client, "zotero_search_items", {
      query: fixture.collection.outsideItemTitle,
      limit: 10,
    }),
    "zotero_search_items(outside scope)",
  );
  invariant(
    outsideSearch.total_results === 0 &&
      requireArray(outsideSearch.items, "outside-scope search items").length ===
        0,
    `Expected collection search to hide the outside item; received ${inspect(outsideSearch)}.`,
  );

  const outsideItemResult = await callTool(client, "zotero_get_item", {
    item_key: fixture.collection.outsideItemKey,
  });
  const outsideError = requireRecord(
    requireRecord(
      outsideItemResult.structuredContent,
      "outside-scope structured output",
    ).error,
    "outside-scope error",
  );
  invariant(
    outsideItemResult.isError === true &&
      outsideError.code === "outside_collection_scope" &&
      !inspect(outsideItemResult).includes(fixture.collection.outsideItemTitle),
    `Expected direct outside-scope access to fail without leaking item metadata; received ${inspect(outsideItemResult)}.`,
  );

  const metadataSearch = structuredToolOutput(
    await callTool(client, "zotero_search_items", {
      query: fixture.item.title,
      item_type: fixture.item.itemType,
      tag: fixture.item.tag,
      limit: 10,
    }),
    "zotero_search_items(metadata)",
  );
  const metadataItems = requireArray(
    metadataSearch.items,
    "metadata search items",
  ).map((value, index) =>
    requireRecord(value, `metadata search item ${index}`),
  );
  const exactMatches = metadataItems.filter(
    (item) =>
      item.key === fixture.item.key &&
      item.title === fixture.item.title &&
      item.item_type === fixture.item.itemType &&
      Array.isArray(item.tags) &&
      item.tags.includes(fixture.item.tag),
  );
  invariant(
    metadataSearch.total_results === 1 && exactMatches.length === 1,
    `Expected one exact fixture item from title/type/tag search; received ${inspect(metadataSearch)}.`,
  );
  const parentKey = requireString(exactMatches[0].key, "fixture item key");
  invariant(
    parentKey === fixture.item.key,
    `Expected fixture item ${fixture.item.key}, received ${inspect(parentKey)}.`,
  );

  const fulltextSearch = structuredToolOutput(
    await callTool(client, "zotero_search_items", {
      query: fixture.attachment.fulltextSearchQuery,
      search_mode: "everything",
      limit: 10,
    }),
    "zotero_search_items(everything)",
  );
  const fulltextItems = requireArray(
    fulltextSearch.items,
    "everything search items",
  ).map((value, index) =>
    requireRecord(value, `everything search item ${index}`),
  );
  invariant(
    fulltextSearch.total_results === 1 &&
      fulltextItems.length === 1 &&
      fulltextItems[0].key === parentKey &&
      fulltextItems[0].title === fixture.item.title,
    `Expected the PDF-only full-text search to return only the fixture parent item; received ${inspect(fulltextSearch)}.`,
  );

  const parentOutput = structuredToolOutput(
    await callTool(client, "zotero_get_item", { item_key: parentKey }),
    "zotero_get_item(parent)",
  );
  const parentItem = requireRecord(parentOutput.item, "parent item");
  const parentData = requireRecord(parentItem.data, "parent item data");
  invariant(
    parentItem.key === parentKey,
    "zotero_get_item returned another item.",
  );
  invariant(
    parentData.title === fixture.item.title &&
      parentData.itemType === fixture.item.itemType,
    "zotero_get_item returned unexpected fixture metadata.",
  );
  invariant(
    parentOutput.total_children === 1 &&
      parentOutput.children_truncated === false,
    `Fixture parent must have exactly one child; received ${inspect(parentOutput)}.`,
  );
  const children = requireArray(parentOutput.children, "parent children").map(
    (value, index) => requireRecord(value, `parent child ${index}`),
  );
  invariant(
    children.length === 1,
    "Fixture parent must return exactly one child.",
  );
  const attachment = children[0];
  invariant(
    attachment.key === fixture.attachment.key &&
      attachment.item_type === "attachment" &&
      attachment.content_type === "application/pdf" &&
      attachment.filename === fixture.attachment.filename &&
      attachment.parent_item === parentKey,
    `Fixture child is not the expected PDF attachment: ${inspect(attachment)}.`,
  );
  const attachmentKey = requireString(attachment.key, "attachment key");
  invariant(
    attachmentKey === fixture.attachment.key,
    `Expected fixture attachment ${fixture.attachment.key}, received ${inspect(attachmentKey)}.`,
  );

  const attachmentOutput = structuredToolOutput(
    await callTool(client, "zotero_get_item", { item_key: attachmentKey }),
    "zotero_get_item(attachment)",
  );
  const attachmentItem = requireRecord(
    attachmentOutput.item,
    "attachment item",
  );
  const attachmentData = requireRecord(
    attachmentItem.data,
    "attachment item data",
  );
  invariant(
    attachmentItem.key === attachmentKey &&
      attachmentData.itemType === "attachment" &&
      attachmentData.parentItem === parentKey &&
      attachmentData.filename === fixture.attachment.filename &&
      attachmentData.contentType === "application/pdf" &&
      attachmentData.linkMode === fixture.attachment.linkMode,
    `Fixture PDF must be a stored child attachment: ${inspect(attachmentData)}.`,
  );

  const metadataText = JSON.stringify([
    parentData,
    attachmentData,
  ]).toLowerCase();
  invariant(
    !metadataText.includes(
      fixture.attachment.fulltextSearchQuery.toLowerCase(),
    ),
    `Full-text search query ${inspect(fixture.attachment.fulltextSearchQuery)} appears in Zotero item metadata instead of only in the PDF text.`,
  );

  const firstFulltext = structuredToolOutput(
    await callTool(client, "zotero_get_fulltext", {
      item_key: parentKey,
      offset: 0,
      max_chars: FULLTEXT_CHUNK_SIZE,
    }),
    "zotero_get_fulltext(parent first chunk)",
  );
  const firstText = requireString(firstFulltext.text, "first full-text chunk");
  const firstAttachment = requireRecord(
    firstFulltext.attachment,
    "first full-text attachment",
  );
  invariant(
    firstAttachment.key === attachmentKey,
    "Parent full-text lookup resolved an unexpected attachment.",
  );
  invariant(
    firstText.includes(fixture.attachment.firstChunkText),
    "The first full-text chunk did not contain the configured opening text.",
  );
  invariant(
    firstFulltext.offset === 0 &&
      firstFulltext.returned_chars === firstText.length &&
      firstFulltext.truncated === true,
    `The first full-text response did not report a truncated initial chunk: ${inspect(firstFulltext)}.`,
  );
  const nextOffset = requireInteger(
    firstFulltext.next_offset,
    "first full-text next_offset",
  );
  invariant(
    nextOffset === firstText.length && nextOffset > 0,
    "The first full-text next_offset did not match the returned chunk length.",
  );
  validateIndexingMetadata(firstFulltext, "first full-text response");

  const continuedFulltext = structuredToolOutput(
    await callTool(client, "zotero_get_fulltext", {
      item_key: parentKey,
      offset: nextOffset,
      max_chars: FULLTEXT_CHUNK_SIZE,
    }),
    "zotero_get_fulltext(parent continuation)",
  );
  const continuedText = requireString(
    continuedFulltext.text,
    "continued full-text chunk",
  );
  invariant(
    continuedFulltext.offset === nextOffset &&
      requireRecord(
        continuedFulltext.attachment,
        "continued full-text attachment",
      ).key === attachmentKey,
    "The full-text continuation did not retain its offset and attachment.",
  );
  invariant(
    continuedText.includes(fixture.attachment.continuationText),
    "The followed next_offset chunk did not contain continuationText.",
  );
  validateIndexingMetadata(continuedFulltext, "continued full-text response");

  const directFulltext = structuredToolOutput(
    await callTool(client, "zotero_get_fulltext", {
      item_key: attachmentKey,
      offset: 0,
      max_chars: FULLTEXT_CHUNK_SIZE * 2,
    }),
    "zotero_get_fulltext(attachment)",
  );
  const directItem = requireRecord(
    directFulltext.item,
    "direct full-text item",
  );
  const directAttachment = requireRecord(
    directFulltext.attachment,
    "direct full-text attachment",
  );
  const directText = requireString(directFulltext.text, "direct full text");
  invariant(
    directItem.key === attachmentKey && directAttachment.key === attachmentKey,
    "Direct attachment-key full-text access returned another item.",
  );
  invariant(
    directText.includes(fixture.attachment.firstChunkText) &&
      directText.includes(fixture.attachment.continuationText),
    "Direct attachment-key access did not return both configured PDF text fragments.",
  );
  validateIndexingMetadata(directFulltext, "direct full-text response");

  return { parentKey, attachmentKey };
}

async function runEndToEnd() {
  const fixture = loadFixture();
  const temporaryRoot = mkdtempSync(join(tmpdir(), "zotero-mcp-e2e-"));
  const packDirectory = join(temporaryRoot, "pack");
  const consumerDirectory = join(temporaryRoot, "consumer");
  let client;
  let transport;
  let serverStderr = "";

  mkdirSync(packDirectory);
  mkdirSync(consumerDirectory);

  try {
    console.log("Building the project...");
    runNpm(["run", "build"]);

    console.log("Packing the npm artifact...");
    const packResult = runNpm([
      "pack",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      packDirectory,
    ]);
    const report = parsePackReport(packResult.stdout);
    invariant(
      Array.isArray(report) && report.length === 1,
      "Expected npm pack to report exactly one tarball.",
    );
    const packedPackage = requireRecord(report[0], "npm pack report");
    const tarballFilename = requireString(
      packedPackage.filename,
      "npm pack filename",
    );
    const tarballPath = join(packDirectory, basename(tarballFilename));

    writeFileSync(
      join(consumerDirectory, "package.json"),
      `${JSON.stringify({ name: "zotero-mcp-public-e2e", private: true }, null, 2)}\n`,
    );
    console.log("Installing the tarball in a clean consumer project...");
    runNpm(
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        "--prefer-offline",
        tarballPath,
      ],
      { cwd: consumerDirectory },
    );

    const installedPackageRoot = join(
      consumerDirectory,
      "node_modules",
      "@zhongxuanwu",
      "zotero-mcp",
    );
    const installedManifest = requireRecord(
      JSON.parse(
        readFileSync(join(installedPackageRoot, "package.json"), "utf8"),
      ),
      "installed package manifest",
    );
    const installedBin = requireRecord(installedManifest.bin, "installed bin");
    invariant(
      installedBin["zotero-mcp"] === "dist/cli.js",
      "The installed package does not expose the expected zotero-mcp binary.",
    );
    const packageVersion = requireString(
      installedManifest.version,
      "installed package version",
    );
    const binaryPath = join(
      consumerDirectory,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "zotero-mcp.cmd" : "zotero-mcp",
    );
    const installedEntryPath = join(installedPackageRoot, "dist", "cli.js");
    const command =
      process.platform === "win32" ? process.execPath : binaryPath;
    const commandArgs = [
      ...(process.platform === "win32" ? [installedEntryPath] : []),
      "--library",
      `group:${String(fixture.groupId)}`,
      "--collection",
      fixture.collection.key,
    ];

    transport = new StdioClientTransport({
      command,
      args: commandArgs,
      cwd: consumerDirectory,
      env: cleanEnvironment(),
      stderr: "pipe",
    });
    transport.stderr?.setEncoding("utf8");
    transport.stderr?.on("data", (chunk) => {
      serverStderr = `${serverStderr}${String(chunk)}`.slice(
        -MAX_CAPTURED_STDERR_CHARS,
      );
    });

    client = new Client({
      name: "zotero-mcp-public-e2e",
      version: packageVersion,
    });
    console.log("Connecting to the installed binary over MCP stdio...");
    await client.connect(transport, { timeout: STARTUP_TIMEOUT_MS });
    await verifyProtocol(client, packageVersion);

    console.log("Reading the credential-free public Zotero fixture...");
    const keys = await verifyFixtureTools(client, fixture);
    console.log(
      `Public Zotero E2E passed for group ${String(fixture.groupId)}, collection ${fixture.collection.key} (item ${keys.parentKey}, attachment ${keys.attachmentKey}) using ${basename(tarballPath)}.`,
    );
  } catch (error) {
    const diagnostic = serverStderr.trim();
    if (diagnostic.length > 0) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n\nInstalled server stderr (last ${String(MAX_CAPTURED_STDERR_CHARS)} characters):\n${diagnostic}`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    if (client !== undefined) {
      try {
        await withTimeout(client.close(), CLOSE_TIMEOUT_MS, "MCP client close");
      } catch (error) {
        console.error(
          `Warning: MCP client cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        const pid = transport?.pid;
        if (pid !== null && pid !== undefined) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // The process may already have exited.
          }
        }
      }
    } else if (transport !== undefined) {
      try {
        await withTimeout(
          transport.close(),
          CLOSE_TIMEOUT_MS,
          "MCP transport close",
        );
      } catch {
        const pid = transport.pid;
        if (pid !== null) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // The process may already have exited.
          }
        }
      }
    }
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

try {
  await runEndToEnd();
} catch (error) {
  if (error instanceof FixtureConfigurationError) {
    console.error(error.message);
  } else {
    console.error(
      `Public Zotero E2E failed:\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
  }
  process.exitCode = 1;
}
