import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface RpcErrorData {
  code: number;
  message: string;
  data?: JsonValue;
}

export class RpcError extends Error {
  constructor(public readonly rpcCode: number, message: string, public readonly rpcData?: JsonValue) {
    super(message);
    this.name = "RpcError";
  }
}

export class RpcTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`Codex RPC ${method} timed out after ${timeoutMs}ms`);
    this.name = "RpcTimeoutError";
  }
}

export interface CodexProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface CodexClientOptions {
  command?: string;
  args?: string[];
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  spawnProcess?: (command: string, args: readonly string[]) => CodexProcess;
  onNotification?: (method: string, params: JsonValue | undefined) => void;
  onProtocolError?: (error: Error) => void;
  onStderr?: (text: string) => void;
}

interface PendingRequest {
  method: string;
  resolve: (value: JsonValue) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

interface RpcEnvelope {
  id?: number | string | null;
  method?: string;
  params?: JsonValue;
  result?: JsonValue;
  error?: RpcErrorData;
}

const defaultSpawner = (command: string, args: readonly string[]): ChildProcessWithoutNullStreams =>
  spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });

export class CodexAppServerClient {
  private readonly command: string;
  private readonly args: readonly string[];
  private readonly requestTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly spawnProcess: NonNullable<CodexClientOptions["spawnProcess"]>;
  private readonly pending = new Map<number, PendingRequest>();
  private process?: CodexProcess;
  private nextId = 1;
  private initialized = false;
  private stopping = false;
  private processError?: Error;

  constructor(private readonly options: CodexClientOptions = {}) {
    this.command = options.command ?? "codex";
    this.args = options.args ?? ["app-server", "--stdio"];
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000;
    this.spawnProcess = options.spawnProcess ?? defaultSpawner;
  }

  get isHealthy(): boolean {
    return this.initialized && this.process !== undefined && this.processError === undefined
      && this.process.exitCode === null && !this.process.stdin.destroyed;
  }

  async start(): Promise<void> {
    if (this.process) throw new Error("Codex app-server client has already been started");
    const child = this.spawnProcess(this.command, this.args);
    this.process = child;
    child.once("exit", (code, signal) => this.handleExit(code, signal));
    child.once("error", (error) => this.handleProcessError(error));
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.handleLine(line));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string | Buffer) => this.options.onStderr?.(chunk.toString()));

    try {
      await this.request("initialize", {
        clientInfo: { name: "codex-usage-service", title: "Codex Usage Service", version: "1.0.0" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      this.notify("initialized");
      this.initialized = true;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  request(method: string, params?: JsonValue, timeoutMs = this.requestTimeoutMs): Promise<JsonValue> {
    const child = this.process;
    if (!child || this.processError || child.exitCode !== null || child.stdin.destroyed) {
      return Promise.reject(this.processError ?? new Error("Codex app-server is not running"));
    }
    const id = this.nextId++;
    return new Promise<JsonValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcTimeoutError(method, timeoutMs));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { method, resolve, reject, timer });
      const message: Record<string, JsonValue> = { id, method };
      if (params !== undefined) message.params = params;
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error);
      });
    });
  }

  getUsage(): Promise<JsonValue> {
    return this.request("account/rateLimits/read");
  }

  async stop(): Promise<void> {
    const child = this.process;
    if (!child) return;
    this.stopping = true;
    this.initialized = false;
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
        resolve();
      }, this.shutdownTimeoutMs);
      timeout.unref();
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  private notify(method: string, params?: JsonValue): void {
    const child = this.process;
    if (!child || child.stdin.destroyed) throw new Error("Codex app-server is not running");
    const message: Record<string, JsonValue> = { method };
    if (params !== undefined) message.params = params;
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    if (line.trim() === "") return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (cause) {
      this.options.onProtocolError?.(new Error("Codex app-server emitted malformed JSON", { cause }));
      return;
    }
    if (!isRpcEnvelope(value)) {
      this.options.onProtocolError?.(new Error("Codex app-server emitted an invalid RPC message"));
      return;
    }
    if (value.id === undefined || value.id === null) {
      if (value.method) this.options.onNotification?.(value.method, value.params);
      return;
    }
    if (typeof value.id !== "number") return;
    const pending = this.pending.get(value.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(value.id);
    if (value.error) pending.reject(new RpcError(value.error.code, value.error.message, value.error.data));
    else if (value.result !== undefined) pending.resolve(value.result);
    else pending.reject(new Error(`Codex RPC ${pending.method} response had no result or error`));
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.initialized = false;
    const detail = signal ? `signal ${signal}` : `code ${String(code)}`;
    const error = new Error(`Codex app-server exited with ${detail}`);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (!this.stopping) this.options.onProtocolError?.(error);
  }

  private handleProcessError(error: Error): void {
    this.processError = error;
    this.initialized = false;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (!this.stopping) this.options.onProtocolError?.(error);
  }
}

function isRpcEnvelope(value: unknown): value is RpcEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if ("method" in record && typeof record.method !== "string") return false;
  if ("error" in record) {
    const error = record.error;
    if (typeof error !== "object" || error === null || Array.isArray(error)) return false;
    const rpcError = error as Record<string, unknown>;
    if (typeof rpcError.code !== "number" || typeof rpcError.message !== "string") return false;
  }
  return true;
}
