import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";

export type CliAdapterErrorCode =
  | "INVALID_ARGUMENTS"
  | "REMOTE_FLAG"
  | "SPAWN_ERROR"
  | "TIMEOUT"
  | "OUTPUT_LIMIT"
  | "CLI_EXIT"
  | "INVALID_JSON";

export class CliAdapterError extends Error {
  readonly code: CliAdapterErrorCode;

  constructor(code: CliAdapterErrorCode, message: string) {
    super(message);
    this.name = "CliAdapterError";
    this.code = code;
  }
}

export interface CliInvokeOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
}

type SpawnLike = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

interface CliInvokerDependencies {
  spawnImpl?: SpawnLike;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 5_000_000;

/** Build the local-only CLI invoker. The optional dependencies are for isolated tests. */
export function createCliInvoker({
  spawnImpl = nodeSpawn,
}: CliInvokerDependencies = {}) {
  return async function invokeLocalCli(
    args: readonly string[],
    options: CliInvokeOptions = {},
  ): Promise<unknown> {
    validateArgs(args);

    const timeoutMs = boundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1, MAX_TIMEOUT_MS);
    const maxOutputBytes = boundedInteger(
      options.maxOutputBytes,
      DEFAULT_MAX_OUTPUT_BYTES,
      1,
      MAX_OUTPUT_BYTES,
    );

    return new Promise((resolve, reject) => {
      let settled = false;
      let outputBytes = 0;
      let timer: NodeJS.Timeout | undefined;
      const stdoutChunks: Buffer[] = [];

      const childArgs = ["--local", ...args];
      let child: ChildProcess;

      const finish = (error: Error | null, value?: unknown) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
      };

      try {
        child = spawnImpl("openwhispr", childArgs, {
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch {
        finish(new CliAdapterError("SPAWN_ERROR", "Could not start the local OpenWhispr CLI."));
        return;
      }

      timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(new CliAdapterError("TIMEOUT", "The local OpenWhispr CLI timed out."));
      }, timeoutMs);
      timer.unref?.();

      const append = (chunk: Buffer | string, isStdout: boolean) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        outputBytes += buffer.byteLength;
        if (outputBytes > maxOutputBytes) {
          child.kill("SIGKILL");
          finish(new CliAdapterError("OUTPUT_LIMIT", "The local OpenWhispr CLI output exceeded its limit."));
          return;
        }
        if (isStdout) stdoutChunks.push(buffer);
      };

      child.stdout?.on("data", (chunk: Buffer | string) => append(chunk, true));
      child.stderr?.on("data", (chunk: Buffer | string) => append(chunk, false));
      child.once("error", () => {
        finish(new CliAdapterError("SPAWN_ERROR", "Could not start the local OpenWhispr CLI."));
      });
      child.once("close", (code) => {
        if (settled) return;
        if (code !== 0) {
          finish(new CliAdapterError("CLI_EXIT", "The local OpenWhispr CLI request failed."));
          return;
        }

        try {
          const stdout = Buffer.concat(stdoutChunks).toString("utf8");
          finish(null, JSON.parse(stdout));
        } catch {
          finish(new CliAdapterError("INVALID_JSON", "The local OpenWhispr CLI returned invalid JSON."));
        }
      });
    });
  };
}

export const invokeLocalCli = createCliInvoker();

function validateArgs(args: readonly string[]): void {
  if (!Array.isArray(args) || args.length === 0 || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
    throw new CliAdapterError("INVALID_ARGUMENTS", "CLI arguments must be non-empty strings without NUL bytes.");
  }

  if (args.some((arg) => arg === "--remote" || arg.startsWith("--remote="))) {
    throw new CliAdapterError("REMOTE_FLAG", "Remote CLI access is disabled for the local MCP server.");
  }
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new CliAdapterError("INVALID_ARGUMENTS", "CLI timeout and output limits are outside the allowed range.");
  }
  return value;
}
