#!/usr/bin/env node

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { createZoteroMcpServer, SERVER_VERSION } from "./server.js";
import { ZoteroClient } from "./zotero/client.js";

const HELP = `zotero-mcp ${SERVER_VERSION}

A local, read-only MCP server for the Zotero Web API.

Usage:
  zotero-mcp
  zotero-mcp --help
  zotero-mcp --version

Environment:
  ZOTERO_API_KEY  A Zotero API key with personal-library read access (required)
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
  if (args.includes("--help") || args.includes("-h")) {
    writeStdout(HELP);
    return;
  }
  if (args.includes("--version") || args.includes("-V")) {
    writeStdout(`${SERVER_VERSION}\n`);
    return;
  }
  if (args.length > 0) {
    writeStderr(
      `Unknown argument: ${args[0]}\nRun zotero-mcp --help for usage.\n`,
    );
    process.exitCode = 2;
    return;
  }

  const apiKey = environment.ZOTERO_API_KEY?.trim();
  if (apiKey === undefined || apiKey.length === 0) {
    writeStderr(
      "ZOTERO_API_KEY is required. Create a read-only key at https://www.zotero.org/settings/keys and provide it through the environment.\n",
    );
    process.exitCode = 1;
    return;
  }

  const client = new ZoteroClient({ apiKey });
  serveStdio(() => createZoteroMcpServer(client), {
    onerror: () => {
      writeStderr("The MCP STDIO connection encountered an error.\n");
    },
  });
}

main();
