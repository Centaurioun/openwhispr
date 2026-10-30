const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

const policyPath = require.resolve("../../src/helpers/qaCapturePolicy");

test("QA capture denial is opt-in and only accepted for an unpackaged development app", () => {
  const { isQaCaptureDenialRequested, QA_BUNDLE_ID, QA_CHANNEL } = require(policyPath);

  assert.equal(isQaCaptureDenialRequested({}), false);
  assert.equal(
    isQaCaptureDenialRequested({ OPENWHISPR_QA_DENY_CAPTURE: "1" }, false, "development"),
    true
  );
  assert.throws(
    () => isQaCaptureDenialRequested({ OPENWHISPR_QA_DENY_CAPTURE: "1" }, true, "development"),
    /development or the isolated Codex QA app/i
  );
  assert.throws(
    () => isQaCaptureDenialRequested({ OPENWHISPR_QA_DENY_CAPTURE: "1" }, false, "production"),
    /development or the isolated Codex QA app/i
  );
  assert.throws(
    () =>
      isQaCaptureDenialRequested(
        { OPENWHISPR_QA_DENY_CAPTURE: "1" },
        true,
        "production",
        QA_BUNDLE_ID
      ),
    /isolated Codex QA app/i
  );
  assert.throws(
    () =>
      isQaCaptureDenialRequested(
        { OPENWHISPR_QA_DENY_CAPTURE: "1" },
        true,
        QA_CHANNEL,
        "com.gizmolabs.openwhispr"
      ),
    /isolated Codex QA app/i
  );
  assert.equal(
    isQaCaptureDenialRequested({ OPENWHISPR_QA_DENY_CAPTURE: "1" }, true, QA_CHANNEL, QA_BUNDLE_ID),
    true
  );
  assert.equal(isQaCaptureDenialRequested({}, true, QA_CHANNEL, QA_BUNDLE_ID), false);
});

test("packaged QA identity is read only from its macOS app bundle Info.plist", () => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const { readMacBundleId, QA_BUNDLE_ID } = require(policyPath);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-qa-bundle-"));
  const executable = path.join(root, "OpenWhispr.app", "Contents", "MacOS", "OpenWhispr");
  const contents = path.dirname(executable);
  fs.mkdirSync(contents, { recursive: true });
  fs.writeFileSync(
    path.join(path.dirname(contents), "Info.plist"),
    `<plist><dict><key>CFBundleIdentifier</key><string>${QA_BUNDLE_ID}</string></dict></plist>`
  );
  try {
    assert.equal(readMacBundleId(executable, "darwin"), QA_BUNDLE_ID);
    assert.equal(readMacBundleId(executable, "linux"), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("capture-denied QA installs request, check, and display-capture denials", () => {
  const { installQaCaptureDenialHandlers } = require(policyPath);
  const handlers = {};
  const session = {
    setPermissionRequestHandler(handler) {
      handlers.request = handler;
    },
    setPermissionCheckHandler(handler) {
      handlers.check = handler;
    },
    setDisplayMediaRequestHandler(handler) {
      handlers.display = handler;
    },
  };

  installQaCaptureDenialHandlers(session);

  let mediaGranted;
  handlers.request({}, "media", (granted) => (mediaGranted = granted));
  let cameraGranted;
  handlers.request({}, "camera", (granted) => (cameraGranted = granted));
  let displayGranted;
  handlers.display({}, (sources) => (displayGranted = sources));
  assert.equal(mediaGranted, false);
  assert.equal(cameraGranted, false);
  assert.equal(handlers.check({}, "media"), false);
  assert.equal(handlers.check({}, "display-capture"), false);
  assert.deepEqual(displayGranted, {});
});

test("packaged Codex QA activates capture denial only for its exact app identity", () => {
  const { configureQaCaptureDenial, QA_BUNDLE_ID, QA_CHANNEL } = require(policyPath);
  const env = { OPENWHISPR_QA_DENY_CAPTURE: "1" };
  const installed = [];
  const targetSession = {
    setPermissionRequestHandler(handler) {
      installed.push(["request", handler]);
    },
    setPermissionCheckHandler(handler) {
      installed.push(["check", handler]);
    },
    setDisplayMediaRequestHandler(handler) {
      installed.push(["display", handler]);
    },
  };

  assert.throws(
    () =>
      configureQaCaptureDenial({
        env: { ...env },
        isPackaged: true,
        appChannel: QA_CHANNEL,
        bundleId: "com.gizmolabs.openwhispr",
        targetSession,
      }),
    /isolated Codex QA app/i
  );
  assert.equal(installed.length, 0);
  assert.equal(
    configureQaCaptureDenial({
      env,
      isPackaged: true,
      appChannel: QA_CHANNEL,
      bundleId: QA_BUNDLE_ID,
      targetSession,
    }),
    true
  );
  assert.equal(installed.length, 3);
});

test("capture-denied QA fails closed if either Electron permission path is unavailable", () => {
  const { installQaCaptureDenialHandlers } = require(policyPath);

  assert.throws(
    () => installQaCaptureDenialHandlers({ setPermissionRequestHandler() {} }),
    /capture denial handlers are unavailable/i
  );
});

test("capture-denied QA activates only after every Electron handler is installed", () => {
  const { configureQaCaptureDenial, isQaCaptureDenialActive } = require(policyPath);
  const env = { OPENWHISPR_QA_DENY_CAPTURE: "1" };
  const handlers = {};
  const session = {
    setPermissionRequestHandler(handler) {
      handlers.request = handler;
    },
    setPermissionCheckHandler(handler) {
      handlers.check = handler;
    },
    setDisplayMediaRequestHandler(handler) {
      handlers.display = handler;
    },
  };

  assert.equal(
    configureQaCaptureDenial({
      env,
      isPackaged: false,
      appChannel: "development",
      targetSession: session,
    }),
    true
  );
  assert.equal(isQaCaptureDenialActive(env), true);
  assert.equal(typeof handlers.request, "function");
  assert.equal(typeof handlers.check, "function");
  assert.equal(typeof handlers.display, "function");
});

test("capture API guards are inert by default and reject capture in the explicit QA session", () => {
  const { assertCaptureAllowed, isQaCaptureDenialActive, qaCaptureDeniedResult } = require(
    policyPath
  );

  assert.equal(isQaCaptureDenialActive({}), false);
  assert.equal(qaCaptureDeniedResult({}), null);
  assert.doesNotThrow(() => assertCaptureAllowed({}));
  assert.deepEqual(qaCaptureDeniedResult({ OPENWHISPR_QA_DENY_CAPTURE: "1" }), {
    success: false,
    code: "QA_CAPTURE_DENIED",
  });
  assert.throws(
    () => assertCaptureAllowed({ OPENWHISPR_QA_DENY_CAPTURE: "1" }),
    (error) => error.code === "QA_CAPTURE_DENIED"
  );
});

test(
  "AudioActivityDetector does not spawn a native listener in capture-denied QA",
  { skip: process.platform !== "darwin" },
  async () => {
    const detectorPath = require.resolve("../../src/helpers/audioActivityDetector");
    const originalLoad = Module._load;
    const originalActive = process.env.OPENWHISPR_QA_CAPTURE_DENIED_ACTIVE;
    let spawnCalls = 0;

    process.env.OPENWHISPR_QA_CAPTURE_DENIED_ACTIVE = "1";
    delete require.cache[detectorPath];
    Module._load = function loadWithSafeMocks(request, parent, isMain) {
      if (request === "child_process") {
        return {
          exec() {},
          spawn() {
            spawnCalls += 1;
            const child = new EventEmitter();
            child.stdout = new PassThrough();
            child.stderr = new PassThrough();
            child.kill = () => {};
            setImmediate(() => child.emit("spawn"));
            return child;
          },
        };
      }
      if (request === "./binaryResolver")
        return { resolveBundledBinary: () => "/synthetic/listener" };
      if (request === "./ownProcessPids") return { getOwnProcessPids: () => [] };
      if (request === "./debugLogger") return { info() {}, warn() {}, debug() {}, error() {} };
      return originalLoad.call(this, request, parent, isMain);
    };

    try {
      const AudioActivityDetector = require(detectorPath);
      const detector = new AudioActivityDetector();
      const started = await detector.start();
      detector.stop();

      assert.equal(started, false);
      assert.equal(spawnCalls, 0);
    } finally {
      Module._load = originalLoad;
      delete require.cache[detectorPath];
      if (originalActive === undefined) delete process.env.OPENWHISPR_QA_CAPTURE_DENIED_ACTIVE;
      else process.env.OPENWHISPR_QA_CAPTURE_DENIED_ACTIVE = originalActive;
    }
  }
);
