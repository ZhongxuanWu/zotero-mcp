# zotero-mcp

`zotero-mcp` is a local, read-only Model Context Protocol (MCP) server for a
configured Zotero library. An MCP client such as Codex starts it as a child
process and communicates over standard input/output. The process reads
synchronized library data from the Zotero Web API over HTTPS; this project does
not operate a hosted relay or account service.

```text
Codex or another MCP client  <-- local stdio -->  zotero-mcp
                                                    |
                                                    +-- HTTPS --> api.zotero.org
```

> **Pre-release:** the package is not yet published to npm. Build and run it
> from source today. The `npx` and global-install examples below describe the
> intended package interface after the first release.

## Supported tools

### `zotero_search_items`

Search and paginate top-level items in the configured Zotero library. Inputs
include text, `metadata` or `everything` search mode, item type, tag, page size,
and offset. Results contain compact item metadata and pagination information.
This uses Zotero API search, not semantic or vector search.

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

All three tools are read-only.

## Configuration

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

Run `zotero-mcp --help` for the complete CLI syntax. Invalid selectors, such as
unknown library types, zero, negative, or non-numeric IDs, are rejected before
the MCP server starts.

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
zotero-mcp --library group:<public-group-id>
zotero-mcp --library user:<public-user-id>
```

Replace the angle-bracketed value with a positive integer. Whether a library
can be read without credentials is controlled by its owner in Zotero; selecting
it does not make a private library public. See Zotero's documentation for
[Web API access](https://www.zotero.org/support/dev/web_api/v3/basics) and
[group library settings](https://www.zotero.org/support/groups).

## Run from source (available now)

Node.js 20 or newer is required.

```bash
git clone https://github.com/ZhongxuanWu/zotero-mcp.git
cd zotero-mcp
npm ci
npm run build
```

For a private personal library, point the client at the built entry point and
forward the key. A Codex configuration in `~/.codex/config.toml` looks like:

```toml
[mcp_servers.zotero]
command = "node"
args = ["/absolute/path/to/zotero-mcp/dist/cli.js"]
env_vars = ["ZOTERO_API_KEY"]
```

For a public group, use the selector instead and omit secret forwarding:

```toml
[mcp_servers.zotero_public]
command = "node"
args = [
  "/absolute/path/to/zotero-mcp/dist/cli.js",
  "--library",
  "group:<public-group-id>",
]
```

Restart Codex after changing its configuration. Other MCP clients can use the
same command, arguments, and environment in their local stdio-server format.

You can also start `node dist/cli.js` directly for diagnostics. It is an MCP
stdio process, so waiting silently for protocol input is normal.

## Use the published package (after release)

These commands will apply once `@zhongxuanwu/zotero-mcp` is published; they do
not work as installation instructions during the current pre-release phase.

### Codex

Private personal library:

```toml
[mcp_servers.zotero]
command = "npx"
args = ["-y", "@zhongxuanwu/zotero-mcp"]
env_vars = ["ZOTERO_API_KEY"]
```

Credential-free public group:

```toml
[mcp_servers.zotero_public]
command = "npx"
args = [
  "-y",
  "@zhongxuanwu/zotero-mcp",
  "--library",
  "group:<public-group-id>",
]
```

Export `ZOTERO_API_KEY` before starting Codex for the private configuration.
`env_vars` forwards the existing value without copying it into `config.toml`.

### Other MCP clients

Private personal library, using the common JSON configuration shape:

```json
{
  "mcpServers": {
    "zotero": {
      "command": "npx",
      "args": ["-y", "@zhongxuanwu/zotero-mcp"],
      "env": {
        "ZOTERO_API_KEY": "your-read-only-key"
      }
    }
  }
}
```

Credential-free public group:

```json
{
  "mcpServers": {
    "zotero-public": {
      "command": "npx",
      "args": [
        "-y",
        "@zhongxuanwu/zotero-mcp",
        "--library",
        "group:<public-group-id>"
      ]
    }
  }
}
```

Configuration formats differ among clients. Prefer environment or secret
forwarding when the client supports it. If a client requires a key in its
configuration, keep that file private and never commit it.

After release, a global installation will also be available:

```bash
npm install --global @zhongxuanwu/zotero-mcp
zotero-mcp --help
```

Use `command = "zotero-mcp"` in place of `npx` when globally installed.

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
- No collection-browsing tool, semantic search, local database integration, or
  local content cache.
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
performs the MCP handshake and verifies search, item retrieval, attachment
discovery, indexed-PDF search, chunked full text, and direct attachment access.
It requires outbound HTTPS access and a responsive Zotero API, so it runs only
on a weekly schedule or by manual workflow dispatch. It is intentionally not a
required pull-request check; run it manually as a release prerequisite until
publishing is automated.

### Public test fixture

The live suite is designed for a public, closed-membership Zotero group named
`zotero-mcp-e2e`. Anyone must be able to read its library, while only
administrators may edit the library and files. It must contain one uniquely
titled and tagged bibliographic item with exactly one stored PDF child. The
copyright-free PDF must contain distinctive markers and enough indexed text to
exercise chunking.

[`test/e2e/public-library-fixture.json`](test/e2e/public-library-fixture.json)
is the fixture contract. It records the expected item title, item type, tag,
attachment filename, search marker, first-chunk marker, and continuation
marker. Until the external group is provisioned and verified, its `groupId`
remains `null`, which makes the live runner stop with provisioning instructions
instead of contacting an arbitrary library.

Upload
[`test/e2e/zotero-mcp-public-e2e-fixture.pdf`](test/e2e/zotero-mcp-public-e2e-fixture.pdf)
as the report item's sole stored child. Its adjacent `.txt` source is original
project text. The PDF's extracted opening, search, and continuation markers
begin at character offsets 0, 26, and 440, respectively, and its extracted text
is longer than the two 256-character chunks exercised by the test.

Tests discover Zotero-assigned parent and attachment keys at runtime instead of
treating those keys as stable. The fixture and test contain no API key or
private-library data, and the test makes no Zotero write requests.

Because this is an external-service test, a failure can indicate a Zotero
outage, indexing delay, rate limit, or accidental fixture change as well as a
package regression. Confirm the group's public item, child, and full-text API
responses when maintaining the fixture.

## Acknowledgement

This project was inspired by
[`yilewang/llm-for-zotero`](https://github.com/yilewang/llm-for-zotero).

## License

[MIT](LICENSE)
