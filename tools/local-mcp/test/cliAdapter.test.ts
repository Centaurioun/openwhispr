import assert from "node:assert/strict";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { CliAdapterError, createCliInvoker } from "../src/cliAdapter.js";

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: (signal?: NodeJS.Signals) => void;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  return child;
}

test("uses a fixed executable, local-only argv, and disables shell interpretation", async () => {
  const child = fakeChild();
  const observed: Array<{ command: string; args: string[]; options: SpawnOptions }> = [];
  const invoke = createCliInvoker({
    spawnImpl: (command, args, options) => {
      observed.push({ command, args, options });
      queueMicrotask(() => {
        child.stdout.end('{"items":[]}');
        child.emit("close", 0, null);
      });
      return child as unknown as ChildProcess;
    },
  });

  assert.deepEqual(await invoke(["notes", "search", "coffee; touch /tmp/pwned"]), { items: [] });
  assert.equal(observed[0]?.command, "openwhispr");
  assert.deepEqual(observed[0]?.args, ["--local", "notes", "search", "coffee; touch /tmp/pwned"]);
  assert.equal(observed[0]?.options.shell, false);
});

test("rejects remote backend selection before spawning", async () => {
  let spawned = false;
  const invoke = createCliInvoker({ spawnImpl: () => { spawned = true; return fakeChild() as unknown as ChildProcess; } });

  await assert.rejects(invoke(["notes", "list", "--remote"]), (error: unknown) => {
    assert.ok(error instanceof CliAdapterError);
    assert.equal(error.code, "REMOTE_FLAG");
    return true;
  });
  assert.equal(spawned, false);
});

test("reports backend exit without exposing stderr contents", async () => {
  const child = fakeChild();
  const invoke = createCliInvoker({
    spawnImpl: () => {
      queueMicrotask(() => {
        child.stderr.end("private note text");
        child.emit("close", 2, null);
      });
      return child as unknown as ChildProcess;
    },
  });

  await assert.rejects(invoke(["notes", "list"]), (error: unknown) => {
    assert.ok(error instanceof CliAdapterError);
    assert.equal(error.code, "CLI_EXIT");
    assert.doesNotMatch(error.message, /private note text/);
    return true;
  });
});

test("rejects invalid JSON with a typed error", async () => {
  const child = fakeChild();
  const invoke = createCliInvoker({
    spawnImpl: () => {
      queueMicrotask(() => {
        child.stdout.end("not-json");
        child.emit("close", 0, null);
      });
      return child as unknown as ChildProcess;
    },
  });

  await assert.rejects(invoke(["notes", "list"]), (error: unknown) => {
    assert.ok(error instanceof CliAdapterError);
    assert.equal(error.code, "INVALID_JSON");
    return true;
  });
});

test("rejects output beyond the byte limit and terminates the child", async () => {
  const child = fakeChild();
  let killed = false;
  child.kill = () => { killed = true; return true; };
  const invoke = createCliInvoker({
    spawnImpl: () => {
      queueMicrotask(() => child.stdout.write("123456"));
      return child as unknown as ChildProcess;
    },
  });

  await assert.rejects(invoke(["notes", "list"], { maxOutputBytes: 5 }), (error: unknown) => {
    assert.ok(error instanceof CliAdapterError);
    assert.equal(error.code, "OUTPUT_LIMIT");
    return true;
  });
  assert.equal(killed, true);
});

test("times out and terminates a child process", async () => {
  const child = fakeChild();
  let killed = false;
  child.kill = () => { killed = true; return true; };
  const invoke = createCliInvoker({ spawnImpl: () => child as unknown as ChildProcess });

  await assert.rejects(invoke(["notes", "list"], { timeoutMs: 10 }), (error: unknown) => {
    assert.ok(error instanceof CliAdapterError);
    assert.equal(error.code, "TIMEOUT");
    return true;
  });
  assert.equal(killed, true);
});
