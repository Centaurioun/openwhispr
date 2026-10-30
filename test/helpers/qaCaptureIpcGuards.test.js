const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const handlersPath = require.resolve("../../src/helpers/ipcHandlers");
const originalLoad = Module._load;
const handlers = new Map();
const listeners = new Map();
const calls = {
  providerWarmup: 0,
  providerStart: 0,
  preview: 0,
  microphonePermission: 0,
  systemPermission: 0,
  screenPermission: 0,
  meetingAudioPolicy: 0,
};

const electronStub = {
  app: {
    getPath: () => "/tmp",
    getName: () => "test",
    getVersion: () => "0.0.0",
    isPackaged: false,
    on() {},
    requestSingleInstanceLock: () => true,
  },
  ipcMain: {
    handle: (channel, handler) => handlers.set(channel, handler),
    on: (channel, handler) => listeners.set(channel, handler),
    removeHandler() {},
  },
  net: { fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) },
  BrowserWindow: class {
    static getAllWindows() {
      return [];
    }
    static fromWebContents() {
      return null;
    }
  },
  shell: {},
  dialog: {},
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 0, height: 0 } }) },
  systemPreferences: {
    getMediaAccessStatus: () => "not-determined",
    askForMediaAccess: async () => {
      calls.microphonePermission++;
      return true;
    },
  },
  session: { fromPartition: () => ({}) },
  clipboard: {},
  nativeImage: {},
  globalShortcut: {},
  utilityProcess: {},
  MessageChannelMain: class {},
};

Module._load = function loadWithElectronStub(request, parent, isMain) {
  if (request === "electron") return electronStub;
  if (parent?.filename === handlersPath) {
    if (request === "./debugLogger") return new Proxy({}, { get: () => () => {} });
    if (request === "./openaiRealtimeStreaming") {
      return class FakeRealtimeStreaming {
        constructor() {
          this.isConnected = false;
        }
        beginConnecting() {}
        async connect() {
          calls.providerStart++;
          this.isConnected = true;
        }
        async disconnect() {
          this.isConnected = false;
          return { text: "" };
        }
      };
    }
    if (request === "./realtimeTokenProviders") {
      return {
        ...originalLoad.call(this, request, parent, isMain),
        fetchRealtimeTokenForProvider: async () => {
          calls.providerWarmup++;
          return "synthetic-token";
        },
      };
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};

test.after(() => {
  Module._load = originalLoad;
});

function anything() {
  return new Proxy(function () {}, {
    get: (_target, property) => {
      if (property === Symbol.toPrimitive || property === "toString") return () => "";
      if (property === "then") return undefined;
      return anything();
    },
    apply: () => anything(),
  });
}

function registerHandlers() {
  handlers.clear();
  listeners.clear();
  for (const key of Object.keys(calls)) calls[key] = 0;
  const IPCHandlers = require(handlersPath);
  const target = {
    _dictationStreaming: null,
    _dictationConnectPromise: null,
    _dictationIdleTimer: null,
    _dictationPreviewEnabled: false,
    windowManager: {
      hideTranscriptionPreview() {},
      showTranscriptionPreview() {
        calls.preview++;
      },
      getAgentDictationPillState: () => ({ interactive: true }),
    },
    screenContextCapture: {
      getAccessResult: () => ({ status: "not-determined" }),
      async requestAccess() {
        calls.screenPermission++;
        return "granted";
      },
    },
    audioTapManager: {
      isSupported: () => true,
      async requestAccess() {
        calls.systemPermission++;
        return { granted: true };
      },
    },
    parakeetManager: {
      supportsOnlineStreaming: () => true,
      async createOnlineStream() {
        calls.preview++;
        return { sendPcm16() {}, abort() {} };
      },
    },
    _audioFeaturePolicy: {
      run(_event, _purpose, callback) {
        calls.meetingAudioPolicy++;
        return callback();
      },
    },
  };
  IPCHandlers.prototype.setupHandlers.call(
    new Proxy(target, {
      get: (value, property) => (property in value ? value[property] : anything()),
    })
  );
}

test("QA capture denial blocks dictation and permission IPC before provider or native work", async () => {
  const previous = process.env.OPENWHISPR_QA_CAPTURE_DENIED_ACTIVE;
  process.env.OPENWHISPR_QA_CAPTURE_DENIED_ACTIVE = "1";
  try {
    registerHandlers();
    const expected = { success: false, code: "QA_CAPTURE_DENIED" };
    const invoke = (channel, ...args) => handlers.get(channel)({}, ...args);

    const byok = {
      provider: "openai-realtime",
      mode: "byok",
      model: "gpt-4o-mini-transcribe",
      language: "en",
    };
    assert.deepEqual(await invoke("dictation-realtime-warmup", byok), expected);
    assert.deepEqual(await invoke("dictation-realtime-start", byok), expected);
    assert.deepEqual(
      await invoke("start-dictation-preview", {
        provider: "nvidia",
        model: "synthetic-model",
      }),
      expected
    );
    assert.deepEqual(await invoke("request-microphone-access"), {
      granted: false,
      status: "denied",
      code: "QA_CAPTURE_DENIED",
    });
    assert.deepEqual(await invoke("request-system-audio-access"), {
      success: false,
      status: "denied",
      code: "QA_CAPTURE_DENIED",
    });
    assert.deepEqual(await invoke("permission-guide-verify-system-audio"), {
      success: false,
      status: "denied",
      code: "QA_CAPTURE_DENIED",
    });
    assert.deepEqual(await invoke("request-screen-recording-access"), {
      success: false,
      status: "denied",
      code: "QA_CAPTURE_DENIED",
    });
    assert.deepEqual(await invoke("toggle-agent-panel-dictation"), expected);
    assert.deepEqual(
      await invoke("meeting-transcription-start", { sessionId: "synthetic-session" }),
      expected
    );
    assert.equal(
      listeners.get("meeting-transcription-send")({}, Symbol("invalid-audio")),
      undefined
    );

    assert.deepEqual(calls, {
      providerWarmup: 0,
      providerStart: 0,
      preview: 0,
      microphonePermission: 0,
      systemPermission: 0,
      screenPermission: 0,
      meetingAudioPolicy: 0,
    });
  } finally {
    if (previous === undefined) delete process.env.OPENWHISPR_QA_CAPTURE_DENIED_ACTIVE;
    else process.env.OPENWHISPR_QA_CAPTURE_DENIED_ACTIVE = previous;
  }
});
