function createMacQaConfig(base, output, stagedResourcesBin) {
  const extraResources = base.extraResources
    .filter((resource) => resource !== ".env")
    .map((resource) => {
      if (typeof resource !== "object" || resource.from !== "resources/bin/") return resource;
      return {
        ...resource,
        from: stagedResourcesBin || resource.from,
        filter: [
          ...resource.filter.filter((pattern) => pattern !== "MediaRemoteAdapter.framework/**"),
          "!**/MediaRemoteAdapter.framework/**",
        ],
      };
    });

  return {
    ...base,
    appId: "com.gizmolabs.openwhispr.codexqa",
    directories: { ...base.directories, output },
    extraResources,
    afterPack: "scripts/afterPack-macos-qa.js",
    mac: {
      ...base.mac,
      target: ["dir"],
      identity: null,
      notarize: false,
    },
  };
}

module.exports = { createMacQaConfig };
