import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { CodexAppServerClient, RpcError, RpcTimeoutError, type CodexProcess } from "./codex-app-server-client.js";

class FakeProcess extends EventEmitter implements CodexProcess {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signalCode = signal;
    this.exitCode = 0;
    queueMicrotask(() => this.emit("exit", 0, signal));
    return true;
  }
}

async function nextMessage(stream: PassThrough): Promise<Record<string, unknown>> {
  const [chunk] = await once(stream, "data") as [Buffer];
  return JSON.parse(chunk.toString().trim()) as Record<string, unknown>;
}

async function startClient(options: ConstructorParameters<typeof CodexAppServerClient>[0] = {}) {
  const child = new FakeProcess();
  const client = new CodexAppServerClient({ ...options, spawnProcess: () => child });
  const started = client.start();
  const initialize = await nextMessage(child.stdin);
  child.stdout.write(`${JSON.stringify({ id: initialize.id, result: { userAgent: "test" } })}\n`);
  await started;
  const initialized = await nextMessage(child.stdin);
  assert.equal(initialized.method, "initialized");
  return { child, client };
}

test("initializes once and correlates concurrent responses by ID", async () => {
  const { child, client } = await startClient();
  const first = client.request("first");
  const firstMessage = await nextMessage(child.stdin);
  const second = client.request("second");
  const secondMessage = await nextMessage(child.stdin);
  child.stdout.write(`${JSON.stringify({ id: secondMessage.id, result: { order: 2 } })}\n`);
  child.stdout.write(`${JSON.stringify({ id: firstMessage.id, result: { order: 1 } })}\n`);
  assert.deepEqual(await first, { order: 1 });
  assert.deepEqual(await second, { order: 2 });
  await client.stop();
});

test("delivers notifications separately and ignores malformed JSON", async () => {
  const notifications: string[] = [];
  const errors: Error[] = [];
  const { child, client } = await startClient({
    onNotification: (method) => notifications.push(method),
    onProtocolError: (error) => errors.push(error),
  });
  child.stdout.write('{bad json\n');
  child.stdout.write(`${JSON.stringify({ method: "account/rateLimits/updated", params: {} })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(notifications, ["account/rateLimits/updated"]);
  assert.equal(errors.length, 1);
  await client.stop();
});

test("turns upstream errors into RpcError", async () => {
  const { child, client } = await startClient();
  const request = client.request("broken");
  const message = await nextMessage(child.stdin);
  child.stdout.write(`${JSON.stringify({ id: message.id, error: { code: -32000, message: "nope" } })}\n`);
  await assert.rejects(request, (error) => error instanceof RpcError && error.rpcCode === -32000);
  await client.stop();
});

test("times out requests and rejects pending work on exit", async () => {
  const { child, client } = await startClient({ requestTimeoutMs: 15 });
  const timedOut = client.request("slow");
  await nextMessage(child.stdin);
  await assert.rejects(timedOut, RpcTimeoutError);
  const pending = client.request("interrupted", undefined, 1_000);
  await nextMessage(child.stdin);
  child.exitCode = 1;
  child.emit("exit", 1, null);
  await assert.rejects(pending, /exited with code 1/);
  assert.equal(client.isHealthy, false);
});

test("rejects pending work when the child process errors", async () => {
  const { child, client } = await startClient();
  const pending = client.request("interrupted", undefined, 1_000);
  await nextMessage(child.stdin);
  child.emit("error", new Error("spawn failed"));
  await assert.rejects(pending, /spawn failed/);
  assert.equal(client.isHealthy, false);
  await client.stop();
});
