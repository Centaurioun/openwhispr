const fs = require("node:fs");
const path = require("node:path");

const REQUIRED_RUNTIME_FILES = [
  "dist/server.js",
  "package.json",
  "node_modules/@modelcontextprotocol/sdk/package.json",
  "node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js",
  "node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js",
  "node_modules/zod/package.json",
  "node_modules/zod/index.js",
];

function ensureLocalMcpRuntime({ projectDir, resourcesDir }) {
  const packagedRoot = path.join(resourcesDir, "local-mcp");
  const sourceRoot = path.join(projectDir, "tools", "local-mcp");
  const sourceDependencies = path.join(sourceRoot, "node_modules");
  const missingSource = REQUIRED_RUNTIME_FILES.filter((relativePath) =>
    !fs.existsSync(path.join(sourceRoot, relativePath))
  );
  if (missingSource.length) {
    throw new Error(
      `afterPack: Local MCP build inputs are incomplete: ${missingSource.join(", ")}. Rebuild the standalone package and retry.`
    );
  }

  const destinationDependencies = path.join(packagedRoot, "node_modules");
  if (fs.existsSync(destinationDependencies)) {
    fs.rmSync(destinationDependencies, { recursive: true, force: true });
  }
  fs.mkdirSync(packagedRoot, { recursive: true });
  fs.cpSync(sourceDependencies, destinationDependencies, {
    recursive: true,
    verbatimSymlinks: true,
  });

  const stillMissing = REQUIRED_RUNTIME_FILES.filter((relativePath) =>
    !fs.existsSync(path.join(packagedRoot, relativePath))
  );
  if (stillMissing.length) {
    throw new Error(
      `afterPack: Local MCP runtime is incomplete: ${stillMissing.join(", ")}. Rebuild the standalone package and retry.`
    );
  }
}

module.exports = { ensureLocalMcpRuntime };
