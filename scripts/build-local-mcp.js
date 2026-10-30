const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const packageDir = path.join(root, "tools", "local-mcp");
const npmCli = process.env.npm_execpath;
const npm = npmCli ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";

function run(args) {
  const result = spawnSync(npm, npmCli ? [npmCli, ...args] : args, {
    cwd: root,
    stdio: "inherit",
    env: process.env,
    shell: !npmCli && process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(["ci", "--prefix", packageDir]);
run(["run", "build", "--prefix", packageDir]);
run(["prune", "--prefix", packageDir, "--omit=dev"]);

const required = [
  path.join(packageDir, "dist", "server.js"),
  path.join(packageDir, "node_modules", "@modelcontextprotocol", "sdk", "package.json"),
  path.join(packageDir, "node_modules", "zod", "package.json"),
];
const missing = required.filter((file) => !fs.existsSync(file));
if (missing.length) {
  throw new Error(`Local MCP distribution is incomplete: ${missing.map((file) => path.relative(root, file)).join(", ")}`);
}

console.log("Local MCP compiled entry point and production dependencies are ready for packaging.");
