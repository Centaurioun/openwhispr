# Local MCP for OpenWhispr

Local MCP lets a compatible MCP client such as Codex read notes and transcripts from the running OpenWhispr desktop app. It is free and does not use OpenWhispr's hosted MCP service, a Pro subscription, a cloud fallback, or an OpenAI API key.

## Requirements

- OpenWhispr desktop app running and signed into the account whose local notes you want to read.
- Node.js 24 or newer.
- OpenWhispr CLI `@openwhispr/cli@0.3.0` available on `PATH` as `openwhispr`.
- Codex CLI with stdio MCP support.

The MCP process invokes the CLI with `--local` for every read. If the desktop bridge is unavailable or the active account cannot read a note, the request fails. The server does not switch to the hosted API.

## Install and register

Run these commands from the OpenWhispr source folder. The first command installs the CLI so its `openwhispr` executable is available to Codex; the next commands install and build the self-contained MCP adapter.

```sh
npm install -g @openwhispr/cli@0.3.0
npm --prefix tools/local-mcp ci
npm --prefix tools/local-mcp run build
codex mcp add openwhispr-local -- node "$PWD/tools/local-mcp/dist/server.js"
```

The final command saves a stdio server entry in the Codex configuration for the current user. It uses the repository path from the current shell. To inspect the saved entry later:

```sh
codex mcp get openwhispr-local
```

That command confirms only that the entry is saved. To verify live access, open a new Codex session and ask it to list or search local notes. Do not label the server connected until the client has completed an MCP handshake and a note read succeeds.

The global CLI install above is an explicit user-run setup step. Tests and isolated smoke runs for this change use a temporary npm prefix and never modify the user's global npm or Codex configuration.

## Available tools

- `list_notes`: returns bounded note summaries from the active local account.
- `search_notes`: searches the active local account and returns bounded summaries.
- `get_note`: reads note text and metadata, excluding the transcript body.
- `get_note_transcript_page`: reads a transcript in pages. Select `original` or `approved` explicitly; each page defaults to 4,000 Unicode code points and cannot exceed 8,000.

The Original transcript is the immutable source. Approved text is resolved by the desktop main process from the current account-scoped workspace. A stale source or invalid edit history causes Approved reads to fail closed; select Original or review the transcript in OpenWhispr. The MCP server has no tools to create, edit, delete, transcribe, or export OpenWhispr data. Transcription-history endpoints are intentionally omitted until their account-scope contract is verified.

## Privacy

Local describes where OpenWhispr reads the data. It does not promise that the content stays on this computer after an MCP client receives it. Codex or another MCP client may send note or transcript text to its own AI provider under that client's settings. Use the client and model appropriate for the material, and do not connect this server if that transfer is not acceptable.

The adapter communicates over stdio and starts no inbound HTTP listener. It uses fixed CLI argument arrays with shell interpretation disabled, rejects remote mode, bounds child-process time and output, and does not log note text, transcripts, bridge tokens, or CLI stderr.

## Troubleshooting

- **Desktop bridge unavailable:** Start OpenWhispr and retry. Confirm the desktop app is signed into the intended local account. The MCP server intentionally does not retry through a cloud service.
- **Approved transcript unavailable:** The source transcript or edit history is stale or invalid. The tool does not return partial Approved text; read Original or resolve the issue in Transcript Studio.
- **Codex shows the server entry but cannot read notes:** `codex mcp get` checks only saved configuration. Restart the Codex session after registration, then perform a note-list or note-search request.
- **CLI executable missing:** Install the documented CLI version and confirm `openwhispr --version` in the environment inherited by Codex.

Hosted MCP remains a separate OpenWhispr service. Its existing Pro entitlement and API-key permissions continue to apply and are not changed by Local MCP.
