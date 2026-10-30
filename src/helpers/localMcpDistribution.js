const path = require("node:path");

function getLocalMcpServerPath({ isPackaged, resourcesPath, appPath }) {
  if (isPackaged) return path.join(resourcesPath, "local-mcp", "dist", "server.js");
  return path.join(appPath, "tools", "local-mcp", "dist", "server.js");
}

function createCodexAddCommand(serverPath, platform = process.platform) {
  const isAbsolute =
    typeof serverPath === "string" &&
    (platform === "win32" ? path.win32.isAbsolute(serverPath) : path.isAbsolute(serverPath));
  if (!isAbsolute) {
    throw new TypeError("Local MCP server path must be absolute");
  }
  const quotedPath =
    platform === "win32"
      ? `"${serverPath.replace(/"/g, '\\"')}"`
      : quotePosixShellArgument(serverPath);
  return `codex mcp add openwhispr-local -- node ${quotedPath}`;
}

function quotePosixShellArgument(value) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

module.exports = { createCodexAddCommand, getLocalMcpServerPath };
