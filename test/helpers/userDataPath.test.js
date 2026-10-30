const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const builderConfig = require("../../electron-builder.json");
const { configureUserDataPath } = require("../../src/helpers/userDataPath");

test("packaged files include transcript studio runtime required by database helper", () => {
  assert.ok(
    builderConfig.files.includes(
      "src/custom-features/transcript-studio/domain/transcriptStudioRuntime.cjs"
    ),
    "electron-builder must package the runtime required by src/helpers/database.js"
  );
});

function fakeApp(appData = path.join(path.sep, "system", "app-data")) {
  const calls = [];
  return {
    calls,
    getPath(name) {
      assert.equal(name, "appData");
      return appData;
    },
    setPath(name, value) {
      calls.push([name, value]);
    },
  };
}

test("QA override selects an absolute userData directory before dotenv lookup", () => {
  const app = fakeApp();
  const qaPath = path.join(path.sep, "tmp", "openwhispr-qa-profile");

  configureUserDataPath({
    app,
    channel: "production",
    env: { OPENWHISPR_QA_USER_DATA_DIR: qaPath },
  });

  assert.deepEqual(app.calls, [["userData", qaPath]]);
});

test("invalid QA overrides fail closed without changing userData", () => {
  for (const value of ["", "relative/profile"]) {
    const app = fakeApp();
    assert.throws(
      () =>
        configureUserDataPath({
          app,
          channel: "production",
          env: { OPENWHISPR_QA_USER_DATA_DIR: value },
        }),
      /OPENWHISPR_QA_USER_DATA_DIR must be a non-empty absolute path/
    );
    assert.deepEqual(app.calls, []);
  }
});

test("absent override preserves production default and non-production channel isolation", () => {
  const productionApp = fakeApp();
  configureUserDataPath({ app: productionApp, channel: "production", env: {} });
  assert.deepEqual(productionApp.calls, []);

  const stagingApp = fakeApp();
  configureUserDataPath({ app: stagingApp, channel: "staging", env: {} });
  assert.deepEqual(stagingApp.calls, [
    ["userData", path.join(path.sep, "system", "app-data", "OpenWhispr-staging")],
  ]);
});
