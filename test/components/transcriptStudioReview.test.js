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
    structurallyValid: true,
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
      structurallyValid: true,
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
  const confirmations = [];
  let allow = false;
  globalThis.window.confirm = (message) => {
    confirmations.push(message);
    return allow;
  };
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

test("bulk acceptance confirms every uncertain speaker proposal before any are persisted", async (t) => {
  const makeSpeakerProposal = (id, segmentId, speakerName) => ({
    ...proposal(id, segmentId, "Current source", "Current source"),
    uncertain: true,
    validation: {
      structurallyValid: true,
      safe: true,
      warnings: [],
      edits: [{ kind: "setSpeaker", segmentId, speakerId: id, speakerName, speakerLocked: true }],
    },
  });
  const pending = [
    makeSpeakerProposal("speaker-one", "source-0", "Ada"),
    makeSpeakerProposal("speaker-two", "source-1", "Lin"),
  ];
  const priorConfirm = globalThis.window.confirm;
  const accepted = [];
  const confirmations = [];
  let allow = false;
  globalThis.window.confirm = (message) => {
    confirmations.push(message);
    return allow;
  };
  t.after(() => {
    globalThis.window.confirm = priorConfirm;
  });
  const host = await render(t, pending, { onAccept: async (...args) => accepted.push(args) });
  const bulkAccept = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Accept all"
  );

  await React.act(async () => bulkAccept.click());
  assert.deepEqual(accepted, [], "cancellation must leave all speaker proposals pending");
  assert.ok(
    confirmations[0].includes("2"),
    "confirmation must state the number of speaker assignments covered"
  );
  assert.match(confirmations[0], /uncertain|speaker/i);
  assert.ok(host.querySelector('[data-proposal-chunk="speaker-one"]'));
  assert.ok(host.querySelector('[data-proposal-chunk="speaker-two"]'));

  allow = true;
  await React.act(async () => bulkAccept.click());
  assert.deepEqual(accepted[0][0], ["speaker-one", "speaker-two"]);
  assert.deepEqual(
    accepted[0][1].map((operation) => operation.speakerLocked),
    [true, true]
  );
});

test("unsafe proposals are excluded from bulk accept and need explicit individual review", async (t) => {
  const unsafe = {
    ...proposal("unsafe", "source-0", "Current source", "A meaning-changing suggestion"),
    validation: {
      structurallyValid: true,
      safe: false,
      warnings: ["Possible content omission; review this proposal manually."],
      edits: [
        {
          kind: "replaceText",
          segmentId: "source-0",
          before: "Current source",
          after: "A meaning-changing suggestion",
        },
      ],
    },
  };
  const safe = proposal("safe", "source-1", "Second source", "Second source.");
  const accepted = [];
  const priorConfirm = globalThis.window.confirm;
  const confirmations = [];
  globalThis.window.confirm = (message) => {
    confirmations.push(message);
    return true;
  };
  t.after(() => {
    globalThis.window.confirm = priorConfirm;
  });
  const host = await render(t, [unsafe, safe], {
    onAccept: async (...args) => accepted.push(args),
  });

  await React.act(async () =>
    [...host.querySelectorAll("button")]
      .find((button) => button.textContent === "Accept all")
      .click()
  );
  assert.deepEqual(accepted, [[["safe"], safe.validation.edits]]);
  assert.match(host.textContent, /Possible content omission/);
  const manual = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Accept after manual review"
  );
  assert.ok(manual);
  await React.act(async () => manual.click());
  assert.match(confirmations.at(-1), /manually reviewed/i);
  assert.equal(accepted.length, 2);
  assert.deepEqual(accepted[1][0], ["unsafe"]);
});

test("structurally invalid proposals with partial edits have no acceptance path", async (t) => {
  const malformed = {
    ...proposal("malformed", "source-0", "Current source", "Partial suggestion"),
    validation: {
      structurallyValid: false,
      safe: false,
      warnings: ["One or more source blocks are missing; incomplete output cannot be approved."],
      edits: [
        {
          kind: "replaceText",
          segmentId: "source-0",
          before: "Current source",
          after: "Partial suggestion",
        },
      ],
    },
  };
  const safe = proposal("safe", "source-1", "Second source", "Second source.");
  const accepted = [];
  const priorConfirm = globalThis.window.confirm;
  globalThis.window.confirm = () => true;
  t.after(() => {
    globalThis.window.confirm = priorConfirm;
  });
  const host = await render(t, [malformed, safe], {
    onAccept: async (...args) => accepted.push(args),
  });

  assert.equal(
    host.querySelector('[aria-label="Accept proposal malformed after manual review"]'),
    null,
    "structural invalidity must not expose the semantic manual-review action"
  );
  await React.act(async () =>
    [...host.querySelectorAll("button")]
      .find((button) => button.textContent === "Accept all")
      .click()
  );
  assert.deepEqual(accepted, [[["safe"], safe.validation.edits]]);
});

test("bulk confirmation counts every locked speaker operation inside one proposal", async (t) => {
  const multiSpeaker = {
    ...proposal("multi-speaker", "source-0", "Current source", "Current source"),
    uncertain: true,
    validation: {
      structurallyValid: true,
      safe: true,
      warnings: [],
      edits: [
        {
          kind: "setSpeaker",
          segmentId: "source-0",
          speakerId: "speaker-a",
          speakerName: "Ada",
          speakerLocked: true,
        },
        {
          kind: "setSpeaker",
          segmentId: "source-1",
          speakerId: "speaker-b",
          speakerName: "Lin",
          speakerLocked: true,
        },
      ],
    },
  };
  const priorConfirm = globalThis.window.confirm;
  const accepted = [];
  const confirmations = [];
  globalThis.window.confirm = (message) => {
    confirmations.push(message);
    return false;
  };
  t.after(() => {
    globalThis.window.confirm = priorConfirm;
  });
  const host = await render(t, [multiSpeaker], {
    onAccept: async (...args) => accepted.push(args),
  });
  const bulkAccept = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Accept all"
  );
  await React.act(async () => bulkAccept.click());

  assert.match(confirmations[0], /2 uncertain speaker assignments/);
  assert.deepEqual(accepted, []);
  assert.ok(host.querySelector('[data-proposal-chunk="multi-speaker"]'));
});

test("uncertain-only speaker proposals require confirmation individually and in bulk", async (t) => {
  const uncertainOnly = {
    ...proposal("uncertain-only", "source-0", "Current source", "Current source"),
    uncertain: true,
    validation: {
      structurallyValid: true,
      safe: true,
      warnings: [],
      edits: [
        {
          kind: "replaceText",
          segmentId: "source-0",
          before: "Current source",
          after: "Reviewed source",
        },
      ],
    },
  };
  const priorConfirm = globalThis.window.confirm;
  const accepted = [];
  const confirmations = [];
  let allow = false;
  globalThis.window.confirm = (message) => {
    confirmations.push(message);
    return allow;
  };
  t.after(() => {
    globalThis.window.confirm = priorConfirm;
  });
  const host = await render(t, [uncertainOnly], {
    onAccept: async (...args) => accepted.push(args),
  });

  await React.act(async () =>
    host.querySelector('[aria-label="Accept proposal uncertain-only"]').click()
  );
  assert.deepEqual(accepted, []);
  assert.match(confirmations[0], /uncertain speaker suggestion/);
  assert.doesNotMatch(confirmations[0], /will lock|assignments/);
  assert.ok(host.querySelector('[data-proposal-chunk="uncertain-only"]'));
  await React.act(async () =>
    [...host.querySelectorAll("button")]
      .find((button) => button.textContent === "Accept all")
      .click()
  );
  assert.deepEqual(accepted, []);
  assert.equal(confirmations.length, 2);
  assert.ok(host.querySelector('[data-proposal-chunk="uncertain-only"]'));
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
        structurallyValid: true,
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
  for (let attempt = 0; attempt < 50 && host.querySelector("textarea").value !== raw; attempt++) {
    await React.act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  }
  assert.equal(host.querySelector("textarea").value, raw);
  assert.ok(host.querySelector('[data-proposal-chunk="chunk-1"]'));
  assert.match(host.textContent, /changed in another window/);
});
