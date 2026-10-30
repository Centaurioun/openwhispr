const path = require("node:path");

function configureUserDataPath({ app, channel, env = process.env }) {
  const qaOverride = env.OPENWHISPR_QA_USER_DATA_DIR;
  if (qaOverride !== undefined) {
    if (typeof qaOverride !== "string" || !qaOverride.trim() || !path.isAbsolute(qaOverride)) {
      throw new Error("OPENWHISPR_QA_USER_DATA_DIR must be a non-empty absolute path");
    }
    app.setPath("userData", qaOverride);
    return;
  }

  if (channel === "production") return;

  const isolatedPath = path.join(app.getPath("appData"), `OpenWhispr-${channel}`);
  app.setPath("userData", isolatedPath);
}

module.exports = { configureUserDataPath };
