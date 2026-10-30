const REQUESTED_ENV = "OPENWHISPR_QA_DENY_CAPTURE";
const ACTIVE_ENV = "OPENWHISPR_QA_CAPTURE_DENIED_ACTIVE";
const DENIED_ERROR_CODE = "QA_CAPTURE_DENIED";

export function assertCaptureAllowed(env = process.env) {
  if (env[ACTIVE_ENV] !== "1" && env[REQUESTED_ENV] !== "1") return;
  const error = new Error("Audio and display capture are disabled in the isolated QA session.");
  error.code = DENIED_ERROR_CODE;
  throw error;
}
