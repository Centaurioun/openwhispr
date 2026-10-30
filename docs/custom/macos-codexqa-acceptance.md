# OpenWhispr macOS Codex QA acceptance

Use this guide with the isolated `dist-codexqa/mac-arm64/OpenWhispr.app` bundle. It writes only to a fresh temporary profile and denies outbound internet access. Do not grant microphone or system-audio access, change TCC settings, or enter real notes or credentials.

```sh
APP="$(pwd)/dist-codexqa/mac-arm64/OpenWhispr.app"
QA_DATA="$(mktemp -d "${TMPDIR:-/tmp}/OpenWhispr QA Data.XXXXXX")"
chmod 700 "$QA_DATA"
OPENWHISPR_CHANNEL=codexqa \
OPENWHISPR_QA_DENY_CAPTURE=1 \
OPENWHISPR_QA_USER_DATA_DIR="$QA_DATA" \
sandbox-exec -p '(version 1) (allow default) (deny network-outbound (remote ip "*:*")) (allow network-outbound (remote ip "localhost:*")) (deny network-bind (local ip "*:*")) (allow network-bind (local ip "localhost:*"))' \
  "$APP/Contents/MacOS/OpenWhispr"
```

Create a note by typing a synthetic transcript such as “Speaker 1: The sample starts now. Speaker 2: The sample ends now.” Do not record audio. Then check:

- The note opens in Transcript Studio and Original/Approved are visibly distinct.
- Rename and reassign speakers; edit text; split and merge a sentence; use Undo/Redo; restore an earlier revision; restart the app and check history persists.
- Export each transcript version and confirm the selected version is used.
- The AI edit action is visible. Use only a mock/offline proposal if available; reject unsafe proposals and confirm nothing applies automatically.
- Integrations shows **Local MCP — Free** and **Hosted MCP — Pro**. Copy the Local MCP setup command and confirm it names this bundle’s `Contents/Resources/local-mcp/dist/server.js` path.
- Keyboard focus works through the editor and dialogs. Evaluate the same controls with VoiceOver if available.

The Local MCP tools require the desktop bridge. If the desktop UI cannot start, stop here and use the synthetic stdio smoke test results; do not remove Electron sandboxing or use `--no-sandbox`. Quit the QA app when finished. The data is confined to `$QA_DATA` and can be removed after confirming its path.
