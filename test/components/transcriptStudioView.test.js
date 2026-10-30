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
let planTranscriptChunks;
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
  ({ planTranscriptChunks } = await vite.ssrLoadModule(
    "/custom-features/transcript-studio/process/chunkPlanner.ts"
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
    getTranscriptVersion: async (_noteId, versionId) => ({
      versionId,
      version: 0,
      description: "Original",
      createdAt: null,
      sourceHash: workspace.sourceHash,
      operations: [],
    }),
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
  const newAccountKey = `transcript-studio-proposals:acct-new:24:${normalized.sourceHash}`;
  const previousStorage = happyWindow.localStorage.getItem(newAccountKey);
  happyWindow.localStorage.removeItem(newAccountKey);
  usePolicyStore.setState({ accountId: "acct-old", authGeneration: 1 });
  happyWindow.localStorage.setItem(newAccountKey, "[]");

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
    assert.deepEqual(JSON.parse(happyWindow.localStorage.getItem(newAccountKey)), {
      accountId: "acct-new",
      noteId: 24,
      sourceHash: normalized.sourceHash,
      proposals: [],
    });
    assert.equal(host.querySelector('[data-proposal-chunk="old-chunk"]'), null);
  } finally {
    usePolicyStore.setState(previousPolicy);
    if (previousStorage !== null) {
      happyWindow.localStorage.setItem(newAccountKey, previousStorage);
    } else {
      happyWindow.localStorage.removeItem(newAccountKey);
    }
  }
});

test("completed proposals survive cancellation and renderer remount in local storage", async (t) => {
  const raw = JSON.stringify([{ text: "Persist this proposal" }]);
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
  const [chunk] = planTranscriptChunks(normalized.segments, 6000);
  const previousPolicy = usePolicyStore.getState();
  usePolicyStore.setState({ accountId: "draft-recovery-account", authGeneration: 1 });
  const key = `transcript-studio-proposals:draft-recovery-account:25:${normalized.sourceHash}`;
  const prior = happyWindow.localStorage.getItem(key);
  happyWindow.localStorage.removeItem(key);
  t.after(() => {
    usePolicyStore.setState(previousPolicy);
    if (prior === null) happyWindow.localStorage.removeItem(key);
    else happyWindow.localStorage.setItem(key, prior);
  });
  const segmentId = normalized.segments[0].id;
  const jobRunner = async function* () {
    yield {
      type: "chunkProposed",
      chunk,
      candidate: { segments: [{ id: segmentId, text: "Persist this proposal." }] },
      validation: {
        safe: true,
        warnings: [],
        edits: [
          {
            kind: "replaceText",
            segmentId,
            before: "Persist this proposal",
            after: "Persist this proposal.",
          },
        ],
      },
    };
    yield { type: "done", completed: 1, total: 1, cancelled: true };
  };
  const props = { noteId: 25, sourceTranscript: raw, canEdit: true, jobRunner };
  const first = await mount(t, props, apiFor(workspace));
  const button = [...first.host.querySelectorAll("button")].find((candidate) =>
    candidate.textContent.includes("Edit transcript with AI")
  );
  await React.act(async () => button.click());
  assert.equal(
    await waitFor(() => !!first.host.querySelector(`[data-proposal-chunk="${chunk.id}"]`)),
    true
  );
  assert.ok(happyWindow.localStorage.getItem(key));
  assert.equal(happyWindow.sessionStorage.getItem(key), null);

  await React.act(async () => first.root.unmount());
  const second = await mount(
    t,
    { noteId: 25, sourceTranscript: raw, canEdit: true },
    apiFor(workspace)
  );
  assert.equal(
    await waitFor(() => !!second.host.querySelector(`[data-proposal-chunk="${chunk.id}"]`)),
    true
  );
});

test("stored proposals with a mismatched source are discarded on load", async (t) => {
  const raw = JSON.stringify([{ text: "Current source" }]);
  const normalized = await normalizeTranscriptSource(raw);
  const previousPolicy = usePolicyStore.getState();
  usePolicyStore.setState({ accountId: "draft-validation-account", authGeneration: 5 });
  const key = `transcript-studio-proposals:draft-validation-account:26:${normalized.sourceHash}`;
  const prior = happyWindow.localStorage.getItem(key);
  happyWindow.localStorage.setItem(
    key,
    JSON.stringify([
      {
        type: "chunkProposed",
        baseVersion: 0,
        chunk: { id: "stale", index: 0, segments: [], inputTokens: 1, outputTokens: 1 },
        candidate: { segments: [] },
        validation: { safe: true, warnings: [], edits: [] },
      },
    ])
  );
  t.after(() => {
    usePolicyStore.setState(previousPolicy);
    if (prior === null) happyWindow.localStorage.removeItem(key);
    else happyWindow.localStorage.setItem(key, prior);
  });
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
  const { host } = await mount(
    t,
    { noteId: 26, sourceTranscript: raw, canEdit: true },
    apiFor(workspace)
  );
  await new Promise((resolve) => setTimeout(resolve, 25));
  await React.act(async () => {});
  assert.equal(host.querySelector('[data-proposal-chunk="stale"]'), null);
  assert.doesNotMatch(host.textContent, /Pending AI proposals \(1\)/);
});

test("a forged stored safe flag is recalculated from the immutable source and candidate", async (t) => {
  const raw = "Alice told Bob.";
  const normalized = await normalizeTranscriptSource(raw);
  const [chunk] = planTranscriptChunks(normalized.segments, 6000);
  const previousPolicy = usePolicyStore.getState();
  usePolicyStore.setState({ accountId: "forged-draft-account", authGeneration: 7 });
  const key = `transcript-studio-proposals:forged-draft-account:27:${normalized.sourceHash}`;
  const prior = happyWindow.localStorage.getItem(key);
  const segmentId = normalized.segments[0].id;
  happyWindow.localStorage.setItem(
    key,
    JSON.stringify({
      accountId: "forged-draft-account",
      noteId: 27,
      sourceHash: normalized.sourceHash,
      proposals: [
        {
          type: "chunkProposed",
          baseVersion: 0,
          chunk,
          candidate: { segments: [{ id: segmentId, text: "Bob told Alice." }] },
          validation: {
            safe: true,
            warnings: [],
            edits: [{ kind: "replaceText", segmentId, before: raw, after: "Bob told Alice." }],
          },
        },
      ],
    })
  );
  t.after(() => {
    usePolicyStore.setState(previousPolicy);
    if (prior === null) happyWindow.localStorage.removeItem(key);
    else happyWindow.localStorage.setItem(key, prior);
  });
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
  const { host } = await mount(
    t,
    { noteId: 27, sourceTranscript: raw, canEdit: true },
    apiFor(workspace)
  );
  assert.equal(
    await waitFor(() => !!host.querySelector(`[data-proposal-chunk="${chunk.id}"]`)),
    true
  );
  const acceptAll = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Accept all"
  );
  assert.equal(
    acceptAll.disabled,
    true,
    "stored safe/warnings/edits fields must not authorize bulk acceptance"
  );
  assert.ok(host.querySelector(`[aria-label="Accept proposal ${chunk.id} after manual review"]`));
  assert.match(host.textContent, /content|manually review/i);
});

test("a structurally incomplete saved proposal is discarded with a safe retry action", async (t) => {
  const raw = '[{"text":"Original first."},{"text":"Original second."}]';
  const normalized = await normalizeTranscriptSource(raw);
  const [chunk] = planTranscriptChunks(normalized.segments, 6000);
  const previousPolicy = usePolicyStore.getState();
  usePolicyStore.setState({ accountId: "incomplete-draft-account", authGeneration: 10 });
  const key = `transcript-studio-proposals:incomplete-draft-account:68:${normalized.sourceHash}`;
  const prior = happyWindow.localStorage.getItem(key);
  happyWindow.localStorage.setItem(
    key,
    JSON.stringify({
      accountId: "incomplete-draft-account",
      noteId: 68,
      sourceHash: normalized.sourceHash,
      proposals: [
        {
          type: "chunkProposed",
          baseVersion: 0,
          chunk,
          candidate: {
            segments: [{ id: normalized.segments[0].id, text: "Edited first." }],
          },
          validation: {
            safe: true,
            warnings: [],
            edits: [
              {
                kind: "replaceText",
                segmentId: normalized.segments[0].id,
                before: "Original first.",
                after: "Edited first.",
              },
            ],
          },
        },
      ],
    })
  );
  t.after(() => {
    usePolicyStore.setState(previousPolicy);
    if (prior === null) happyWindow.localStorage.removeItem(key);
    else happyWindow.localStorage.setItem(key, prior);
  });
  const workspace = {
    noteId: 68,
    sourceTranscript: raw,
    originalTranscript: raw,
    sourceHash: normalized.sourceHash,
    baselineSourceHash: normalized.sourceHash,
    currentVersion: 0,
    versionId: null,
    approvedOperations: [],
    stale: false,
  };
  let retryCalls = 0;
  const jobRunner = async function* () {
    retryCalls += 1;
    yield { type: "done", completed: 0, total: 1 };
  };
  const { host } = await mount(
    t,
    { noteId: 68, sourceTranscript: raw, canEdit: true, jobRunner },
    apiFor(workspace)
  );

  assert.equal(
    await waitFor(() => host.textContent.includes("could not be restored safely")),
    true,
    host.textContent
  );
  assert.equal(host.querySelector(`[data-proposal-chunk="${chunk.id}"]`), null);
  assert.equal(host.querySelectorAll("textarea")[0].value, "Original first.");
  assert.equal(host.querySelectorAll("textarea")[1].value, "Original second.");
  const retry = [...host.querySelectorAll("button")].find((button) =>
    button.textContent.includes("Retry AI edit")
  );
  assert.ok(retry);
  await React.act(async () => retry.click());
  assert.equal(await waitFor(() => retryCalls === 1), true);
  assert.equal(host.querySelectorAll("textarea")[0].value, "Original first.");
  assert.equal(host.querySelectorAll("textarea")[1].value, "Original second.");
});

for (const [tamper, mutateChunk] of [
  ["omits an owned source segment", (chunk) => (chunk.segments = chunk.segments.slice(0, 1))],
  ["reorders its source segments", (chunk) => (chunk.segments = chunk.segments.reverse())],
  [
    "marks an owned source segment as context only",
    (chunk) => (chunk.segments[1].contextOnly = true),
  ],
]) {
  test(`a saved chunk that ${tamper} is not trusted during recovery`, async (t) => {
    const raw = '[{"text":"Original first."},{"text":"Original second."}]';
    const normalized = await normalizeTranscriptSource(raw);
    const [canonicalChunk] = planTranscriptChunks(normalized.segments, 6000);
    const chunk = JSON.parse(JSON.stringify(canonicalChunk));
    mutateChunk(chunk);
    const previousPolicy = usePolicyStore.getState();
    const accountId = `tampered-chunk-${tamper.replaceAll(" ", "-")}`;
    const noteId = 70;
    usePolicyStore.setState({ accountId, authGeneration: 11 });
    const key = `transcript-studio-proposals:${accountId}:${noteId}:${normalized.sourceHash}`;
    const prior = happyWindow.localStorage.getItem(key);
    happyWindow.localStorage.setItem(
      key,
      JSON.stringify({
        accountId,
        noteId,
        sourceHash: normalized.sourceHash,
        proposals: [
          {
            type: "chunkProposed",
            baseVersion: 0,
            chunk,
            candidate: {
              segments: chunk.segments
                .filter((segment) => !segment.contextOnly)
                .map((segment) => ({
                  id: segment.id,
                  text: segment.text.replace("Original", "Updated"),
                })),
            },
            validation: {
              structurallyValid: true,
              safe: true,
              warnings: [],
              edits: [],
            },
          },
        ],
      })
    );
    t.after(() => {
      usePolicyStore.setState(previousPolicy);
      if (prior === null) happyWindow.localStorage.removeItem(key);
      else happyWindow.localStorage.setItem(key, prior);
    });
    const workspace = {
      noteId,
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
      { noteId, sourceTranscript: raw, canEdit: true },
      apiFor(workspace)
    );

    assert.equal(
      await waitFor(() => host.textContent.includes("could not be restored safely")),
      true,
      host.textContent
    );
    assert.equal(host.querySelector('[data-proposal-chunk="chunk-0"]'), null);
    assert.deepEqual(
      [...host.querySelectorAll("textarea")].map((textarea) => textarea.value),
      normalized.segments.map((segment) => segment.text)
    );
  });
}

test("a cached scope cannot narrow the source scope used for proposal recovery", async (t) => {
  const raw = '[{"text":"First source sentence."},{"text":"Selected source sentence."}]';
  const normalized = await normalizeTranscriptSource(raw);
  const selected = [normalized.segments[1]];
  const [chunk] = planTranscriptChunks(selected, 6000);
  const accountId = "selected-draft-recovery";
  const noteId = 71;
  const previousPolicy = usePolicyStore.getState();
  usePolicyStore.setState({ accountId, authGeneration: 12 });
  const key = `transcript-studio-proposals:${accountId}:${noteId}:${normalized.sourceHash}`;
  const prior = happyWindow.localStorage.getItem(key);
  happyWindow.localStorage.setItem(
    key,
    JSON.stringify({
      accountId,
      noteId,
      sourceHash: normalized.sourceHash,
      scope: { segmentIds: selected.map((segment) => segment.id), maxInputTokens: 6000 },
      proposals: [
        {
          type: "chunkProposed",
          baseVersion: 0,
          draftScope: { segmentIds: selected.map((segment) => segment.id), maxInputTokens: 6000 },
          chunk,
          candidate: {
            segments: [{ id: selected[0].id, text: "Selected source remains." }],
          },
        },
      ],
    })
  );
  t.after(() => {
    usePolicyStore.setState(previousPolicy);
    if (prior === null) happyWindow.localStorage.removeItem(key);
    else happyWindow.localStorage.setItem(key, prior);
  });
  const workspace = {
    noteId,
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
    { noteId, sourceTranscript: raw, canEdit: true },
    apiFor(workspace)
  );

  assert.equal(
    await waitFor(() => host.textContent.includes("could not be restored safely")),
    true,
    host.textContent
  );
  assert.equal(host.querySelector('[data-proposal-chunk="chunk-0"]'), null);
  assert.equal(
    [...host.querySelectorAll("button")].some((button) =>
      button.textContent.includes("Retry AI edit")
    ),
    true
  );
  assert.deepEqual(
    [...host.querySelectorAll("textarea")].map((textarea) => textarea.value),
    normalized.segments.map((segment) => segment.text)
  );
});

test("a valid synthetic proposal for an oversized source segment survives recovery", async (t) => {
  const sourceText = `Original ${"source words ".repeat(1900)}`;
  const normalized = await normalizeTranscriptSource(sourceText);
  const source = normalized.segments[0];
  const chunks = planTranscriptChunks(normalized.segments, 6000);
  const lastSplitChunk = [...chunks]
    .reverse()
    .find((chunk) => chunk.segments.some((segment) => segment.parentSegmentId === source.id));
  assert.ok(lastSplitChunk);
  const chunk = {
    id: `${lastSplitChunk.id}-${source.id}`,
    index: lastSplitChunk.index,
    segments: [source],
    inputTokens: Math.max(1, Math.ceil(source.text.length / 3.5)) + 12,
    outputTokens: lastSplitChunk.outputTokens,
  };
  const accountId = "split-draft-recovery";
  const noteId = 72;
  const previousPolicy = usePolicyStore.getState();
  usePolicyStore.setState({ accountId, authGeneration: 13 });
  const key = `transcript-studio-proposals:${accountId}:${noteId}:${normalized.sourceHash}`;
  const prior = happyWindow.localStorage.getItem(key);
  happyWindow.localStorage.setItem(
    key,
    JSON.stringify({
      accountId,
      noteId,
      sourceHash: normalized.sourceHash,
      scope: { segmentIds: normalized.segments.map((segment) => segment.id), maxInputTokens: 6000 },
      proposals: [
        {
          type: "chunkProposed",
          baseVersion: 0,
          chunk,
          candidate: {
            segments: [{ id: source.id, text: source.text.replace("Original", "Updated") }],
          },
        },
      ],
    })
  );
  t.after(() => {
    usePolicyStore.setState(previousPolicy);
    if (prior === null) happyWindow.localStorage.removeItem(key);
    else happyWindow.localStorage.setItem(key, prior);
  });
  const workspace = {
    noteId,
    sourceTranscript: sourceText,
    originalTranscript: sourceText,
    sourceHash: normalized.sourceHash,
    baselineSourceHash: normalized.sourceHash,
    currentVersion: 0,
    versionId: null,
    approvedOperations: [],
    stale: false,
  };
  const { host } = await mount(
    t,
    { noteId, sourceTranscript: sourceText, canEdit: true },
    apiFor(workspace)
  );

  assert.equal(
    await waitFor(() => !!host.querySelector(`[data-proposal-chunk="${chunk.id}"]`)),
    true
  );
  assert.ok(host.querySelector(`[aria-label="Accept proposal ${chunk.id} after manual review"]`));
});

test("corrupt saved proposals show a recovery warning instead of disappearing silently", async (t) => {
  const raw = "Recoverable source";
  const normalized = await normalizeTranscriptSource(raw);
  const previousPolicy = usePolicyStore.getState();
  usePolicyStore.setState({ accountId: "corrupt-draft-account", authGeneration: 8 });
  const key = `transcript-studio-proposals:corrupt-draft-account:28:${normalized.sourceHash}`;
  const prior = happyWindow.localStorage.getItem(key);
  happyWindow.localStorage.setItem(key, "{broken-json");
  t.after(() => {
    usePolicyStore.setState(previousPolicy);
    if (prior === null) happyWindow.localStorage.removeItem(key);
    else happyWindow.localStorage.setItem(key, prior);
  });
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
  const { host } = await mount(
    t,
    { noteId: 28, sourceTranscript: raw, canEdit: true },
    apiFor(workspace)
  );
  assert.equal(
    await waitFor(() =>
      /saved AI proposals could not be (restored safely|recovered|read)/i.test(host.textContent)
    ),
    true,
    host.textContent
  );
  assert.equal(host.querySelector("textarea").value, raw);
});

test("proposal storage write failures remain visible while the proposal stays available in memory", async (t) => {
  const raw = "Proposal must remain visible";
  const normalized = await normalizeTranscriptSource(raw);
  const previousPolicy = usePolicyStore.getState();
  usePolicyStore.setState({ accountId: "blocked-storage-account", authGeneration: 9 });
  const key = `transcript-studio-proposals:blocked-storage-account:29:${normalized.sourceHash}`;
  const prior = happyWindow.localStorage.getItem(key);
  happyWindow.localStorage.removeItem(key);
  const storage = happyWindow.localStorage;
  const originalSetItemDescriptor = Object.getOwnPropertyDescriptor(storage, "setItem");
  const originalSetItem = storage.setItem;
  Object.defineProperty(storage, "setItem", {
    configurable: true,
    writable: true,
    value: function (storageKey, value) {
      if (storageKey === key) throw new Error("quota exceeded");
      return originalSetItem.call(this, storageKey, value);
    },
  });
  t.after(() => {
    if (originalSetItemDescriptor)
      Object.defineProperty(storage, "setItem", originalSetItemDescriptor);
    else delete storage.setItem;
    usePolicyStore.setState(previousPolicy);
    if (prior === null) happyWindow.localStorage.removeItem(key);
    else happyWindow.localStorage.setItem(key, prior);
  });
  const segmentId = normalized.segments[0].id;
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
  const jobRunner = async function* () {
    yield {
      type: "chunkProposed",
      chunk: {
        id: "memory-proposal",
        index: 0,
        segments: [{ id: segmentId, text: raw }],
        inputTokens: 1,
        outputTokens: 1,
      },
      candidate: { segments: [{ id: segmentId, text: `${raw}.` }] },
      validation: {
        safe: true,
        warnings: [],
        edits: [{ kind: "replaceText", segmentId, before: raw, after: `${raw}.` }],
      },
    };
    yield { type: "done", completed: 1, total: 1, cancelled: true };
  };
  const { host } = await mount(
    t,
    { noteId: 29, sourceTranscript: raw, canEdit: true, jobRunner },
    apiFor(workspace)
  );
  const button = [...host.querySelectorAll("button")].find((candidate) =>
    candidate.textContent.includes("Edit transcript with AI")
  );
  await React.act(async () => button.click());
  assert.equal(
    await waitFor(() => !!host.querySelector('[data-proposal-chunk="memory-proposal"]')),
    true
  );
  assert.equal(
    await waitFor(() => /could not be saved on this device/i.test(host.textContent)),
    true,
    host.textContent
  );
  assert.ok(host.querySelector('[data-proposal-chunk="memory-proposal"]'));
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
    [...host.querySelectorAll("button")].some(
      (button) => !button.disabled && !button.textContent.includes("Version history")
    ),
    false
  );
});

test("version history compares read-only and asks before restoring", async (t) => {
  const raw = "Original transcript";
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
  let restoreCalls = 0;
  const api = apiFor(workspace, undefined, async () => {
    restoreCalls += 1;
    return workspace;
  });
  const { host } = await mount(t, { noteId: 27, sourceTranscript: raw, canEdit: true }, api);
  const previousConfirm = happyWindow.confirm;
  happyWindow.confirm = () => false;
  t.after(() => {
    happyWindow.confirm = previousConfirm;
  });
  const history = [...host.querySelectorAll("button")].find((button) =>
    button.textContent.includes("Version history")
  );
  await React.act(async () => history.click());
  assert.match(host.textContent, /Original transcript/);
  assert.ok(host.querySelector("[aria-label='Read-only version comparison']"));
  const restore = [...host.querySelectorAll("button")].find((button) =>
    button.textContent.includes("Restore selected version")
  );
  await React.act(async () => restore.click());
  assert.equal(restoreCalls, 0);
});

test("version comparison refuses a snapshot from a different raw transcript source", async (t) => {
  const raw = "Current source words";
  const normalized = await normalizeTranscriptSource(raw);
  const workspace = {
    noteId: 29,
    sourceTranscript: raw,
    originalTranscript: raw,
    sourceHash: normalized.sourceHash,
    baselineSourceHash: normalized.sourceHash,
    currentVersion: 1,
    versionId: "current-version",
    approvedOperations: [],
    stale: false,
  };
  const api = {
    ...apiFor(workspace),
    listTranscriptVersions: async () => [
      { versionId: "old-source-version", version: 1, description: "Old transcript revision" },
    ],
    getTranscriptVersion: async () => ({
      versionId: "old-source-version",
      version: 1,
      description: "Old transcript revision",
      createdAt: null,
      sourceHash: "previous-source-hash",
      operations: [{ kind: "replaceText", segmentId: "source-old", after: "must not apply" }],
    }),
  };
  const { host } = await mount(t, { noteId: 29, sourceTranscript: raw, canEdit: false }, api);
  const history = [...host.querySelectorAll("button")].find((button) =>
    button.textContent.includes("Version history")
  );
  await React.act(async () => history.click());
  assert.match(host.textContent, /different source transcript/);
  assert.equal(host.querySelector("textarea").value, raw);
  assert.equal(
    host.querySelector("[aria-label='Read-only version comparison'] pre").textContent,
    ""
  );
});

test("restoring a selected revision creates a new session baseline with empty Undo and Redo", async (t) => {
  const raw = "Original line";
  const normalized = await normalizeTranscriptSource(raw);
  const edited = {
    noteId: 28,
    sourceTranscript: raw,
    originalTranscript: raw,
    sourceHash: normalized.sourceHash,
    baselineSourceHash: normalized.sourceHash,
    currentVersion: 1,
    versionId: "version-1",
    approvedOperations: [
      {
        kind: "replaceText",
        segmentId: normalized.segments[0].id,
        before: raw,
        after: "Edited line",
      },
    ],
    stale: false,
  };
  const restored = { ...edited, currentVersion: 2, versionId: "version-2", approvedOperations: [] };
  const previousConfirm = happyWindow.confirm;
  happyWindow.confirm = () => true;
  t.after(() => {
    happyWindow.confirm = previousConfirm;
  });
  const { host } = await mount(
    t,
    { noteId: 28, sourceTranscript: raw, canEdit: true },
    {
      ...apiFor(edited),
      listTranscriptVersions: async () => [
        {
          versionId: `baseline:account:transcript-account:${normalized.sourceHash}`,
          version: 0,
          description: "Original transcript",
        },
        { versionId: "version-1", version: 1, description: "Manual edit" },
      ],
      getTranscriptVersion: async (_noteId, versionId) => ({
        versionId,
        version: 0,
        description: "Original transcript",
        createdAt: null,
        sourceHash: normalized.sourceHash,
        operations: [],
      }),
      restoreTranscriptVersion: async () => restored,
    }
  );
  assert.equal(host.querySelector("textarea").value, "Edited line");
  const history = [...host.querySelectorAll("button")].find((button) =>
    button.textContent.includes("Version history")
  );
  await React.act(async () => history.click());
  const restore = [...host.querySelectorAll("button")].find((button) =>
    button.textContent.includes("Restore selected version")
  );
  await React.act(async () => restore.click());
  const restoredToBaseline = await waitFor(() => host.querySelector("textarea").value === raw, 50);
  await React.act(async () => {});
  assert.ok(restoredToBaseline, "selected version restore did not finish before the assertion");
  assert.equal(host.querySelector("textarea").value, raw);
  assert.equal(
    [...host.querySelectorAll("button")].find((button) => button.textContent === "Undo").disabled,
    true
  );
  assert.equal(
    [...host.querySelectorAll("button")].find((button) => button.textContent === "Redo").disabled,
    true
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
  assert.equal(undo.disabled, true, "undo stays unavailable while the write is pending");
  await React.act(async () => undo.click());
  assert.deepEqual(restores, [], "undo must not race the pending revision write");

  await React.act(async () => {
    finishApply();
    await waitFor(() => host.textContent.includes("v1") && !undo.disabled);
  });
  assert.deepEqual(restores, [], "the blocked undo is not replayed automatically");
  await React.act(async () => undo.click());
  await waitFor(() => restores.length === 1);
  assert.deepEqual(restores[0], {
    noteId: 29,
    versionId: `baseline:${workspace.sourceHash}`,
    expectedVersion: 1,
  });
});

test("failed transcript edits remain visible, marked unsaved, and can be retried", async (t) => {
  const raw = '[{"text":"Original retry text"}]';
  const normalized = await normalizeTranscriptSource(raw);
  const workspace = {
    noteId: 46,
    sourceTranscript: raw,
    originalTranscript: raw,
    sourceHash: normalized.sourceHash,
    baselineSourceHash: normalized.sourceHash,
    currentVersion: 0,
    versionId: null,
    approvedOperations: [],
    stale: false,
  };
  let attempts = 0;
  const { host } = await mount(
    t,
    { noteId: 46, sourceTranscript: raw, canEdit: true },
    apiFor(workspace, async ({ expectedVersion, operations }) => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary write failure");
      assert.equal(expectedVersion, attempts - 2);
      assert.equal(
        operations[0].after,
        attempts === 2 ? "Edited retry text" : "Second queued edit"
      );
      return {
        version: attempts - 1,
        workspace: {
          ...workspace,
          currentVersion: attempts - 1,
          versionId: `retry-v${attempts - 1}`,
        },
      };
    })
  );
  const textarea = host.querySelector("textarea");
  await React.act(async () => {
    inputValue(textarea, "Edited retry text");
    textarea.focus();
    textarea.blur();
    await waitFor(() => host.textContent.includes("temporary write failure"));
  });
  assert.equal(textarea.value, "Edited retry text");
  assert.match(host.textContent, /Unsaved transcript changes/);
  const retry = [...host.querySelectorAll("button")].find((button) =>
    button.textContent.includes("Retry save")
  );
  assert.ok(retry);
  await React.act(async () => retry.click());
  await waitFor(() => attempts === 2 && host.textContent.includes("v1"));
  assert.equal(textarea.value, "Edited retry text");
  await React.act(async () => {
    inputValue(textarea, "Second queued edit");
    textarea.focus();
    textarea.blur();
    await waitFor(() => attempts === 3 && host.textContent.includes("v2"));
  });
  assert.equal(textarea.value, "Second queued edit");
});

test("failed draft recovery is account scoped and preserved as a conflict after the remote version changes", async (t) => {
  const raw = '[{"text":"Original reload text"}]';
  const normalized = await normalizeTranscriptSource(raw);
  const workspace = {
    noteId: 47,
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
  usePolicyStore.setState({ accountId: "recovery-test-account", authGeneration: 7 });
  const storageKey = `transcript-studio-recovery:recovery-test-account:47:${normalized.sourceHash}`;
  const oldValue = happyWindow.localStorage.getItem(storageKey);
  happyWindow.localStorage.removeItem(storageKey);
  t.after(() => {
    usePolicyStore.setState(previousPolicy);
    if (oldValue === null) happyWindow.localStorage.removeItem(storageKey);
    else happyWindow.localStorage.setItem(storageKey, oldValue);
  });
  const first = await mount(
    t,
    { noteId: 47, sourceTranscript: raw, canEdit: true },
    apiFor(workspace, async () => {
      throw new Error("offline");
    })
  );
  await React.act(async () => {
    const textarea = first.host.querySelector("textarea");
    inputValue(textarea, "Recovered edit");
    textarea.focus();
    textarea.blur();
    await waitFor(() => happyWindow.localStorage.getItem(storageKey) !== null);
    await waitFor(() => first.host.textContent.includes("offline"));
  });
  await React.act(async () => first.root.unmount());
  const remoteChanged = { ...workspace, currentVersion: 1, versionId: "remote-v1" };
  const second = await mount(
    t,
    { noteId: 47, sourceTranscript: raw, canEdit: true },
    apiFor(remoteChanged)
  );
  assert.equal(second.host.querySelector("textarea").value, "Recovered edit");
  assert.match(second.host.textContent, /older transcript version/);
  assert.equal(
    [...second.host.querySelectorAll("button")].some((button) =>
      button.textContent.includes("Retry save")
    ),
    false
  );
});

test("a failed draft retry is retired on account and note changes without deleting its old recovery", async (t) => {
  const oldRaw = '[{"text":"Old account transcript"}]';
  const oldSource = await normalizeTranscriptSource(oldRaw);
  const oldWorkspace = {
    noteId: 48,
    sourceTranscript: oldRaw,
    originalTranscript: oldRaw,
    sourceHash: oldSource.sourceHash,
    baselineSourceHash: oldSource.sourceHash,
    currentVersion: 0,
    versionId: null,
    approvedOperations: [],
    stale: false,
  };
  const newRaw = '[{"text":"New account transcript"}]';
  const newSource = await normalizeTranscriptSource(newRaw);
  const newWorkspace = {
    noteId: 49,
    sourceTranscript: newRaw,
    originalTranscript: newRaw,
    sourceHash: newSource.sourceHash,
    baselineSourceHash: newSource.sourceHash,
    currentVersion: 0,
    versionId: null,
    approvedOperations: [],
    stale: false,
  };
  const previousPolicy = usePolicyStore.getState();
  usePolicyStore.setState({ accountId: "retry-old-account", authGeneration: 1 });
  const recoveryKey = `transcript-studio-recovery:retry-old-account:48:${oldSource.sourceHash}`;
  const previousRecovery = happyWindow.localStorage.getItem(recoveryKey);
  happyWindow.localStorage.removeItem(recoveryKey);
  t.after(() => {
    usePolicyStore.setState(previousPolicy);
    if (previousRecovery === null) happyWindow.localStorage.removeItem(recoveryKey);
    else happyWindow.localStorage.setItem(recoveryKey, previousRecovery);
  });
  const first = await mount(
    t,
    { noteId: 48, sourceTranscript: oldRaw, canEdit: true },
    apiFor(oldWorkspace, async () => {
      throw new Error("old account offline");
    })
  );
  await React.act(async () => {
    const textarea = first.host.querySelector("textarea");
    inputValue(textarea, "Old account unsaved draft");
    textarea.focus();
    textarea.blur();
    await waitFor(() => happyWindow.localStorage.getItem(recoveryKey) !== null);
    await waitFor(() => first.host.textContent.includes("old account offline"));
  });

  await React.act(async () => {
    usePolicyStore.setState({ accountId: "retry-new-account", authGeneration: 2 });
    happyWindow.electronAPI = apiFor(newWorkspace);
    first.root.render(
      React.createElement(TranscriptStudioView, {
        noteId: 49,
        sourceTranscript: newRaw,
        canEdit: true,
      })
    );
    await waitFor(() => first.host.querySelector("textarea")?.value === "New account transcript");
  });
  assert.equal(first.host.querySelector("textarea").value, "New account transcript");
  assert.equal(
    [...first.host.querySelectorAll("button")].some((button) =>
      button.textContent.includes("Retry save")
    ),
    false
  );
  assert.notEqual(happyWindow.localStorage.getItem(recoveryKey), null);
});

test("a retry whose version read resolves after context switch cannot write through the new account", async (t) => {
  const raw = '[{"text":"Shared source transcript"}]';
  const normalized = await normalizeTranscriptSource(raw);
  const oldWorkspace = {
    noteId: 53,
    sourceTranscript: raw,
    originalTranscript: raw,
    sourceHash: normalized.sourceHash,
    baselineSourceHash: normalized.sourceHash,
    currentVersion: 0,
    versionId: null,
    approvedOperations: [],
    stale: false,
  };
  const newWorkspace = { ...oldWorkspace, noteId: 54 };
  const previousPolicy = usePolicyStore.getState();
  usePolicyStore.setState({ accountId: "deferred-old-account", authGeneration: 1 });
  const recoveryKey = `transcript-studio-recovery:deferred-old-account:53:${normalized.sourceHash}`;
  const previousRecovery = happyWindow.localStorage.getItem(recoveryKey);
  happyWindow.localStorage.removeItem(recoveryKey);
  t.after(() => {
    usePolicyStore.setState(previousPolicy);
    if (previousRecovery === null) happyWindow.localStorage.removeItem(recoveryKey);
    else happyWindow.localStorage.setItem(recoveryKey, previousRecovery);
  });
  let finishVersionRead;
  const first = await mount(
    t,
    { noteId: 53, sourceTranscript: raw, canEdit: true },
    apiFor(oldWorkspace, async () => {
      throw new Error("old account offline");
    })
  );
  await React.act(async () => {
    const textarea = first.host.querySelector("textarea");
    inputValue(textarea, "Old account pending words");
    textarea.focus();
    textarea.blur();
    await waitFor(() => first.host.textContent.includes("old account offline"));
  });
  happyWindow.electronAPI.getTranscriptWorkspace = () =>
    new Promise((resolve) => {
      finishVersionRead = () => resolve(oldWorkspace);
    });
  const retry = [...first.host.querySelectorAll("button")].find((button) =>
    button.textContent.includes("Retry save")
  );
  await React.act(async () => retry.click());
  assert.equal(await waitFor(() => !!finishVersionRead), true);

  const newWrites = [];
  await React.act(async () => {
    usePolicyStore.setState({ accountId: "deferred-new-account", authGeneration: 2 });
    happyWindow.electronAPI = apiFor(newWorkspace, async (input) => {
      newWrites.push(input);
      return { version: 1, workspace: { ...newWorkspace, currentVersion: 1, versionId: "new-v1" } };
    });
    first.root.render(
      React.createElement(TranscriptStudioView, {
        noteId: 54,
        sourceTranscript: raw,
        canEdit: true,
      })
    );
    await waitFor(() => first.host.querySelector("textarea")?.value === "Shared source transcript");
    finishVersionRead();
    await waitFor(() => newWrites.length > 0);
  });
  assert.deepEqual(
    newWrites,
    [],
    "the delayed retry must not call IPC through the new account context"
  );
  assert.notEqual(
    happyWindow.localStorage.getItem(recoveryKey),
    null,
    "the old recovery remains available"
  );
});

test("an undo queued in an old context cannot restore the new context version", async (t) => {
  const raw = '[{"text":"Shared queue transcript"}]';
  const normalized = await normalizeTranscriptSource(raw);
  const oldWorkspace = {
    noteId: 56,
    sourceTranscript: raw,
    originalTranscript: raw,
    sourceHash: normalized.sourceHash,
    baselineSourceHash: normalized.sourceHash,
    currentVersion: 0,
    versionId: null,
    approvedOperations: [],
    stale: false,
  };
  const newWorkspace = { ...oldWorkspace, noteId: 57 };
  const previousPolicy = usePolicyStore.getState();
  usePolicyStore.setState({ accountId: "restore-old-account", authGeneration: 1 });
  t.after(() => usePolicyStore.setState(previousPolicy));
  let finishApply;
  const first = await mount(
    t,
    { noteId: 56, sourceTranscript: raw, canEdit: true },
    apiFor(
      oldWorkspace,
      async () =>
        new Promise((resolve) => {
          finishApply = () =>
            resolve({
              version: 1,
              workspace: { ...oldWorkspace, currentVersion: 1, versionId: "old-v1" },
            });
        })
    )
  );
  await React.act(async () => {
    const textarea = first.host.querySelector("textarea");
    inputValue(textarea, "Old context pending edit");
    textarea.focus();
    textarea.blur();
    await waitFor(() => !!finishApply);
  });
  const undo = [...first.host.querySelectorAll("button")].find(
    (button) => button.textContent === "Undo"
  );
  await React.act(async () => undo.click());

  const newRestores = [];
  await React.act(async () => {
    usePolicyStore.setState({ accountId: "restore-new-account", authGeneration: 2 });
    happyWindow.electronAPI = apiFor(
      newWorkspace,
      async () => ({
        version: 1,
        workspace: { ...newWorkspace, currentVersion: 1, versionId: "new-edit-v1" },
      }),
      async (noteId, versionId, expectedVersion) => {
        newRestores.push({ noteId, versionId, expectedVersion });
        return {
          ...newWorkspace,
          currentVersion: expectedVersion + 1,
          versionId: "new-restore-v1",
        };
      }
    );
    first.root.render(
      React.createElement(TranscriptStudioView, {
        noteId: 57,
        sourceTranscript: raw,
        canEdit: true,
      })
    );
    await waitFor(() => first.host.querySelector("textarea")?.value === "Shared queue transcript");
  });
  await React.act(async () => {
    const textarea = first.host.querySelector("textarea");
    inputValue(textarea, "New context edit");
    textarea.focus();
    textarea.blur();
    await waitFor(() => first.host.querySelector("textarea")?.value === "New context edit");
  });
  await React.act(async () => {
    finishApply();
    await waitFor(() => newRestores.length > 0);
  });
  assert.deepEqual(newRestores, [], "an old undo must not issue restore IPC in the new context");
});

test("a malformed local recovery workspace is ignored without hiding the persisted transcript", async (t) => {
  const raw = '[{"text":"Persisted safe transcript"}]';
  const normalized = await normalizeTranscriptSource(raw);
  const workspace = {
    noteId: 58,
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
  usePolicyStore.setState({ accountId: "malformed-recovery-account", authGeneration: 4 });
  const recoveryKey = `transcript-studio-recovery:malformed-recovery-account:58:${normalized.sourceHash}`;
  const previousRecovery = happyWindow.localStorage.getItem(recoveryKey);
  happyWindow.localStorage.setItem(
    recoveryKey,
    JSON.stringify({
      sourceHash: normalized.sourceHash,
      baseVersion: 0,
      operation: { kind: "replaceText", segmentId: "segment", before: "old", after: "bad" },
      description: "Corrupt local edit",
      workspace: { sourceHash: normalized.sourceHash, kind: "plain", segments: null },
    })
  );
  t.after(() => {
    usePolicyStore.setState(previousPolicy);
    if (previousRecovery === null) happyWindow.localStorage.removeItem(recoveryKey);
    else happyWindow.localStorage.setItem(recoveryKey, previousRecovery);
  });
  const { host } = await mount(
    t,
    { noteId: 58, sourceTranscript: raw, canEdit: true },
    apiFor(workspace)
  );
  assert.equal(host.querySelector("textarea").value, "Persisted safe transcript");
});

test("a commit completing after an account switch preserves its original recovery copy", async (t) => {
  const raw = '[{"text":"Deferred commit source"}]';
  const normalized = await normalizeTranscriptSource(raw);
  const oldWorkspace = {
    noteId: 61,
    sourceTranscript: raw,
    originalTranscript: raw,
    sourceHash: normalized.sourceHash,
    baselineSourceHash: normalized.sourceHash,
    currentVersion: 0,
    versionId: null,
    approvedOperations: [],
    stale: false,
  };
  const newWorkspace = { ...oldWorkspace, noteId: 62 };
  const previousPolicy = usePolicyStore.getState();
  usePolicyStore.setState({ accountId: "commit-late-account", authGeneration: 1 });
  const recoveryKey = `transcript-studio-recovery:commit-late-account:61:${normalized.sourceHash}`;
  const previousRecovery = happyWindow.localStorage.getItem(recoveryKey);
  happyWindow.localStorage.removeItem(recoveryKey);
  t.after(() => {
    usePolicyStore.setState(previousPolicy);
    if (previousRecovery === null) happyWindow.localStorage.removeItem(recoveryKey);
    else happyWindow.localStorage.setItem(recoveryKey, previousRecovery);
  });
  let finishApply;
  const first = await mount(
    t,
    { noteId: 61, sourceTranscript: raw, canEdit: true },
    apiFor(
      oldWorkspace,
      async () =>
        new Promise((resolve) => {
          finishApply = () =>
            resolve({
              version: 1,
              workspace: { ...oldWorkspace, currentVersion: 1, versionId: "late-commit-v1" },
            });
        })
    )
  );
  await React.act(async () => {
    const textarea = first.host.querySelector("textarea");
    inputValue(textarea, "Keep late commit draft");
    textarea.focus();
    textarea.blur();
    await waitFor(() => !!finishApply);
  });
  assert.notEqual(happyWindow.localStorage.getItem(recoveryKey), null);
  await React.act(async () => {
    usePolicyStore.setState({ accountId: "commit-late-next-account", authGeneration: 2 });
    happyWindow.electronAPI = apiFor(newWorkspace);
    first.root.render(
      React.createElement(TranscriptStudioView, {
        noteId: 62,
        sourceTranscript: raw,
        canEdit: true,
      })
    );
    await waitFor(() => first.host.querySelector("textarea")?.value === "Deferred commit source");
    finishApply();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  assert.notEqual(happyWindow.localStorage.getItem(recoveryKey), null);
});

test("a retry completing after an account switch preserves its original recovery copy", async (t) => {
  const raw = '[{"text":"Deferred retry source"}]';
  const normalized = await normalizeTranscriptSource(raw);
  const oldWorkspace = {
    noteId: 63,
    sourceTranscript: raw,
    originalTranscript: raw,
    sourceHash: normalized.sourceHash,
    baselineSourceHash: normalized.sourceHash,
    currentVersion: 0,
    versionId: null,
    approvedOperations: [],
    stale: false,
  };
  const newWorkspace = { ...oldWorkspace, noteId: 64 };
  const previousPolicy = usePolicyStore.getState();
  usePolicyStore.setState({ accountId: "retry-late-account", authGeneration: 1 });
  const recoveryKey = `transcript-studio-recovery:retry-late-account:63:${normalized.sourceHash}`;
  const previousRecovery = happyWindow.localStorage.getItem(recoveryKey);
  happyWindow.localStorage.removeItem(recoveryKey);
  t.after(() => {
    usePolicyStore.setState(previousPolicy);
    if (previousRecovery === null) happyWindow.localStorage.removeItem(recoveryKey);
    else happyWindow.localStorage.setItem(recoveryKey, previousRecovery);
  });
  let attempts = 0;
  let finishRetry;
  const first = await mount(
    t,
    { noteId: 63, sourceTranscript: raw, canEdit: true },
    apiFor(oldWorkspace, async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("first write offline");
      return new Promise((resolve) => {
        finishRetry = () =>
          resolve({
            version: 1,
            workspace: { ...oldWorkspace, currentVersion: 1, versionId: "late-retry-v1" },
          });
      });
    })
  );
  await React.act(async () => {
    const textarea = first.host.querySelector("textarea");
    inputValue(textarea, "Keep late retry draft");
    textarea.focus();
    textarea.blur();
    await waitFor(() => first.host.textContent.includes("first write offline"));
  });
  const retry = [...first.host.querySelectorAll("button")].find((button) =>
    button.textContent.includes("Retry save")
  );
  await React.act(async () => retry.click());
  assert.equal(await waitFor(() => !!finishRetry), true);
  assert.notEqual(happyWindow.localStorage.getItem(recoveryKey), null);
  await React.act(async () => {
    usePolicyStore.setState({ accountId: "retry-late-next-account", authGeneration: 2 });
    happyWindow.electronAPI = apiFor(newWorkspace);
    first.root.render(
      React.createElement(TranscriptStudioView, {
        noteId: 64,
        sourceTranscript: raw,
        canEdit: true,
      })
    );
    await waitFor(() => first.host.querySelector("textarea")?.value === "Deferred retry source");
    finishRetry();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  assert.notEqual(happyWindow.localStorage.getItem(recoveryKey), null);
});

test("a pending save blocks a second edit until the first version is settled", async (t) => {
  const raw = '[{"text":"Pending save source"}]';
  const normalized = await normalizeTranscriptSource(raw);
  const workspace = {
    noteId: 65,
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
  usePolicyStore.setState({ accountId: "pending-edit-account", authGeneration: 5 });
  const recoveryKey = `transcript-studio-recovery:pending-edit-account:65:${normalized.sourceHash}`;
  const previousRecovery = happyWindow.localStorage.getItem(recoveryKey);
  happyWindow.localStorage.removeItem(recoveryKey);
  t.after(() => {
    usePolicyStore.setState(previousPolicy);
    if (previousRecovery === null) happyWindow.localStorage.removeItem(recoveryKey);
    else happyWindow.localStorage.setItem(recoveryKey, previousRecovery);
  });
  let finishApply;
  const writes = [];
  const { host } = await mount(
    t,
    { noteId: 65, sourceTranscript: raw, canEdit: true },
    apiFor(workspace, async (input) => {
      writes.push(input);
      return new Promise((resolve) => {
        finishApply = () =>
          resolve({
            version: 1,
            workspace: { ...workspace, currentVersion: 1, versionId: "pending-edit-v1" },
          });
      });
    })
  );
  const textarea = host.querySelector("textarea");
  await React.act(async () => {
    inputValue(textarea, "First pending edit");
    textarea.focus();
    textarea.blur();
    await waitFor(() => !!finishApply);
  });
  assert.equal(textarea.value, "First pending edit");
  assert.equal(textarea.readOnly, true, "the in-flight save locks out a conflicting second edit");
  const recovery = JSON.parse(happyWindow.localStorage.getItem(recoveryKey));
  assert.equal(recovery.workspace.segments[0].text, "First pending edit");

  await React.act(async () => {
    finishApply();
    await waitFor(() => host.textContent.includes("v1") && !textarea.readOnly);
  });
  assert.equal(textarea.value, "First pending edit");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].operations[0].after, "First pending edit");
  assert.equal(happyWindow.localStorage.getItem(recoveryKey), null);
});

test("proposal acceptance is locked during another pending save and retains the proposal", async (t) => {
  const raw = JSON.stringify([{ text: "First segment" }, { text: "Second segment" }]);
  const normalized = await normalizeTranscriptSource(raw);
  const workspace = {
    noteId: 66,
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
  usePolicyStore.setState({ accountId: "proposal-overlap-account", authGeneration: 3 });
  const proposalKey = `transcript-studio-proposals:proposal-overlap-account:66:${normalized.sourceHash}`;
  const previousProposalDraft = happyWindow.localStorage.getItem(proposalKey);
  happyWindow.localStorage.removeItem(proposalKey);
  t.after(() => {
    usePolicyStore.setState(previousPolicy);
    if (previousProposalDraft === null) happyWindow.localStorage.removeItem(proposalKey);
    else happyWindow.localStorage.setItem(proposalKey, previousProposalDraft);
  });
  const operation = {
    kind: "replaceText",
    segmentId: normalized.segments[1].id,
    before: "Second segment",
    after: "Proposed second segment",
  };
  const jobRunner = async function* () {
    yield {
      type: "chunkProposed",
      chunk: { id: "overlap-proposal", index: 0, segments: [], inputTokens: 1, outputTokens: 1 },
      candidate: { segments: [] },
      validation: { safe: true, warnings: [], edits: [operation] },
    };
    yield { type: "done", cancelled: false };
  };
  let finishApply;
  const writes = [];
  const { host } = await mount(
    t,
    { noteId: 66, sourceTranscript: raw, canEdit: true, jobRunner },
    apiFor(workspace, async (input) => {
      writes.push(input);
      return new Promise((resolve) => {
        finishApply = () =>
          resolve({
            version: 1,
            workspace: { ...workspace, currentVersion: 1, versionId: "proposal-overlap-v1" },
          });
      });
    })
  );
  const aiEdit = [...host.querySelectorAll("button")].find((button) =>
    button.textContent.includes("Edit transcript with AI")
  );
  await React.act(async () => aiEdit.click());
  assert.equal(
    await waitFor(() => !!host.querySelector('[data-proposal-chunk="overlap-proposal"]')),
    true
  );
  await React.act(async () => {
    const textarea = host.querySelector("textarea");
    inputValue(textarea, "First segment pending save");
    textarea.focus();
    textarea.blur();
    await waitFor(() => !!finishApply);
  });
  const accept = host.querySelector('button[aria-label="Accept proposal overlap-proposal"]');
  if (accept && !accept.disabled) await React.act(async () => accept.click());
  const storedBeforeSave = JSON.parse(happyWindow.localStorage.getItem(proposalKey)).proposals;
  assert.equal(
    storedBeforeSave.some((proposal) => proposal.chunk.id === "overlap-proposal"),
    true
  );

  await React.act(async () => {
    finishApply();
    await waitFor(
      () => host.textContent.includes("v1") && !host.querySelector("textarea").readOnly
    );
  });
  assert.equal(writes.length, 1);
  assert.ok(host.querySelector('[data-proposal-chunk="overlap-proposal"]'));
  const storedAfterSave = JSON.parse(happyWindow.localStorage.getItem(proposalKey)).proposals;
  assert.equal(
    storedAfterSave.some((proposal) => proposal.chunk.id === "overlap-proposal"),
    true
  );
});

test("a structurally invalid AI response leaves the transcript unchanged and offers retry", async (t) => {
  const raw = '[{"text":"Original transcript text."}]';
  const normalized = await normalizeTranscriptSource(raw);
  const workspace = {
    noteId: 67,
    sourceTranscript: raw,
    originalTranscript: raw,
    sourceHash: normalized.sourceHash,
    baselineSourceHash: normalized.sourceHash,
    currentVersion: 0,
    versionId: null,
    approvedOperations: [],
    stale: false,
  };
  const jobCalls = [];
  const jobRunner = async function* (params) {
    jobCalls.push(params.resumeFromChunk);
    if (jobCalls.length === 1) {
      yield {
        type: "failed",
        message: "The AI response was structurally incomplete or invalid.",
        chunkIndex: 0,
        resumeFromChunk: 0,
      };
      return;
    }
    yield { type: "done", completed: 0, total: 1 };
  };
  const { host } = await mount(
    t,
    { noteId: 67, sourceTranscript: raw, canEdit: true, jobRunner },
    apiFor(workspace)
  );
  const runButton = () =>
    [...host.querySelectorAll("button")].find((button) =>
      /Edit transcript with AI|Resume AI edit|Retry AI edit/i.test(button.textContent)
    );

  await React.act(async () => runButton().click());
  assert.equal(await waitFor(() => host.textContent.includes("structurally incomplete")), true);
  assert.equal(host.querySelector("textarea").value, "Original transcript text.");
  assert.equal(runButton().textContent, "Retry AI edit");

  await React.act(async () => runButton().click());
  assert.equal(await waitFor(() => jobCalls.length === 2), true);
  assert.deepEqual(jobCalls, [0, 0]);
  assert.equal(host.querySelector("textarea").value, "Original transcript text.");
});

test("undo stays blocked through a failed save and retry preserves the draft", async (t) => {
  const raw = '[{"text":"Undo retry source"}]';
  const normalized = await normalizeTranscriptSource(raw);
  const workspace = {
    noteId: 67,
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
  usePolicyStore.setState({ accountId: "undo-retry-account", authGeneration: 6 });
  const recoveryKey = `transcript-studio-recovery:undo-retry-account:67:${normalized.sourceHash}`;
  const previousRecovery = happyWindow.localStorage.getItem(recoveryKey);
  happyWindow.localStorage.removeItem(recoveryKey);
  t.after(() => {
    usePolicyStore.setState(previousPolicy);
    if (previousRecovery === null) happyWindow.localStorage.removeItem(recoveryKey);
    else happyWindow.localStorage.setItem(recoveryKey, previousRecovery);
  });
  let rejectFirst;
  let finishRetry;
  let attempts = 0;
  const { host } = await mount(
    t,
    { noteId: 67, sourceTranscript: raw, canEdit: true },
    apiFor(
      workspace,
      async () => {
        attempts += 1;
        if (attempts === 1)
          return new Promise((_resolve, reject) => {
            rejectFirst = () => reject(new Error("first write failed"));
          });
        return new Promise((resolve) => {
          finishRetry = () =>
            resolve({
              version: 1,
              workspace: { ...workspace, currentVersion: 1, versionId: "undo-retry-v1" },
            });
        });
      },
      async (_noteId, _versionId, expectedVersion) => ({
        ...workspace,
        currentVersion: expectedVersion + 1,
        versionId: "undo-retry-restored",
      })
    )
  );
  const textarea = host.querySelector("textarea");
  await React.act(async () => {
    inputValue(textarea, "Keep this dirty draft");
    textarea.focus();
    textarea.blur();
    await waitFor(() => !!rejectFirst);
  });
  const undo = [...host.querySelectorAll("button")].find((button) => button.textContent === "Undo");
  assert.equal(undo.disabled, true);
  await React.act(async () => {
    undo.click();
    rejectFirst();
    await waitFor(() => host.textContent.includes("first write failed"));
  });
  assert.equal(textarea.value, "Keep this dirty draft");
  assert.equal(
    JSON.parse(happyWindow.localStorage.getItem(recoveryKey)).workspace.segments[0].text,
    "Keep this dirty draft"
  );
  const retry = [...host.querySelectorAll("button")].find((button) =>
    button.textContent.includes("Retry save")
  );
  assert.ok(retry);
  await React.act(async () => {
    retry.click();
    await waitFor(() => !!finishRetry);
  });
  await React.act(async () => {
    finishRetry();
    await waitFor(() => host.textContent.includes("v1"));
  });
  assert.equal(textarea.value, "Keep this dirty draft");
  assert.equal(happyWindow.localStorage.getItem(recoveryKey), null);
});

test("a recovery storage write failure blocks database persistence but keeps the visible edit", async (t) => {
  const raw = '[{"text":"Storage failure source"}]';
  const normalized = await normalizeTranscriptSource(raw);
  const workspace = {
    noteId: 68,
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
  usePolicyStore.setState({ accountId: "storage-failure-account", authGeneration: 8 });
  const recoveryKey = `transcript-studio-recovery:storage-failure-account:68:${normalized.sourceHash}`;
  const store = happyWindow.localStorage;
  const originalSetItemDescriptor = Object.getOwnPropertyDescriptor(store, "setItem");
  const originalSetItem = store.setItem;
  let blockedKeyWrites = 0;
  Object.defineProperty(store, "setItem", {
    configurable: true,
    writable: true,
    value: function (key, value) {
      if (key === recoveryKey) {
        blockedKeyWrites += 1;
        throw new Error("local storage unavailable");
      }
      return originalSetItem.call(this, key, value);
    },
  });
  t.after(() => {
    if (originalSetItemDescriptor)
      Object.defineProperty(store, "setItem", originalSetItemDescriptor);
    else delete store.setItem;
    usePolicyStore.setState(previousPolicy);
  });
  let databaseWrites = 0;
  const { host } = await mount(
    t,
    { noteId: 68, sourceTranscript: raw, canEdit: true },
    apiFor(workspace, async () => {
      databaseWrites += 1;
      throw new Error("database unavailable");
    })
  );
  const textarea = host.querySelector("textarea");
  await React.act(async () => {
    inputValue(textarea, "Visible but not backed up");
    textarea.focus();
    textarea.blur();
    await waitFor(() => host.textContent.includes("Local recovery storage is unavailable"));
  });
  assert.equal(textarea.value, "Visible but not backed up");
  assert.ok(blockedKeyWrites > 0);
  assert.equal(databaseWrites, 0);
  assert.match(host.textContent, /only in this window/i);
});

test("invalid recovery JSON warns while retaining the persisted transcript", async (t) => {
  const raw = '[{"text":"Persisted after malformed recovery"}]';
  const normalized = await normalizeTranscriptSource(raw);
  const workspace = {
    noteId: 69,
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
  usePolicyStore.setState({ accountId: "recovery-read-account", authGeneration: 9 });
  const recoveryKey = `transcript-studio-recovery:recovery-read-account:69:${normalized.sourceHash}`;
  const previousRecovery = happyWindow.localStorage.getItem(recoveryKey);
  happyWindow.localStorage.setItem(recoveryKey, "{invalid-json");
  t.after(() => {
    usePolicyStore.setState(previousPolicy);
    if (previousRecovery === null) happyWindow.localStorage.removeItem(recoveryKey);
    else happyWindow.localStorage.setItem(recoveryKey, previousRecovery);
  });
  const { host } = await mount(
    t,
    { noteId: 69, sourceTranscript: raw, canEdit: true },
    apiFor(workspace)
  );
  assert.equal(host.querySelector("textarea").value, "Persisted after malformed recovery");
  assert.match(host.textContent, /could not be read/i);
});

test("recovery storage read errors warn while retaining the persisted transcript", async (t) => {
  const raw = '[{"text":"Persisted after recovery read error"}]';
  const normalized = await normalizeTranscriptSource(raw);
  const workspace = {
    noteId: 70,
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
  usePolicyStore.setState({ accountId: "recovery-read-error-account", authGeneration: 2 });
  const recoveryKey = `transcript-studio-recovery:recovery-read-error-account:70:${normalized.sourceHash}`;
  const store = happyWindow.localStorage;
  const originalGetItemDescriptor = Object.getOwnPropertyDescriptor(store, "getItem");
  const originalGetItem = store.getItem;
  Object.defineProperty(store, "getItem", {
    configurable: true,
    writable: true,
    value: function (key) {
      if (key === recoveryKey) throw new Error("local storage read failed");
      return originalGetItem.call(this, key);
    },
  });
  t.after(() => {
    if (originalGetItemDescriptor)
      Object.defineProperty(store, "getItem", originalGetItemDescriptor);
    else delete store.getItem;
    usePolicyStore.setState(previousPolicy);
  });
  const { host } = await mount(
    t,
    { noteId: 70, sourceTranscript: raw, canEdit: true },
    apiFor(workspace)
  );
  assert.equal(host.querySelector("textarea").value, "Persisted after recovery read error");
  assert.match(host.textContent, /could not be read/i);
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
