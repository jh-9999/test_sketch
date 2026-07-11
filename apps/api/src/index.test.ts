import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";

import type { FastifyInstance, FastifyRequest } from "fastify";

type HostLiveObservationAuthorizationGuard = {
  authorizeLiveObservation(
    request: FastifyRequest,
    observationId?: string,
  ): boolean | Promise<boolean>;
};

type RuntimeInput = {
  environment?: NodeJS.ProcessEnv;
  apiOrigin: string;
  hostGuard: HostLiveObservationAuthorizationGuard;
  loggerStream?: { write(message: string): void };
};

type RuntimeModule = {
  createApiRuntime(input: RuntimeInput): FastifyInstance;
  startApi(input: RuntimeInput & { host: string; port: number }): Promise<FastifyInstance>;
};

const runtime = (await import("./index.js")) as unknown as RuntimeModule;
const apiOrigin = "https://api.example";
const validEnvironment = {
  LIVE_OBSERVATION_POC_ENABLED: "true",
  LIVE_OBSERVATION_POC_AUDIENCE_ORIGIN: "https://audience.example",
  LIVE_OBSERVATION_POC_CURRENT_KID: "poc-20260711",
  LIVE_OBSERVATION_POC_CURRENT_SECRET: Buffer.alloc(32, 1).toString("base64url"),
};
const silentLogger = { write() {} };

function allowAllHostGuard(): HostLiveObservationAuthorizationGuard {
  return {
    authorizeLiveObservation: async () => true,
  };
}

test("does not register live observation routes when the parsed environment disables the PoC", async (t) => {
  const app = runtime.createApiRuntime({
    environment: { LIVE_OBSERVATION_POC_ENABLED: "false" },
    apiOrigin,
    hostGuard: allowAllHostGuard(),
    loggerStream: silentLogger,
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/api/live-observation-poc/sessions",
  });

  assert.equal(response.statusCode, 404);
});

test("adapts the host authentication and ownership guard for session creation and SSE ownership", async (t) => {
  const guardCalls: Array<{
    method: string;
    url: string;
    observationId: string | undefined;
  }> = [];
  const app = runtime.createApiRuntime({
    environment: validEnvironment,
    apiOrigin,
    hostGuard: {
      authorizeLiveObservation(request, observationId) {
        guardCalls.push({
          method: request.method,
          url: request.url,
          observationId,
        });
        return true;
      },
    },
    loggerStream: silentLogger,
  });
  t.after(() => app.close());

  const sessionResponse = await app.inject({
    method: "POST",
    url: "/api/live-observation-poc/sessions",
    headers: { authorization: "Bearer existing-host-session" },
  });
  assert.equal(sessionResponse.statusCode, 201);
  const { observationId } = sessionResponse.json<{ observationId: string }>();

  const abortController = new AbortController();
  t.after(() => abortController.abort());
  const streamResponse = await app.inject({
    method: "GET",
    url: `/api/live-observation-poc/sessions/${observationId}/stream`,
    headers: { authorization: "Bearer existing-host-session" },
    payloadAsStream: true,
    signal: abortController.signal,
  });

  assert.equal(streamResponse.statusCode, 200);
  assert.deepEqual(guardCalls, [
    {
      method: "POST",
      url: "/api/live-observation-poc/sessions",
      observationId: undefined,
    },
    {
      method: "GET",
      url: `/api/live-observation-poc/sessions/${observationId}/stream`,
      observationId,
    },
  ]);
});

test("fails closed when the host guard denies or throws", async (t) => {
  for (const authorizeLiveObservation of [
    () => false,
    () => {
      throw new Error("host authorization failed");
    },
  ]) {
    const app = runtime.createApiRuntime({
      environment: validEnvironment,
      apiOrigin,
      hostGuard: { authorizeLiveObservation },
      loggerStream: silentLogger,
    });
    t.after(() => app.close());

    const response = await app.inject({
      method: "POST",
      url: "/api/live-observation-poc/sessions",
      headers: { authorization: "Bearer existing-host-session" },
    });

    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json(), { error: "Invalid live observation request" });
  }
});

test("requires an explicit HTTPS API origin", () => {
  assert.throws(
    () =>
      runtime.createApiRuntime({
        environment: { LIVE_OBSERVATION_POC_ENABLED: "false" },
        apiOrigin: "http://api.example",
        hostGuard: allowAllHostGuard(),
        loggerStream: silentLogger,
      }),
    /HTTPS API origin/,
  );
});

test("starts the composed API runtime on the requested host and port", async (t) => {
  const app = await runtime.startApi({
    environment: { LIVE_OBSERVATION_POC_ENABLED: "false" },
    apiOrigin,
    hostGuard: allowAllHostGuard(),
    host: "127.0.0.1",
    port: 0,
    loggerStream: silentLogger,
  });
  t.after(() => app.close());

  const address = app.server.address();
  assert.ok(address && typeof address !== "string");
  assert.equal(address.address, "127.0.0.1");
  assert.ok(address.port > 0);
});
