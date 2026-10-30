const fs = require("node:fs");
const path = require("node:path");
const afterPack = require("./afterPack").default;

module.exports = async function afterPackMacQa(context) {
  if (context.electronPlatformName === "darwin") {
    const appPath = context.appOutDir.endsWith(".app")
      ? context.appOutDir
      : path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
    const resourcesDir = path.join(appPath, "Contents", "Resources");
    const source = path.resolve(__dirname, "../resources/bin/MediaRemoteAdapter.framework");
    const destination = path.join(resourcesDir, "bin", "MediaRemoteAdapter.framework");
    if (!fs.existsSync(source)) throw new Error("MediaRemoteAdapter framework is missing from QA inputs.");
    const requiredFrameworkFiles = [
      path.join(destination, "MediaRemoteAdapter"),
      path.join(destination, "Versions/A/Resources/Info.plist"),
    ];
    if (!requiredFrameworkFiles.every((file) => fs.existsSync(file))) {
      if (fs.existsSync(destination)) fs.rmSync(destination, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.cpSync(source, destination, { recursive: true, verbatimSymlinks: true });
    }
  }

  await afterPack(context);
};
