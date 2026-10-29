const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer } = require("../lib/rendererTestHarness");

let React;
let Window;
let ProposalReview;
let TranscriptStudioView;
let normalizeTranscriptSource;

test.before(async (t) => {
  ({ Window } = await import("happy-dom"));
  const window = new Window();
  for (const name of [
    "window",
    "document",
    "navigator",
    "Node",
    "Element",
    "HTMLElement",
    "Event",
    "MouseEvent",
    "MutationObserver",
    "getComputedStyle",
  ]) {
    Object.defineProperty(globalThis, name, {
      value: name === "window" ? window : window[name],
      configurable: true,
      writable: true,
    });
  }
  React = require("react");
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const vite = await createRendererServer(t);
  ({ ProposalReview } = await vite.ssrLoadModule(
    "/custom-features/transcript-studio/components/ProposalReview.tsx"
  ));
  ({ TranscriptStudioView } = await vite.ssrLoadModule(
    "/custom-features/transcript-studio/components/TranscriptStudioView.tsx"
  ));
  ({ normalizeTranscriptSource } = await vite.ssrLoadModule(
    "/custom-features/transcript-studio/domain/normalizeSource.ts"
  ));
  t.after(() => window.happyDOM.close());
});

const proposal = (id, segmentId, before, after, baseVersion = 2) => ({
  type: "chunkProposed",
  chunk: {
    id,
    index: 0,
    segments: [{ id: segmentId, text: before }],
    inputTokens: 1,
    outputTokens: 1,
  },
  candidate: { segments: [{ id: segmentId, text: after }] },
  validation: {
    safe: true,
    warnings: [],
    edits: [{ kind: "replaceText", segmentId, before, after }],
  },
  baseVersion,
});

async function render(t, proposals, overrides = {}) {
  const { createRoot } = require("react-dom/client");
  const window = globalThis.window;
  const rootNode = window.document.createElement("div");
  window.document.body.appendChild(rootNode);
  const root = createRoot(rootNode);
  t.after(async () => {
    await React.act(async () => root.unmount());
    rootNode.remove();
  });
  const normalized = await normalizeTranscriptSource(
    JSON.stringify([{ text: "Current source" }, { text: "Second source" }])
  );
  const props = {
    proposals,
    workspace: {
      ...normalized,
      segments: normalized.segments.map((segment, index) => ({
        ...segment,
        id: `source-${index}`,
      })),
    },
    currentVersion: 2,
    canEdit: true,
    onAccept: async () => {},
    onReject: () => {},
    onRereview: () => {},
    ...overrides,
  };
  await React.act(async () => root.render(React.createElement(ProposalReview, props)));
  return rootNode;
}

test("accept one proposal emits only its operation; keyboard native button is available", async (t) => {
  const pending = proposal("one", "source-0", "Current source", "Current source.");
  const accepted = [];
  const host = await render(t, [pending], { onAccept: async (...args) => accepted.push(args) });
  const button = host.querySelector('[aria-label="Accept proposal one"]');
  assert.ok(button);
  assert.equal(button.tagName, "BUTTON");
  await React.act(async () =>
    button.dispatchEvent(new globalThis.window.MouseEvent("click", { bubbles: true }))
  );
  assert.deepEqual(accepted[0][0], ["one"]);
  assert.deepEqual(accepted[0][1], pending.validation.edits);
});

test("accept all submits one combined edit transaction", async (t) => {
  const one = proposal("one", "source-0", "Current source", "Current source.");
  const two = proposal("two", "source-1", "Second source", "Second source!");
  const accepted = [];
  const host = await render(t, [one, two], { onAccept: async (...args) => accepted.push(args) });
  await React.act(async () =>
    [...host.querySelectorAll("button")]
      .find((button) => button.textContent === "Accept all")
      .click()
  );
  assert.deepEqual(accepted[0][0], ["one", "two"]);
  assert.equal(accepted[0][1].length, 2);
});

test("reject one and reject all report the selected proposal IDs", async (t) => {
  const rejected = [];
  const host = await render(t, [proposal("one", "source-0", "Current source", "Current source.")], {
    onReject: (ids) => rejected.push(ids),
  });
  await React.act(async () => host.querySelector('[aria-label="Reject proposal one"]').click());
  await React.act(async () =>
    [...host.querySelectorAll("button")]
      .find((button) => button.textContent === "Reject all")
      .click()
  );
  assert.deepEqual(rejected, [["one"], ["one"]]);
});

test("stale proposal cannot be accepted until explicit re-review rebases it", async (t) => {
  const pending = proposal("one", "source-0", "Old source", "Suggested source", 1);
  const accepted = [];
  const rereviewed = [];
  const host = await render(t, [pending], {
    currentVersion: 2,
    onAccept: async (...args) => accepted.push(args),
    onRereview: (...args) => rereviewed.push(args),
  });
  assert.match(host.textContent, /changed since this proposal/);
  assert.equal(host.querySelector('[aria-label="Accept proposal one"]'), null);
  await React.act(async () =>
    [...host.querySelectorAll("button")]
      .find((button) => button.textContent === "Review changes")
      .click()
  );
  assert.equal(rereviewed[0][0], "one");
  assert.equal(rereviewed[0][1][0].before, "Current source");
  assert.deepEqual(accepted, []);
});

test("speaker suggestions are marked uncertain and require explicit confirmation", async (t) => {
  const pending = {
    ...proposal("speaker", "source-0", "Current source", "Current source"),
    validation: {
      safe: true,
      warnings: [],
      edits: [
        {
          kind: "setSpeaker",
          segmentId: "source-0",
          speakerId: "speaker-1",
          speakerName: "Ada",
          speakerLocked: true,
        },
      ],
    },
  };
  const priorConfirm = globalThis.window.confirm;
  const accepted = [];
  let allow = false;
  globalThis.window.confirm = () => allow;
  t.after(() => {
    globalThis.window.confirm = priorConfirm;
  });
  const host = await render(t, [pending], { onAccept: async (...args) => accepted.push(args) });
  assert.match(host.textContent, /uncertain suggestion/);
  const accept = host.querySelector('[aria-label="Accept proposal speaker"]');
  await React.act(async () => accept.click());
  assert.equal(accepted.length, 0);
  allow = true;
  await React.act(async () => accept.click());
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0][1][0].speakerLocked, true);
});

test("pending proposals stay visible during the next chunk and failed approval rolls back", async (t) => {
  const { createRoot } = require("react-dom/client");
  const window = globalThis.window;
  const raw = "Original text";
  const normalized = await normalizeTranscriptSource(raw);
  window.electronAPI = {
    getTranscriptWorkspace: async () => ({
      noteId: 88,
      sourceTranscript: raw,
      originalTranscript: raw,
      sourceHash: normalized.sourceHash,
      baselineSourceHash: normalized.sourceHash,
      currentVersion: 0,
      versionId: null,
      approvedOperations: [],
      stale: false,
    }),
    listTranscriptVersions: async () => [
      { versionId: `baseline:${normalized.sourceHash}`, version: 0 },
    ],
    applyTranscriptRevision: async () => ({ conflict: true }),
    restoreTranscriptVersion: async () => {
      throw new Error("unexpected restore");
    },
  };
  let releaseNext;
  const waitingForNextChunk = new Promise((resolve) => {
    releaseNext = resolve;
  });
  async function* jobRunner() {
    yield {
      type: "chunkProposed",
      chunk: {
        id: "chunk-1",
        index: 0,
        segments: [{ id: normalized.segments[0].id, text: raw }],
        inputTokens: 1,
        outputTokens: 1,
      },
      candidate: { segments: [{ id: normalized.segments[0].id, text: "Proposed text" }] },
      validation: {
        safe: true,
        warnings: [],
        edits: [
          {
            kind: "replaceText",
            segmentId: normalized.segments[0].id,
            before: raw,
            after: "Proposed text",
          },
        ],
      },
    };
    await waitingForNextChunk;
    yield { type: "progress", completed: 1, total: 2, chunkIndex: 0 };
  }
  const host = window.document.createElement("div");
  window.document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => {
    releaseNext();
    await React.act(async () => root.unmount());
    host.remove();
  });
  await React.act(async () =>
    root.render(
      React.createElement(TranscriptStudioView, {
        noteId: 88,
        sourceTranscript: raw,
        canEdit: true,
        jobRunner,
      })
    )
  );
  for (let attempt = 0; attempt < 50 && !host.querySelector("textarea"); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  await React.act(async () =>
    [...host.querySelectorAll("button")]
      .find((button) => button.textContent.includes("Edit transcript with AI"))
      .click()
  );
  for (
    let attempt = 0;
    attempt < 50 && !host.querySelector('[data-proposal-chunk="chunk-1"]');
    attempt++
  )
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(host.querySelector('[data-proposal-chunk="chunk-1"]'));
  assert.match(host.textContent, /Cancel AI edit/);
  await React.act(async () => host.querySelector('[aria-label="Accept proposal chunk-1"]').click());
  assert.equal(host.querySelector("textarea").value, raw);
  assert.ok(host.querySelector('[data-proposal-chunk="chunk-1"]'));
  assert.match(host.textContent, /changed in another window/);
});
