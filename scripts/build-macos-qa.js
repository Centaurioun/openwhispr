const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { Arch, Platform, build } = require("electron-builder");
const { createMacQaConfig } = require("./lib/qaElectronBuilderConfig");

const root = path.resolve(__dirname, "..");
const output = path.join(root, "dist-codexqa");
if (fs.existsSync(output)) {
  throw new Error(`Refusing to overwrite existing QA output: ${output}`);
}
if (Number(process.versions.node.split(".")[0]) < 24) {
  throw new Error(`The macOS QA build requires Node.js 24 or newer; found ${process.version}.`);
}

const base = require(path.join(root, "electron-builder.json"));
const config = createMacQaConfig(base, output);
const toolchainShimDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-xcode-toolchain-"));
const resourceStageDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-macos-resources-"));
const xcrunShim = path.join(toolchainShimDir, "xcrun");
const swiftcShim = path.join(toolchainShimDir, "swiftc");
const ccShim = path.join(toolchainShimDir, "cc");
const clangShim = path.join(toolchainShimDir, "clang");
const clangxxShim = path.join(toolchainShimDir, "clang++");
fs.writeFileSync(xcrunShim, '#!/bin/sh\nexec /usr/bin/xcrun --toolchain XcodeDefault "$@"\n', {
  mode: 0o755,
});
fs.writeFileSync(
  swiftcShim,
  '#!/bin/sh\nexec /usr/bin/xcrun --toolchain XcodeDefault swiftc "$@"\n',
  { mode: 0o755 }
);
fs.writeFileSync(ccShim, '#!/bin/sh\nexec /usr/bin/xcrun --toolchain XcodeDefault clang "$@"\n', {
  mode: 0o755,
});
fs.writeFileSync(clangShim, '#!/bin/sh\nexec /usr/bin/xcrun --toolchain XcodeDefault clang "$@"\n', {
  mode: 0o755,
});
fs.writeFileSync(
  clangxxShim,
  '#!/bin/sh\nexec /usr/bin/xcrun --toolchain XcodeDefault clang++ "$@"\n',
  { mode: 0o755 }
);
const env = {
  ...process.env,
  CSC_IDENTITY_AUTO_DISCOVERY: "false",
  TOOLCHAINS: "XcodeDefault",
  PATH: `${toolchainShimDir}${path.delimiter}${process.env.PATH || ""}`,
  CC: clangShim,
  CXX: clangxxShim,
};

function runNpmScript(name) {
  const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", name], {
    cwd: root,
    env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm run ${name} failed with exit code ${result.status}.`);
}

function stageResourceTree(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name === "MediaRemoteAdapter.framework") continue;
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(sourcePath), destinationPath);
    } else if (entry.isDirectory()) {
      stageResourceTree(sourcePath, destinationPath);
    } else if (entry.isFile()) {
      try {
        fs.linkSync(sourcePath, destinationPath);
      } catch (error) {
        if (error.code !== "EXDEV") throw error;
        fs.copyFileSync(sourcePath, destinationPath);
      }
    }
  }
}

async function main() {
  try {
    runNpmScript("prebuild:mac");
    runNpmScript("build:renderer");
    const stagedResourcesBin = path.join(resourceStageDir, "bin");
    stageResourceTree(path.join(root, "resources/bin"), stagedResourcesBin);
    config.extraResources = config.extraResources.map((resource) =>
      typeof resource === "object" && resource.from === "resources/bin/"
        ? { ...resource, from: stagedResourcesBin }
        : resource
    );
    await build({
      targets: Platform.MAC.createTarget(["dir"], Arch.arm64),
      config,
    });
  } finally {
    fs.rmSync(toolchainShimDir, { recursive: true, force: true });
    fs.rmSync(resourceStageDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
