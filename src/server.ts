import Fastify, { type FastifyInstance } from "fastify";
import { CodexAppServerClient, RpcError, RpcTimeoutError } from "./codex-app-server-client.js";

export interface BuildServerOptions {
  client?: CodexAppServerClient;
  logger?: boolean;
}

export async function buildServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? true });
  const client = options.client ?? new CodexAppServerClient({
    onProtocolError: (error) => app.log.error({ err: error }, "Codex app-server protocol error"),
    onStderr: (text) => app.log.debug({ codex: text.trimEnd() }, "Codex app-server stderr"),
  });

  app.get("/healthz", async (_request, reply) => {
    if (!client.isHealthy) return reply.code(503).send({ status: "unhealthy", codexAppServer: "disconnected" });
    return { status: "ok", codexAppServer: "connected" };
  });

  app.get("/usage", async (_request, reply) => {
    try {
      return await client.getUsage();
    } catch (error) {
      app.log.error({ err: error }, "Unable to read Codex usage");
      if (error instanceof RpcTimeoutError) return reply.code(504).send({ error: error.message });
      if (error instanceof RpcError) {
        return reply.code(502).send({ error: error.message, upstreamCode: error.rpcCode, upstreamData: error.rpcData });
      }
      return reply.code(503).send({ error: "Codex app-server is unavailable" });
    }
  });

  app.addHook("onClose", async () => client.stop());
  await client.start();
  return app;
}
