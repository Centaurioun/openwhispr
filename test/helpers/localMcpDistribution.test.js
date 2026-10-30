const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const builderConfig = require("../../electron-builder.json");
const { createMacQaConfig } = require("../../scripts/lib/qaElectronBuilderConfig");
const { ensureLocalMcpRuntime } = require("../../scripts/lib/ensureLocalMcpRuntime");
const {
  createCodexAddCommand,
  getLocalMcpServerPath,
} = require("../../src/helpers/localMcpDistribution");

test("Codex setup command quotes a packaged server path with spaces and shell metacharacters", () => {
  const command = createCodexAddCommand(
    "/Applications/Open Whispr (QA)/Contents/Resources/local-mcp/dist/server.js"
  );

  assert.equal(
    command,
    "codex mcp add openwhispr-local -- node '/Applications/Open Whispr (QA)/Contents/Resources/local-mcp/dist/server.js'"
  );
});

test("Codex setup command safely quotes apostrophes in a valid absolute path", () => {
  const command = createCodexAddCommand("/Applications/Yusuf's App/Contents/Resources/server.js");

  assert.equal(
    command,
    "codex mcp add openwhispr-local -- node '/Applications/Yusuf'\"'\"'s App/Contents/Resources/server.js'"
  );
});

test("Codex setup command retains a quoted Windows resource path", () => {
  assert.equal(
    createCodexAddCommand("C:\\Program Files\\OpenWhispr\\resources\\local-mcp\\server.js", "win32"),
    'codex mcp add openwhispr-local -- node "C:\\Program Files\\OpenWhispr\\resources\\local-mcp\\server.js"'
  );
});

test("Codex setup command rejects relative server paths", () => {
  assert.throws(() => createCodexAddCommand("tools/local-mcp/dist/server.js"), /absolute/);
});

test("packaged Local MCP resolves from Electron resources rather than the source tree", () => {
  assert.equal(
    getLocalMcpServerPath({
      isPackaged: true,
      resourcesPath: "/Applications/OpenWhispr.app/Contents/Resources",
      appPath: "/source/tree",
    }),
    "/Applications/OpenWhispr.app/Contents/Resources/local-mcp/dist/server.js"
  );
  assert.ok(
    builderConfig.extraResources.some(
      (resource) => resource.from === "tools/local-mcp" && resource.to === "local-mcp"
    )
  );
});

test("development Local MCP resolves inside the current source checkout", () => {
  assert.equal(
    getLocalMcpServerPath({ isPackaged: false, appPath: "/source tree/OpenWhispr" }),
    "/source tree/OpenWhispr/tools/local-mcp/dist/server.js"
  );
});

test("QA build uses an isolated identity and output without signing, notarization, or .env", () => {
  const qa = createMacQaConfig(builderConfig, "/tmp/openwhispr-codexqa");

  assert.equal(qa.appId, "com.gizmolabs.openwhispr.codexqa");
  assert.equal(qa.directories.output, "/tmp/openwhispr-codexqa");
  assert.equal(qa.mac.identity, null);
  assert.equal(qa.mac.notarize, false);
  assert.deepEqual(qa.mac.target, ["dir"]);
  assert.ok(!qa.extraResources.includes(".env"));
  const binResources = qa.extraResources.find(
    (resource) => typeof resource === "object" && resource.from === "resources/bin/"
  );
  assert.ok(binResources.filter.includes("!**/MediaRemoteAdapter.framework/**"));
  assert.equal(qa.afterPack, "scripts/afterPack-macos-qa.js");
  assert.ok(builderConfig.extraResources.includes(".env"));
});

test("shared afterPack copies and verifies Local MCP production dependencies", (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-local-mcp-afterpack-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const projectDir = path.join(tempRoot, "project");
  const resourcesDir = path.join(tempRoot, "bundle", "Resources");
  const source = path.join(projectDir, "tools", "local-mcp");
  const packaged = path.join(resourcesDir, "local-mcp");
  for (const relativePath of [
    "dist/server.js",
    "package.json",
    "node_modules/@modelcontextprotocol/sdk/package.json",
    "node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js",
    "node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js",
    "node_modules/zod/package.json",
    "node_modules/zod/index.js",
    "node_modules/transitive/runtime.js",
  ]) {
    fs.mkdirSync(path.dirname(path.join(source, relativePath)), { recursive: true });
    fs.writeFileSync(path.join(source, relativePath), "{}\n");
  }
  fs.mkdirSync(packaged, { recursive: true });
  fs.mkdirSync(path.join(packaged, "dist"), { recursive: true });
  fs.copyFileSync(path.join(source, "dist/server.js"), path.join(packaged, "dist/server.js"));
  fs.copyFileSync(path.join(source, "package.json"), path.join(packaged, "package.json"));
  fs.mkdirSync(path.join(packaged, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(packaged, "node_modules/partial-marker"), "partial\n");

  assert.doesNotThrow(() => ensureLocalMcpRuntime({ projectDir, resourcesDir }));
  assert.ok(fs.existsSync(path.join(packaged, "node_modules/@modelcontextprotocol/sdk/package.json")));
  assert.ok(fs.existsSync(path.join(packaged, "node_modules/zod/package.json")));
  assert.ok(fs.existsSync(path.join(packaged, "node_modules/transitive/runtime.js")));
  assert.ok(!fs.existsSync(path.join(packaged, "node_modules/partial-marker")));
});
