#!/usr/bin/env node

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { createZoteroMcpServer, SERVER_VERSION } from "./server.js";
import { ZoteroClient } from "./zotero/client.js";
import {
  LIBRARY_SELECTOR_HELP,
  parseLibrarySelector,
} from "./zotero/library.js";
import type { LibraryLocator } from "./zotero/types.js";

const HELP = `zotero-mcp ${SERVER_VERSION}

A local, read-only MCP server for the Zotero Web API.

Usage:
  zotero-mcp [--library <type:id>]
  zotero-mcp --help
  zotero-mcp --version

Options:
  --library <type:id>  Target user:<positive-id> or group:<positive-id>

Environment:
  ZOTERO_API_KEY  Required without --library; optional for public libraries
`;

function writeStdout(text: string): void {
  process.stdout.write(text);
}

function writeStderr(text: string): void {
  process.stderr.write(text);
}

export function main(
  args: readonly string[] = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
): void {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    writeStdout(HELP);
    return;
  }
  if (args.length === 1 && (args[0] === "--version" || args[0] === "-V")) {
    writeStdout(`${SERVER_VERSION}\n`);
    return;
  }

  let library: LibraryLocator | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument !== "--library") {
      writeStderr(
        `Unknown argument: ${argument ?? ""}\nRun zotero-mcp --help for usage.\n`,
      );
      process.exitCode = 2;
      return;
    }
    if (library !== undefined) {
      writeStderr(
        "--library may only be provided once.\nRun zotero-mcp --help for usage.\n",
      );
      process.exitCode = 2;
      return;
    }

    const selector = args[index + 1];
    if (selector === undefined || selector.startsWith("-")) {
      writeStderr(
        `--library requires a value. ${LIBRARY_SELECTOR_HELP}\nRun zotero-mcp --help for usage.\n`,
      );
      process.exitCode = 2;
      return;
    }

    try {
      library = parseLibrarySelector(selector);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid value.";
      writeStderr(`${message}\nRun zotero-mcp --help for usage.\n`);
      process.exitCode = 2;
      return;
    }
    index += 1;
  }

  const apiKey = environment.ZOTERO_API_KEY?.trim() || undefined;
  if (apiKey === undefined && library === undefined) {
    writeStderr(
      "ZOTERO_API_KEY is required when --library is omitted. Create a read-only key at https://www.zotero.org/settings/keys and provide it through the environment, or configure a public library with --library.\n",
    );
    process.exitCode = 1;
    return;
  }

  const client = new ZoteroClient({
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(library === undefined ? {} : { library }),
  });
  serveStdio(() => createZoteroMcpServer(client), {
    onerror: () => {
      writeStderr("The MCP STDIO connection encountered an error.\n");
    },
  });
}

main();
