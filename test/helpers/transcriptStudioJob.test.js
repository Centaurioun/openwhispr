const test = require("node:test");
const assert = require("node:assert/strict");

let startTranscriptEditJob;
test.before(async () => {
  ({ startTranscriptEditJob } =
    await import("../../src/custom-features/transcript-studio/process/transcriptEditJob.ts"));
});

const segment = (id, text, sourceIndex) => ({
  id,
  text,
  speakerId: null,
  speakerName: null,
  startSeconds: null,
  endSeconds: null,
  speakerLocked: false,
  sourceIndex,
});
function mockRuntime(overrides = {}) {
  let context = "acct-1";
  return {
    setContext(value) {
      context = value;
    },
    getSourceSegments: async () => [
      segment("a", "Ada spoke.", 0),
      segment("b", "The total is 42.", 1),
    ],
    captureContext: async () => context,
    contextIsCurrent: async (_note, _hash, captured) => captured === context,
    confirmRemote: async () => true,
    maxInputTokens: 48,
    processChunk: async (_text, _provider, _tokens, signal) => {
      if (signal.aborted) throw new Error("aborted");
      return JSON.stringify({
        segments: [
          { id: "a", text: "Ada spoke." },
          { id: "b", text: "The total is 42." },
        ],
      });
    },
    ...overrides,
  };
}
const input = (runtime, extra = {}) => ({
  noteId: 4,
  sourceHash: "hash",
  providerChoice: "local",
  strictMode: true,
  runtime,
  ...extra,
});
async function events(job) {
  const result = [];
  for await (const event of job) result.push(event);
  return result;
}

test("loading and uploading a transcript does not invoke reasoning; explicit job iteration does", async () => {
  let calls = 0;
  const runtime = mockRuntime({
    processChunk: async () => {
      calls += 1;
      return JSON.stringify({
        segments: [
          { id: "a", text: "Ada spoke." },
          { id: "b", text: "The total is 42." },
        ],
      });
    },
  });
  const job = startTranscriptEditJob(input(runtime));
  assert.equal(calls, 0);
  const result = await events(job);
  assert.equal(calls, 1);
  assert.ok(result.some((event) => event.type === "chunkProposed"));
});

test("a pre-aborted job exits before context capture, remote consent, or provider invocation", async () => {
  const calls = [];
  const runtime = mockRuntime({
    captureContext: async () => {
      calls.push("context");
      return "acct-1";
    },
    confirmRemote: async () => {
      calls.push("consent");
      return true;
    },
    processChunk: async () => {
      calls.push("provider");
      return "{}";
    },
  });
  const controller = new AbortController();
  controller.abort();
  const result = await events(
    startTranscriptEditJob(input(runtime, { providerChoice: "openai", signal: controller.signal }))
  );
  assert.deepEqual(result, [{ type: "done", completed: 0, total: 0, cancelled: true }]);
  assert.deepEqual(calls, []);
});

test("an abort during context validation is rechecked before provider invocation", async () => {
  const controller = new AbortController();
  let providerCalls = 0;
  let contextChecks = 0;
  const runtime = mockRuntime({
    contextIsCurrent: async () => {
      contextChecks += 1;
      if (contextChecks === 2) controller.abort();
      return true;
    },
    processChunk: async () => {
      providerCalls += 1;
      return "{}";
    },
  });
  const result = await events(
    startTranscriptEditJob(input(runtime, { signal: controller.signal }))
  );
  assert.equal(providerCalls, 0);
  assert.equal(result.at(-1).type, "done");
  assert.equal(result.at(-1).cancelled, true);
});

test("invalid output retries with a smaller output budget before proposing", async () => {
  const budgets = [];
  const runtime = mockRuntime({
    maxInputTokens: 512,
    processChunk: async (text, _provider, tokens) => {
      budgets.push(tokens);
      if (budgets.length === 1) return "{ truncated";
      const owned = JSON.parse(text).filter((item) => !item.contextOnly);
      return JSON.stringify({
        segments: owned.map(({ id }) => ({
          id,
          text: id === "a" ? "Ada spoke." : "The total is 42.",
        })),
      });
    },
  });
  const result = await events(startTranscriptEditJob(input(runtime)));
  assert.equal(result.filter((event) => event.type === "chunkProposed").length, 1);
  assert.equal(budgets.length, 3);
  assert.ok(budgets[1] < budgets[0]);
});

test("the next chunk waits until the caller drains proposal and progress events", async () => {
  let calls = 0;
  const runtime = mockRuntime({
    maxInputTokens: 32,
    getSourceSegments: async () => [
      segment("a", "Ada spoke.", 0),
      segment("b", "The total is 42.", 1),
      segment("c", "Meeting ends now.", 2),
    ],
    processChunk: async (text) => {
      calls += 1;
      const ids = JSON.parse(text)
        .filter((item) => !item.contextOnly)
        .map((item) => item.id);
      const texts = { a: "Ada spoke.", b: "The total is 42.", c: "Meeting ends now." };
      return JSON.stringify({ segments: ids.map((id) => ({ id, text: texts[id] })) });
    },
  });
  const iterator = startTranscriptEditJob(input(runtime))[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value.type, "chunkProposed");
  assert.equal(calls, 1);
  assert.equal((await iterator.next()).value.type, "progress");
  assert.equal(calls, 1);
  assert.equal((await iterator.next()).value.type, "chunkProposed");
  assert.equal(calls, 2);
  await iterator.return();
});

test("cancellation and late account or note changes discard proposals without touching approved data", async () => {
  const controller = new AbortController();
  const runtime = mockRuntime({
    processChunk: async (_text, _provider, _tokens, signal) => {
      controller.abort();
      assert.equal(signal.aborted, true);
      return JSON.stringify({
        segments: [
          { id: "a", text: "changed" },
          { id: "b", text: "The total is 42." },
        ],
      });
    },
  });
  const result = await events(
    startTranscriptEditJob(input(runtime, { signal: controller.signal }))
  );
  assert.equal(
    result.some((event) => event.type === "chunkProposed"),
    false
  );
  assert.equal(result.at(-1).cancelled, true);

  const changed = mockRuntime({
    processChunk: async () => {
      changed.setContext("acct-2");
      return JSON.stringify({
        segments: [
          { id: "a", text: "late" },
          { id: "b", text: "The total is 42." },
        ],
      });
    },
  });
  const late = await events(startTranscriptEditJob(input(changed)));
  assert.equal(
    late.some((event) => event.type === "chunkProposed"),
    false
  );
  assert.match(late.find((event) => event.type === "warning").message, /changed/i);
});

test("provider consent, invalid provider, and offline failures fail closed", async () => {
  let remoteConsentChecks = 0;
  const local = await events(
    startTranscriptEditJob(
      input(
        mockRuntime({
          confirmRemote: async () => {
            remoteConsentChecks += 1;
            return false;
          },
        })
      )
    )
  );
  assert.equal(
    local.some((event) => event.type === "chunkProposed"),
    true
  );
  assert.equal(remoteConsentChecks, 0);

  const refused = await events(
    startTranscriptEditJob(
      input(mockRuntime({ confirmRemote: async () => false }), { providerChoice: "openai" })
    )
  );
  assert.equal(
    refused.some((event) => event.type === "chunkProposed"),
    false
  );
  assert.equal(
    refused.some((event) => event.type === "warning"),
    true
  );

  const invalid = await events(
    startTranscriptEditJob(input(mockRuntime(), { providerChoice: "not-a-provider" }))
  );
  assert.equal(invalid[0].type, "failed");

  const offline = await events(
    startTranscriptEditJob(
      input(
        mockRuntime({
          processChunk: async () => {
            throw new Error("offline");
          },
        })
      )
    )
  );
  assert.equal(offline[0].type, "failed");
  assert.match(offline[0].message, /offline/);
  assert.equal(offline[0].resumeFromChunk, 0);
});

test("a missing or changed source fails before sending any chunk", async () => {
  let calls = 0;
  const runtime = mockRuntime({
    getSourceSegments: async () => {
      throw new Error("Transcript source changed");
    },
    processChunk: async () => {
      calls += 1;
      return "{}";
    },
  });
  const result = await events(startTranscriptEditJob(input(runtime)));
  assert.equal(result[0].type, "failed");
  assert.match(result[0].message, /source changed/i);
  assert.equal(calls, 0);
});

test("an account change while remote consent is pending prevents the request", async () => {
  let calls = 0;
  const runtime = mockRuntime({
    confirmRemote: async () => {
      runtime.setContext("acct-2");
      return true;
    },
    processChunk: async () => {
      calls += 1;
      return "{}";
    },
  });
  const result = await events(startTranscriptEditJob(input(runtime, { providerChoice: "openai" })));
  assert.equal(calls, 0);
  assert.equal(
    result.some((event) => event.type === "chunkProposed"),
    false
  );
  assert.match(result.find((event) => event.type === "warning").message, /changed/i);
});

test("a failed chunk can resume from the remaining chunk and work stays sequential", async () => {
  const calls = [];
  const runtime = mockRuntime({
    maxInputTokens: 32,
    getSourceSegments: async () => [
      segment("a", "Ada spoke.", 0),
      segment("b", "The total is 42.", 1),
      segment("c", "Meeting ends now.", 2),
    ],
    processChunk: async (text) => {
      const ids = JSON.parse(text)
        .filter((item) => !item.contextOnly)
        .map((item) => item.id);
      calls.push(ids);
      if (calls.length === 2) throw new Error("temporary outage");
      return JSON.stringify({
        segments: ids.map((id) => ({
          id,
          text: { a: "Ada spoke.", b: "The total is 42.", c: "Meeting ends now." }[id],
        })),
      });
    },
  });
  const first = await events(startTranscriptEditJob(input(runtime)));
  assert.equal(first[0].type, "chunkProposed");
  const failure = first.find((event) => event.type === "failed");
  assert.equal(failure.chunkIndex, 1);
  const resumed = await events(
    startTranscriptEditJob(input(runtime, { resumeFromChunk: failure.resumeFromChunk }))
  );
  assert.ok(resumed.some((event) => event.type === "chunkProposed"));
  assert.equal(resumed.find((event) => event.type === "chunkProposed").chunk.index, 1);
  assert.ok(resumed.some((event) => event.type === "done"));
  assert.ok(calls.every((ids) => ids.length > 0));
});

test("legacy plain-text fragments reassemble to one stable source-ID proposal", async () => {
  const raw = "A long plain transcript. ".repeat(100);
  const runtime = mockRuntime({
    maxInputTokens: 64,
    getSourceSegments: async () => [segment("plain-source", raw, 0)],
    processChunk: async (text) => {
      const owned = JSON.parse(text).filter((item) => !item.contextOnly);
      return JSON.stringify({
        segments: owned.map(({ id, text: value }) => ({ id, text: value })),
      });
    },
  });
  const result = await events(startTranscriptEditJob(input(runtime)));
  const proposals = result.filter((event) => event.type === "chunkProposed");
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].candidate.segments[0].id, "plain-source");
  assert.equal(proposals[0].candidate.segments[0].text, raw);
  assert.equal(proposals[0].validation.safe, true);
  assert.equal(proposals[0].validation.edits.length, 0);
});
