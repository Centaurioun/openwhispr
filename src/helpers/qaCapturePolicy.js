const fs = require("fs");
const path = require("path");

const REQUESTED_ENV = "OPENWHISPR_QA_DENY_CAPTURE";
const ACTIVE_ENV = "OPENWHISPR_QA_CAPTURE_DENIED_ACTIVE";
const DENIED_ERROR_CODE = "QA_CAPTURE_DENIED";
const QA_CHANNEL = "codexqa";
const QA_BUNDLE_ID = "com.gizmolabs.openwhispr.codexqa";

function currentEnv() {
  return typeof process !== "undefined" && process.env ? process.env : {};
}

function readMacBundleId(
  executablePath,
  platform = typeof process !== "undefined" ? process.platform : ""
) {
  if (platform !== "darwin" || typeof executablePath !== "string" || !executablePath) return "";
  const plistPath = path.resolve(path.dirname(executablePath), "../Info.plist");
  let plist;
  try {
    plist = fs.readFileSync(plistPath, "utf8");
  } catch {
    return "";
  }
  return plist.match(/<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/)?.[1] || "";
}

/** A test-only mode; packaged and non-development apps cannot enable it. */
function isQaCaptureDenialRequested(
  env = currentEnv(),
  isPackaged = false,
  appChannel = "development",
  bundleId = ""
) {
  if (env[REQUESTED_ENV] !== "1") return false;
  const isDevelopmentApp = !isPackaged && appChannel === "development";
  const isQaPackage = isPackaged && appChannel === QA_CHANNEL && bundleId === QA_BUNDLE_ID;
  if (!isDevelopmentApp && !isQaPackage) {
    throw new Error("Capture-denied QA mode requires development or the isolated Codex QA app.");
  }
  return true;
}

function activateQaCaptureDenial(
  env = currentEnv(),
  isPackaged = false,
  appChannel = "development",
  bundleId = ""
) {
  if (!isQaCaptureDenialRequested(env, isPackaged, appChannel, bundleId)) return false;
  env[ACTIVE_ENV] = "1";
  return true;
}

function isQaCaptureDenialActive(env = currentEnv()) {
  return env[ACTIVE_ENV] === "1" || env[REQUESTED_ENV] === "1";
}

function assertCaptureAllowed(env = currentEnv()) {
  if (!isQaCaptureDenialActive(env)) return;
  const error = new Error("Audio and display capture are disabled in the isolated QA session.");
  error.code = DENIED_ERROR_CODE;
  throw error;
}

function qaCaptureDeniedResult(env = currentEnv()) {
  return isQaCaptureDenialActive(env) ? { success: false, code: DENIED_ERROR_CODE } : null;
}

function installQaCaptureDenialHandlers(targetSession) {
  if (
    !targetSession ||
    typeof targetSession.setPermissionRequestHandler !== "function" ||
    typeof targetSession.setPermissionCheckHandler !== "function" ||
    typeof targetSession.setDisplayMediaRequestHandler !== "function"
  ) {
    throw new Error("Electron capture denial handlers are unavailable; refusing to start QA app.");
  }

  targetSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false)
  );
  targetSession.setPermissionCheckHandler(() => false);
  targetSession.setDisplayMediaRequestHandler((_request, callback) => callback({}));
}

function configureQaCaptureDenial({
  env = process.env,
  isPackaged = false,
  appChannel = "development",
  bundleId = "",
  targetSession,
} = {}) {
  if (!isQaCaptureDenialRequested(env, isPackaged, appChannel, bundleId)) return false;
  installQaCaptureDenialHandlers(targetSession);
  env[ACTIVE_ENV] = "1";
  return true;
}

module.exports = {
  ACTIVE_ENV,
  DENIED_ERROR_CODE,
  QA_BUNDLE_ID,
  QA_CHANNEL,
  activateQaCaptureDenial,
  assertCaptureAllowed,
  configureQaCaptureDenial,
  installQaCaptureDenialHandlers,
  isQaCaptureDenialActive,
  isQaCaptureDenialRequested,
  qaCaptureDeniedResult,
  readMacBundleId,
};
