import { execFile } from "node:child_process";

export interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandRunner {
  run(file: string, args: readonly string[]): Promise<ProcessResult>;
}

export type ProcessFailureKind = "exit" | "spawn" | "timeout" | "signal" | "process";

/** Structured process failure so callers never infer semantics from error text. */
export class ProcessExecutionError extends Error {
  readonly kind: ProcessFailureKind;
  readonly exitCode: number | undefined;
  readonly stderr: string;

  constructor(
    message: string,
    options: {
      readonly kind: ProcessFailureKind;
      readonly exitCode?: number;
      readonly stderr?: string;
      readonly cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = "ProcessExecutionError";
    this.kind = options.kind;
    this.exitCode = options.exitCode;
    this.stderr = options.stderr ?? "";
  }
}

export interface ExecFileRunnerOptions {
  readonly timeoutMs?: number;
  readonly maxBufferBytes?: number;
  readonly env?: NodeJS.ProcessEnv;
}

/** Process runner that never invokes a shell. */
export class ExecFileRunner implements CommandRunner {
  readonly #options: ExecFileRunnerOptions;

  constructor(options: ExecFileRunnerOptions = {}) {
    this.#options = options;
  }

  run(file: string, args: readonly string[]): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      execFile(
        file,
        [...args],
        {
          shell: false,
          encoding: "utf8",
          timeout: this.#options.timeoutMs ?? 10_000,
          maxBuffer: this.#options.maxBufferBytes ?? 1024 * 1024,
          ...(this.#options.env ? { env: this.#options.env } : {}),
        },
        (error, stdout, stderr) => {
          if (error) {
            const code = error.code;
            const kind: ProcessFailureKind = error.killed
              ? "timeout"
              : typeof code === "number"
                ? "exit"
                : error.signal
                  ? "signal"
                  : typeof code === "string"
                    ? "spawn"
                    : "process";
            reject(
              new ProcessExecutionError(
                `${file} exited unsuccessfully: ${stderr.trim() || error.message}`,
                {
                  kind,
                  ...(typeof code === "number" ? { exitCode: code } : {}),
                  stderr,
                  cause: error,
                },
              ),
            );
            return;
          }
          resolve({ stdout, stderr });
        },
      );
    });
  }
}
