const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer } = require("../lib/rendererTestHarness");

const DOM_GLOBALS = [
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "MutationObserver",
  "getComputedStyle",
  "Event",
  "CustomEvent",
  "MouseEvent",
  "FocusEvent",
  "KeyboardEvent",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "ResizeObserver",
];

let happyWindow;
let React;
let vite;
let TranscriptStudioView;
let normalizeTranscriptSource;
let usePolicyStore;

test.before(async (t) => {
  const { Window } = await import("happy-dom");
  happyWindow = new Window();
  const define = (name, value) =>
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  define("window", happyWindow);
  for (const name of DOM_GLOBALS) define(name, happyWindow[name]);
  for (const name of ["requestAnimationFrame", "cancelAnimationFrame"]) {
    define(name, happyWindow[name].bind(happyWindow));
  }
  React = require("react");
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vite = await createRendererServer(t);
  ({ TranscriptStudioView } = await vite.ssrLoadModule(
    "/custom-features/transcript-studio/components/TranscriptStudioView.tsx"
  ));
  ({ normalizeTranscriptSource } = await vite.ssrLoadModule(
    "/custom-features/transcript-studio/domain/normalizeSource.ts"
  ));
  ({ usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts"));
});

test.after(async () => {
  await happyWindow.happyDOM.close();
});

async function mount(t, props, api) {
  const { createRoot } = require("react-dom/client");
  happyWindow.electronAPI = api;
  const host = happyWindow.document.createElement("div");
  happyWindow.document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => {
    await React.act(async () => root.unmount());
    host.remove();
  });
  const render = () => React.createElement(TranscriptStudioView, props);
  await React.act(async () => root.render(render()));
  // Querying before React inserts the asynchronously loaded transcript can leave
  // happy-dom's negative selector cache stale. Wait on the rendered source marker.
  const rendered = await waitFor(() => host.innerHTML.includes("data-transcript-segment"), 500);
  await React.act(async () => {});
  assert.ok(rendered, `Transcript Studio did not render transcript content: ${host.textContent}`);
  return { host, root };
}

async function waitFor(predicate, attempts = 40) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

function apiFor(
  workspace,
  onApply = async () => ({ conflict: true }),
  onRestore = async () => workspace
) {
  return {
    getTranscriptWorkspace: async () => workspace,
    listTranscriptVersions: async () => [
      { versionId: `baseline:${workspace.sourceHash}`, version: 0, description: "Original" },
    ],
    applyTranscriptRevision: onApply,
    restoreTranscriptVersion: onRestore,
  };
}

const inputValue = (element, value) => {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value").set;
  setter.call(element, value);
  element.dispatchEvent(new happyWindow.Event("input", { bubbles: true }));
};

test("a transcript without an overlay shows the original text with no invented timestamp", async (t) => {
  const raw = '[{"text":"Merhaba dünya","speaker":"speaker_0"}]';
  const normalized = await normalizeTranscriptSource(raw);
  const workspace = {
    noteId: 21,
    sourceTranscript: raw,
    originalTranscript: raw,
    sourceHash: normalized.sourceHash,
    baselineSourceHash: normalized.sourceHash,
    currentVersion: 0,
    versionId: null,
    approvedOperations: [],
    stale: false,
  };
  const { host } = await mount(
    t,
    { noteId: 21, sourceTranscript: raw, canEdit: true },
    apiFor(workspace)
  );

  assert.equal(host.querySelectorAll("textarea").length, 1, host.textContent);
  assert.equal(host.querySelector("textarea").value, "Merhaba dünya");
  assert.equal(host.querySelector("time"), null);
});

test("AI editing is idle until its explicit button is clicked and asks before remote processing", async (t) => {
  const raw = '[{"text":"Keep this source unchanged"}]';
  const normalized = await normalizeTranscriptSource(raw);
  const workspace = {
    noteId: 23,
    sourceTranscript: raw,
    originalTranscript: raw,
    sourceHash: normalized.sourceHash,
    baselineSourceHash: normalized.sourceHash,
    currentVersion: 0,
    versionId: null,
    approvedOperations: [],
    stale: false,
  };
  let consentRequests = 0;
  const previousConfirm = happyWindow.confirm;
  happyWindow.confirm = () => {
    consentRequests += 1;
    return false;
  };
  t.after(() => {
    happyWindow.confirm = previousConfirm;
  });
  const { host } = await mount(
    t,
    { noteId: 23, sourceTranscript: raw, canEdit: true },
    apiFor(workspace)
  );
  assert.equal(consentRequests, 0);
  assert.match(host.textContent, /Edit transcript with AI/);
  const button = [...host.querySelectorAll("button")].find((candidate) =>
    candidate.textContent.includes("Edit transcript with AI")
  );
  await React.act(async () =>
    button.dispatchEvent(new happyWindow.MouseEvent("click", { bubbles: true }))
  );
  await waitFor(() => consentRequests === 1);
  await waitFor(() => host.textContent.includes("No transcript text was sent"));
  await React.act(async () => {});
  assert.equal(consentRequests, 1);
  assert.equal(host.querySelector("textarea").value, "Keep this source unchanged");
  assert.equal(host.querySelector("[aria-label='Pending AI transcript proposals']"), null);
});

test("a late proposal from the old account cannot write into the new account draft key", async (t) => {
  const raw = '[{"text":"Account scoped transcript"}]';
  const normalized = await normalizeTranscriptSource(raw);
  const workspace = {
    noteId: 24,
    sourceTranscript: raw,
    originalTranscript: raw,
    sourceHash: normalized.sourceHash,
    baselineSourceHash: normalized.sourceHash,
    currentVersion: 0,
    versionId: null,
    approvedOperations: [],
    stale: false,
  };
  const previousPolicy = usePolicyStore.getState();
  const newAccountKey = `transcript-studio-proposals:acct-new:2:${normalized.sourceHash}`;
  const previousStorage = happyWindow.sessionStorage.getItem(newAccountKey);
  happyWindow.sessionStorage.removeItem(newAccountKey);
  usePolicyStore.setState({ accountId: "acct-old", authGeneration: 1 });
  happyWindow.sessionStorage.setItem(newAccountKey, "[]");

  let releaseOldJob;
  let started = false;
  const pendingEvent = new Promise((resolve) => {
    releaseOldJob = resolve;
  });
  const jobRunner = async function* () {
    started = true;
    yield await pendingEvent;
  };
  try {
    const { host } = await mount(
      t,
      { noteId: 24, sourceTranscript: raw, canEdit: true, jobRunner },
      apiFor(workspace)
    );
    const button = [...host.querySelectorAll("button")].find((candidate) =>
      candidate.textContent.includes("Edit transcript with AI")
    );
    await React.act(async () =>
      button.dispatchEvent(new happyWindow.MouseEvent("click", { bubbles: true }))
    );
    assert.equal(await waitFor(() => started), true, "the injected old-account job should start");

    await React.act(async () => {
      usePolicyStore.setState({ accountId: "acct-new", authGeneration: 2 });
      releaseOldJob({
        type: "chunkProposed",
        chunk: { id: "old-chunk", index: 0, segments: [], inputTokens: 1, outputTokens: 1 },
        candidate: { segments: [] },
        validation: { safe: true, warnings: [], edits: [] },
      });
      await Promise.resolve();
    });
    await waitFor(() => !host.textContent.includes("Cancel AI edit"));
    await React.act(async () => {});
    assert.equal(happyWindow.sessionStorage.getItem(newAccountKey), "[]");
    assert.equal(host.querySelector('[data-proposal-chunk="old-chunk"]'), null);
  } finally {
    usePolicyStore.setState(previousPolicy);
    if (previousStorage !== null) {
      happyWindow.sessionStorage.setItem(newAccountKey, previousStorage);
    } else {
      happyWindow.sessionStorage.removeItem(newAccountKey);
    }
  }
});

test("the approved revision is shown by default and stale overlays fall back to raw", async (t) => {
  const raw = '[{"text":"Original","speaker":"speaker_0","timestamp":3}]';
  const normalized = await normalizeTranscriptSource(raw);
  const workspace = {
    noteId: 22,
    sourceTranscript: raw,
    originalTranscript: raw,
    sourceHash: normalized.sourceHash,
    baselineSourceHash: normalized.sourceHash,
    currentVersion: 1,
    versionId: "v1",
    approvedOperations: [
      {
        kind: "replaceText",
        segmentId: normalized.segments[0].id,
        before: "Original",
        after: "Approved",
      },
    ],
    stale: false,
  };
  const approved = await mount(
    t,
    { noteId: 22, sourceTranscript: raw, canEdit: true },
    apiFor(workspace)
  );
  assert.equal(approved.host.querySelector("textarea").value, "Approved");

  const stale = await mount(
    t,
    { noteId: 22, sourceTranscript: raw, canEdit: true },
    apiFor({ ...workspace, stale: true })
  );
  assert.equal(stale.host.querySelector("textarea").value, "Original");
  assert.match(stale.host.textContent, /source changed|stale/i);
});

test("read-only transcript notes show text but no edit controls", async (t) => {
  const raw = "Read only words";
  const normalized = await normalizeTranscriptSource(raw);
  const workspace = {
    noteId: 23,
    sourceTranscript: raw,
    originalTranscript: raw,
    sourceHash: normalized.sourceHash,
    baselineSourceHash: normalized.sourceHash,
    currentVersion: 0,
    versionId: null,
    approvedOperations: [],
    stale: false,
  };
  const { host } = await mount(
    t,
    { noteId: 23, sourceTranscript: raw, canEdit: false },
    apiFor(workspace)
  );

  assert.equal(host.querySelector("textarea").readOnly, true);
  assert.equal(
    [...host.querySelectorAll("button")].some((button) => !button.disabled),
    false
  );
});

test("a speaker rename persists a setSpeaker operation", async (t) => {
  const raw = '[{"text":"Hi there","speaker":"speaker_0","speakerName":"Ada"}]';
  const normalized = await normalizeTranscriptSource(raw);
  const workspace = {
    noteId: 25,
    sourceTranscript: raw,
    originalTranscript: raw,
    sourceHash: normalized.sourceHash,
    baselineSourceHash: normalized.sourceHash,
    currentVersion: 0,
    versionId: null,
    approvedOperations: [],
    stale: false,
  };
  const saves = [];
  const restores = [];
  const { host } = await mount(
    t,
    { noteId: 25, sourceTranscript: raw, canEdit: true },
    apiFor(
      workspace,
      async (input) => {
        saves.push(input);
        return {
          version: 1,
          workspace: { ...workspace, currentVersion: 1, versionId: "version-1" },
        };
      },
      async (...args) => {
        restores.push(args);
        return { ...workspace, currentVersion: 2, versionId: "version-2" };
      }
    )
  );
  const speakerInput = host.querySelector('input[aria-label^="Speaker name for"]');
  assert.ok(speakerInput);

  await React.act(async () => {
    inputValue(speakerInput, "Dr. Ada");
    speakerInput.focus();
    speakerInput.blur();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  assert.deepEqual(saves[0].operations, [
    {
      kind: "setSpeaker",
      segmentId: normalized.segments[0].id,
      speakerId: "speaker_0",
      speakerName: "Dr. Ada",
      speakerLocked: true,
    },
  ]);

  const textarea = host.querySelector("textarea");
  await React.act(async () => {
    textarea.focus();
    textarea.dispatchEvent(
      new happyWindow.KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true })
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.equal(restores.length, 1);
  assert.equal(restores[0][0], 25);
  assert.equal(restores[0][2], 1);
});

test("a speaker can be reassigned explicitly without changing the source transcript", async (t) => {
  const raw = JSON.stringify([
    { text: "First voice", speaker: "speaker_0", speakerName: "Ada" },
    { text: "Second voice", speaker: "speaker_1", speakerName: "Lin" },
  ]);
  const normalized = await normalizeTranscriptSource(raw);
  const workspace = {
    noteId: 27,
    sourceTranscript: raw,
    originalTranscript: raw,
    sourceHash: normalized.sourceHash,
    baselineSourceHash: normalized.sourceHash,
    currentVersion: 0,
    versionId: null,
    approvedOperations: [],
    stale: false,
  };
  const saves = [];
  const { host } = await mount(
    t,
    { noteId: 27, sourceTranscript: raw, canEdit: true, onExport: () => assert.fail() },
    apiFor(workspace, async (input) => {
      saves.push(input);
      return {
        version: 1,
        workspace: { ...workspace, currentVersion: 1, versionId: "speaker-version" },
      };
    })
  );

  const select = host.querySelector(
    `select[aria-label="Reassign speaker for ${normalized.segments[0].id}"]`
  );
  assert.ok(select, "each segment has an explicit reassignment control");
  assert.deepEqual(
    [...select.options].map((option) => option.value),
    ["", "speaker_0", "speaker_1"]
  );
  await React.act(async () => {
    select.value = "speaker_1";
    select.dispatchEvent(new happyWindow.Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  assert.deepEqual(saves[0].operations, [
    {
      kind: "setSpeaker",
      segmentId: normalized.segments[0].id,
      speakerId: "speaker_1",
      speakerName: "Lin",
      speakerLocked: true,
    },
  ]);
  assert.equal(workspace.sourceTranscript, raw);
  assert.equal(host.textContent.includes("Export transcript"), false);
});

test("speaker mapping and suggestion decisions use overlay revisions, not raw-note callbacks", async (t) => {
  const raw = JSON.stringify([
    { text: "First", speaker: "speaker_0", speakerName: "Ada" },
    { text: "Second", speaker: "speaker_1", speakerName: "Lin" },
    {
      text: "Recorder line",
      speaker: "speaker_0",
      suggestedName: "You",
      suggestedProfileId: 9,
      recorderName: "Rae",
    },
    {
      text: "Maybe line",
      speaker: "speaker_1",
      suggestedName: "Maybe Lin",
      suggestedProfileId: 10,
    },
  ]);
  const normalized = await normalizeTranscriptSource(raw);
  const workspace = {
    noteId: 28,
    sourceTranscript: raw,
    originalTranscript: raw,
    sourceHash: normalized.sourceHash,
    baselineSourceHash: normalized.sourceHash,
    currentVersion: 0,
    versionId: null,
    approvedOperations: [],
    stale: false,
  };
  const saves = [];
  const mappings = [];
  const confirmations = [];
  const dismissals = [];
  const { host } = await mount(
    t,
    {
      noteId: 28,
      sourceTranscript: raw,
      canEdit: true,
      speakerMappings: { speaker_1: "Lin" },
      onMapSpeaker: async (...args) => {
        mappings.push(args);
        return args[1];
      },
      onConfirmSuggestion: async (...args) => {
        confirmations.push(args);
        return "Rae Profile";
      },
      onDismissSuggestion: async (...args) => dismissals.push(args),
    },
    apiFor(workspace, async (input) => {
      saves.push(input);
      return {
        version: saves.length,
        workspace: { ...workspace, currentVersion: saves.length, versionId: `v-${saves.length}` },
      };
    })
  );

  const reassignment = host.querySelector(
    `select[aria-label="Reassign speaker for ${normalized.segments[0].id}"]`
  );
  await React.act(async () => {
    reassignment.value = "speaker_1";
    reassignment.dispatchEvent(new happyWindow.Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.equal(mappings[0][0], "speaker_1");
  assert.equal(mappings[0].at(-1), false, "mapping callback is asked to preserve the source");
  assert.equal(saves[0].operations[0].kind, "setSpeaker");

  const suggestionId = normalized.segments[2].id;
  const accept = host.querySelector(
    `button[aria-label="Accept speaker suggestion ${suggestionId}"]`
  );
  assert.ok(accept, "the persisted suggestion remains actionable");
  await React.act(async () => {
    accept.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.deepEqual(confirmations[0], ["speaker_0", "You", 9, "Rae", false]);
  assert.deepEqual(saves[1].operations[0], {
    kind: "setSpeaker",
    segmentId: suggestionId,
    speakerId: "speaker_0",
    speakerName: "Rae Profile",
    speakerLocked: true,
    suggestedName: null,
    suggestedProfileId: null,
  });

  const dismissId = normalized.segments[3].id;
  const dismiss = host.querySelector(
    `button[aria-label="Dismiss speaker suggestion ${dismissId}"]`
  );
  assert.ok(dismiss, "the user can explicitly dismiss a persisted suggestion");
  await React.act(async () => {
    dismiss.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.deepEqual(dismissals[0], ["speaker_1", false]);
  assert.equal(saves[2].operations[0].suggestedName, null);
  assert.equal(workspace.sourceTranscript, raw);
});

test("Studio does not offer merge across different speaker identities", async (t) => {
  const raw = JSON.stringify([
    { text: "First voice", speaker: "speaker_0", speakerName: "Ada" },
    { text: "Second voice", speaker: "speaker_1", speakerName: "Lin" },
  ]);
  const normalized = await normalizeTranscriptSource(raw);
  const workspace = {
    noteId: 29,
    sourceTranscript: raw,
    originalTranscript: raw,
    sourceHash: normalized.sourceHash,
    baselineSourceHash: normalized.sourceHash,
    currentVersion: 0,
    versionId: null,
    approvedOperations: [],
    stale: false,
  };
  const { host } = await mount(
    t,
    { noteId: 29, sourceTranscript: raw, canEdit: true },
    apiFor(workspace)
  );

  assert.equal(
    [...host.querySelectorAll("button")].some((button) => button.textContent === "Merge with next"),
    false
  );
});

test("editing a block keeps the focused control mounted and never adds timing", async (t) => {
  const raw = '[{"text":"Original words","speaker":"speaker_0"}]';
  const normalized = await normalizeTranscriptSource(raw);
  const workspace = {
    noteId: 24,
    sourceTranscript: raw,
    originalTranscript: raw,
    sourceHash: normalized.sourceHash,
    baselineSourceHash: normalized.sourceHash,
    currentVersion: 0,
    versionId: null,
    approvedOperations: [],
    stale: false,
  };
  const { host } = await mount(
    t,
    { noteId: 24, sourceTranscript: raw, canEdit: true },
    apiFor(workspace)
  );
  const textarea = host.querySelector("textarea");
  textarea.focus();
  await React.act(async () => {
    inputValue(textarea, "Edited words");
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  assert.equal(host.querySelector("textarea"), textarea);
  assert.equal(happyWindow.document.activeElement, textarea);
  assert.equal(textarea.value, "Edited words");
  assert.equal(host.querySelector("time"), null);
});

test("Undo waits for a queued transcript save before restoring its version", async (t) => {
  const raw = '[{"text":"Original words","speaker":"speaker_0"}]';
  const normalized = await normalizeTranscriptSource(raw);
  const workspace = {
    noteId: 29,
    sourceTranscript: raw,
    originalTranscript: raw,
    sourceHash: normalized.sourceHash,
    baselineSourceHash: normalized.sourceHash,
    currentVersion: 0,
    versionId: null,
    approvedOperations: [],
    stale: false,
  };
  let finishApply;
  const restores = [];
  const { host } = await mount(
    t,
    { noteId: 29, sourceTranscript: raw, canEdit: true },
    apiFor(
      workspace,
      async () =>
        new Promise((resolve) => {
          finishApply = () =>
            resolve({
              version: 1,
              workspace: { ...workspace, currentVersion: 1, versionId: "version-1" },
            });
        }),
      async (noteId, versionId, expectedVersion) => {
        restores.push({ noteId, versionId, expectedVersion });
        return {
          ...workspace,
          currentVersion: expectedVersion + 1,
          versionId: "restored-version",
        };
      }
    )
  );

  const textarea = host.querySelector("textarea");
  await React.act(async () => {
    inputValue(textarea, "Edited words");
    textarea.focus();
    textarea.blur();
    await waitFor(() => !!finishApply);
  });
  const undo = [...host.querySelectorAll("button")].find((button) => button.textContent === "Undo");
  await React.act(async () => undo.click());
  assert.deepEqual(restores, [], "undo must not race the pending revision write");

  await React.act(async () => {
    finishApply();
    await waitFor(() => restores.length === 1);
  });
  assert.deepEqual(restores[0], {
    noteId: 29,
    versionId: `baseline:${workspace.sourceHash}`,
    expectedVersion: 1,
  });
});

test("text edits persist explicitly and split uses the current cursor", async (t) => {
  const raw = '[{"text":"alpha beta","speaker":"speaker_0"}]';
  const normalized = await normalizeTranscriptSource(raw);
  const workspace = {
    noteId: 26,
    sourceTranscript: raw,
    originalTranscript: raw,
    sourceHash: normalized.sourceHash,
    baselineSourceHash: normalized.sourceHash,
    currentVersion: 0,
    versionId: null,
    approvedOperations: [],
    stale: false,
  };
  const saves = [];
  const { host } = await mount(
    t,
    { noteId: 26, sourceTranscript: raw, canEdit: true },
    apiFor(workspace, async (input) => {
      saves.push(input);
      return {
        version: saves.length,
        workspace: {
          ...workspace,
          currentVersion: saves.length,
          versionId: `version-${saves.length}`,
        },
      };
    })
  );

  const textarea = host.querySelector("textarea");
  await React.act(async () => {
    inputValue(textarea, "alpha changed");
    textarea.focus();
    textarea.blur();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.equal(saves[0].operations[0].kind, "replaceText");
  assert.equal(saves[0].operations[0].after, "alpha changed");

  const updatedTextarea = host.querySelector("textarea");
  updatedTextarea.focus();
  updatedTextarea.setSelectionRange(5, 5);
  updatedTextarea.dispatchEvent(new happyWindow.Event("select", { bubbles: true }));
  await React.act(async () => {});
  const split = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Split at cursor"
  );
  assert.equal(split.disabled, false);
  await React.act(async () => split.click());
  assert.equal(saves[1].operations[0].kind, "split");
  assert.equal(saves[1].operations[0].atOffset, 5);
});
