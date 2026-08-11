# zotero-mcp

`zotero-mcp` is a local, read-only Model Context Protocol (MCP) server for a
configured Zotero library. A coding agent such as Codex CLI or Claude Code
starts it as a child process and communicates over standard input/output. The
process reads synchronized library data from the Zotero Web API over HTTPS;
this project does not operate a hosted relay or account service.

```text
Codex CLI, Claude Code, or another MCP client  <-- local stdio -->  zotero-mcp
                                                                    |
                                                                    +-- HTTPS --> api.zotero.org
```

> **Pre-release:** this package is not published to npm and will remain
> source-only for now. Clone the repository, install its dependencies, and
> build it locally by following the instructions below.

## Supported tools

### `zotero_list_collections`

List and paginate the configured library's collection hierarchy in
deterministic depth-first order. Results include stable collection keys, names,
full paths, parent keys, depths, and Zotero-reported item and subcollection
counts. When collection focus is configured, only that collection tree is
listed.

### `zotero_search_items`

Search and paginate top-level items in the configured Zotero library or focused
collection tree. Inputs include text, `metadata` or `everything` search mode,
item type, tag, page size, and offset. Results contain compact item metadata and
pagination information. This uses Zotero API search, not semantic or vector
search.

### `zotero_get_item`

Get complete data for an item by its Zotero `item_key`, together with compact
descriptors for child notes and attachments. A child item can also be requested
directly by its own key.

### `zotero_get_fulltext`

Read text that Zotero has already indexed for a PDF attachment. Pass a parent
item key or attachment key, and optionally an attachment key, character offset,
and chunk size. If a parent has exactly one PDF, it is selected automatically;
if it has several, the tool returns candidates. Results include truncation,
`next_offset`, and Zotero indexing coverage when available.

All four tools are read-only.

## Pre-release installation

Git, npm, and Node.js 20 or newer are required.

### Download the source

```bash
git clone https://github.com/ZhongxuanWu/zotero-mcp.git
cd zotero-mcp
```

### Install and build

Install the locked dependencies, compile TypeScript into `dist`, and verify the
built command:

```bash
npm ci
npm run build
node dist/cli.js --help
```

Coding-agent configurations must use an absolute path to `dist/cli.js`. On
macOS or Linux, run `pwd` from the repository root to get the checkout path. On
PowerShell, run `Resolve-Path .`.

### Update an existing checkout

Pull the latest source, synchronize dependencies, and rebuild:

```bash
git pull --ff-only
npm ci
npm run build
```

Rebuilding updates the existing `dist/cli.js`; coding-agent configuration does
not need to change while the checkout stays at the same path.

## Zotero configuration

Library selection and authentication are separate:

- With no `--library` option, `ZOTERO_API_KEY` is required. The server asks
  Zotero which user owns the key and reads that user's personal library. This
  preserves the original key-only behavior.
- `--library user:<positive-id>` selects a user library directly.
- `--library group:<positive-id>` selects a group library directly.
- With an explicit selector, the API key is optional. Omit it for a library
  that Zotero exposes publicly, or provide a key that can read a restricted
  library. The server sends an API-key header only when a non-empty key is
  present.

Run `node dist/cli.js --help` from the checkout for the complete CLI syntax.
Invalid selectors, such as unknown library types, zero, negative, or
non-numeric IDs, are rejected before the MCP server starts.

### Private personal library

Create a dedicated read-only key in
[Zotero's API key settings](https://www.zotero.org/settings/keys/new). Enable
personal-library read access, enable note access only if you need note bodies,
and leave write access disabled. Put the key in the process environment:

```bash
export ZOTERO_API_KEY="your-read-only-key"
```

PowerShell:

```powershell
$env:ZOTERO_API_KEY = "your-read-only-key"
```

No numeric user ID is needed in this mode.

### Credential-free public library

For a public user or group library, pass its numeric Zotero ID explicitly and
do not set `ZOTERO_API_KEY`:

```bash
node /absolute/path/to/zotero-mcp/dist/cli.js \
  --library "group:<public-group-id>"
node /absolute/path/to/zotero-mcp/dist/cli.js \
  --library "user:<public-user-id>"
```

Replace the angle-bracketed value with a positive integer. Whether a library
can be read without credentials is controlled by its owner in Zotero; selecting
it does not make a private library public. See Zotero's documentation for
[Web API access](https://www.zotero.org/support/dev/web_api/v3/basics) and
[group library settings](https://www.zotero.org/support/groups).

### Focus on a collection

Use `zotero_list_collections` without collection focus to discover stable
collection keys. Then add `--collection <key>` and restart the MCP server:

```bash
node /absolute/path/to/zotero-mcp/dist/cli.js \
  --collection ABCD1234
node /absolute/path/to/zotero-mcp/dist/cli.js \
  --library "group:<group-id>" \
  --collection ABCD1234
```

The first form uses the personal library discovered from `ZOTERO_API_KEY`; the
second selects a group library. Collection keys are eight alphanumeric
characters and are normalized to uppercase.

Focus includes the selected collection and every nested subcollection. Search
results are merged and deduplicated when an item belongs to multiple included
collections. `zotero_get_item` and `zotero_get_fulltext` reject keys outside the
focused tree; child notes and attachments remain accessible when their parent
item is in scope. `zotero_list_collections` lists only the focused tree after
the option is configured.

The commands above start an MCP stdio process directly. Waiting silently for
protocol input is normal; in regular use, let a configured coding agent start
the process.

## Coding agent configuration

The examples below use the locally built entry point. Replace
`/absolute/path/to/zotero-mcp` with the absolute path to your checkout,
`<user-id>` or `<group-id>` with a positive numeric Zotero library ID, and
`ABCD1234` with an eight-character collection key.

For a private library, export `ZOTERO_API_KEY` before starting the coding agent.
For a public library, use an explicit `--library` selector and omit the key.

### Codex CLI

Codex stores MCP servers in `~/.codex/config.toml`. For a private user library
focused on one collection, add:

```toml
[mcp_servers.zotero]
command = "node"
args = [
  "/absolute/path/to/zotero-mcp/dist/cli.js",
  "--library",
  "user:<user-id>",
  "--collection",
  "ABCD1234",
]
env_vars = ["ZOTERO_API_KEY"]
```

When the key belongs to the personal library you want to use, you may omit the
`--library` pair and let the server discover the user ID from the key. To use a
private group, change the selector to `group:<group-id>` and retain
`env_vars = ["ZOTERO_API_KEY"]`.

For a credential-free public group and collection, add a separate server and
omit `env_vars`:

```toml
[mcp_servers.zotero_public]
command = "node"
args = [
  "/absolute/path/to/zotero-mcp/dist/cli.js",
  "--library",
  "group:<group-id>",
  "--collection",
  "ABCD1234",
]
```

Export the key before launching Codex for a private library:

```bash
export ZOTERO_API_KEY="your-read-only-key"
codex
```

PowerShell:

```powershell
$env:ZOTERO_API_KEY = "your-read-only-key"
codex
```

Restart an active Codex session after changing `config.toml`. Run
`codex mcp list` from the shell or `/mcp` inside Codex to verify the connection.
See the official [Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp.md)
for additional configuration options.

### Claude Code

The following command adds a private, collection-focused server at user scope,
making it available across your local Claude Code projects. Export
`ZOTERO_API_KEY` first, as shown above:

```bash
claude mcp add \
  --env ZOTERO_API_KEY="$ZOTERO_API_KEY" \
  --transport stdio \
  --scope user \
  zotero \
  -- node /absolute/path/to/zotero-mcp/dist/cli.js \
  --library "user:<user-id>" \
  --collection ABCD1234
```

The `--env` option records the expanded key in Claude Code's private user
configuration at `~/.claude.json`; protect that file and never commit the key.
As with Codex, you may omit the `--library` pair for key-based personal-library
discovery, or use `group:<group-id>` with a key for a private group.

For a credential-free public group and collection, omit `--env`:

```bash
claude mcp add \
  --transport stdio \
  --scope user \
  zotero-public \
  -- node /absolute/path/to/zotero-mcp/dist/cli.js \
  --library "group:<group-id>" \
  --collection ABCD1234
```

Run `claude mcp list` or `claude mcp get zotero` from the shell, or `/mcp`
inside Claude Code, to verify the connection. See the official
[Claude Code MCP documentation](https://code.claude.com/docs/en/mcp) for scope
and server-management details.

Other MCP clients can use the same `node` command, absolute entry-point path,
arguments, and environment in their local stdio-server configuration format.

## Privacy and security

- The MCP process runs locally. It communicates with Zotero's Web API over
  HTTPS and returns results to the MCP client that launched it.
- The server does not intentionally persist API keys or library content. A key
  is sent only to Zotero, and only when one is configured.
- Tool results may be sent onward to the model or service used by your MCP
  client. Review that client's data policy before exposing sensitive content.
- Prefer a dedicated read-only key, keep it out of source control and logs, and
  revoke it from Zotero's settings if it is exposed.
- Standard output is reserved for MCP protocol messages. Diagnostics go to
  standard error and must not contain credentials.
- Public-library mode removes the need for a credential; it does not change the
  visibility of the source library or the sensitivity of retrieved content.

## Limitations

- Read-only: there are no create, update, delete, upload, or annotation-writing
  tools.
- No OAuth flow. Restricted libraries require `ZOTERO_API_KEY`.
- No semantic search, local database integration, or persistent local content
  cache.
- For authenticated libraries, note bodies require the API key's separate
  note-read permission.
- Full text is limited to content already indexed and synced by Zotero. The
  server does not download or parse PDFs itself. See Zotero's
  [full-text API documentation](https://www.zotero.org/support/dev/web_api/v3/fulltext_content).
- The server uses stdio only and does not expose an HTTP endpoint.
- Live behavior depends on Zotero API availability, public-library settings,
  and Zotero's search and full-text indexes.

## Development and testing

```bash
npm ci
npm run check
```

`npm run check` runs formatting, linting, type checking, mocked tests, a build,
and a package-tarball smoke test. The mocked suite covers protocol and tool
behavior without an API key or network access and remains the fast pull-request
check.

The separate public-library test exercises the packed npm artifact through a
real MCP stdio connection:

```bash
npm run test:e2e:public
```

It packs the project into an operating-system temporary directory, installs the
tarball in a clean consumer project, removes `ZOTERO_API_KEY` from the child
environment, and connects to the installed `zotero-mcp` executable. The test
performs the MCP handshake and verifies collection listing and isolation,
search, item retrieval, attachment discovery, indexed-PDF search, chunked full
text, and direct attachment access.
It requires outbound HTTPS access and a responsive Zotero API, so it runs only
on a weekly schedule or by manual workflow dispatch. It is intentionally not a
required pull-request check; run it manually as a release prerequisite until
publishing is automated.

### Public test fixture

The live suite reads the public
[`Systems and Computational Neuroscience 2021`](https://www.zotero.org/groups/4445743/systems_and_computational_neuroscience_2021)
group (`4445743`) without credentials. It pins one uniquely searchable journal
article in the `Systems Neuroscience` collection, its sole stored PDF
attachment, and one item outside that collection so the test remains
deterministic.

[`test/e2e/public-library-fixture.json`](test/e2e/public-library-fixture.json)
is the committed contract. It records the collection scope, an outside item,
the expected parent and attachment keys, metadata filters, stored-attachment
details, a PDF-only search query, and text fragments in the first two
256-character chunks. The fixture and test contain no API key or private-library
data, and the test makes no Zotero write requests.

The group is not controlled by this project. A failure can indicate a Zotero
outage, indexing delay, rate limit, or external-library change as well as a
package regression. Confirm the pinned public item, child, searches, and
full-text API response before refreshing the fixture.

## Acknowledgement

This project was inspired by
[`yilewang/llm-for-zotero`](https://github.com/yilewang/llm-for-zotero). `llm-for-zotero` uses LLMs in Zotero. `zotero-mcp` uses Zotero in LLMs.

## License

[MIT](LICENSE)
