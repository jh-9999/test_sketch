import { randomUUID } from "node:crypto";

import type { TrafficReceipt } from "@sketchcatch/types";
import Fastify, { type FastifyInstance } from "fastify";

import type { InstanceIdentity } from "./instance-identity.js";

export type CreateTrafficAppDependencies = {
  instanceIdentity: InstanceIdentity;
};

export function createTrafficApp(dependencies: CreateTrafficAppDependencies): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get("/health", async () => ({ status: "ok" }));

  app.post("/api/traffic", async (_request, reply) => {
    const receipt: TrafficReceipt = {
      eventId: randomUUID(),
      instanceId: await dependencies.instanceIdentity(),
      receivedAt: new Date().toISOString(),
    };

    return reply.header("Cache-Control", "no-store").send(receipt);
  });

  return app;
}
