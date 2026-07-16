import { execFile } from "node:child_process";

export interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandRunner {
  run(file: string, args: readonly string[]): Promise<ProcessResult>;
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
            reject(
              new Error(`${file} exited unsuccessfully: ${stderr.trim() || error.message}`, {
                cause: error,
              }),
            );
            return;
          }
          resolve({ stdout, stderr });
        },
      );
    });
  }
}
