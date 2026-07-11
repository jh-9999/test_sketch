import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { once } from "node:events";
import test from "node:test";
import { Writable } from "node:stream";

import type { TrafficReceipt } from "@sketchcatch/types";
import Fastify, { type FastifyInstance } from "fastify";

import { createApp } from "../app.js";
import type { LiveObservationPocConfig } from "../config/env.js";
import { issueCapability, verifyCapability } from "./capability.js";
import { createInMemoryLiveObservationPocStore } from "./observation-store.js";
import { registerLiveObservationPocRoutes } from "./routes.js";

const startedAt = Date.parse("2026-07-11T12:00:00.000Z");
const audienceOrigin = "https://audience.example";
const apiOrigin = "https://api.example";
const capability = {
  currentKid: "poc-20260711",
  currentSecret: Buffer.alloc(32, 1),
};
const publicError = { error: "Invalid live observation request" };

type RouteAppOptions = {
  authorize?: (request: unknown, observationId?: string) => Promise<boolean>;
  now?: () => number;
};

function createRouteApp(options: RouteAppOptions = {}) {
  let currentNow = startedAt;
  const store = createInMemoryLiveObservationPocStore({
    now: options.now ?? (() => currentNow),
    capabilityKid: capability.currentKid,
  });
  const app = Fastify({ logger: false });

  registerLiveObservationPocRoutes(app, {
    store,
    audienceOrigin,
    apiOrigin,
    capability,
    now: options.now ?? (() => currentNow),
    ...(options.authorize ? { authorize: options.authorize } : {}),
  });

  return {
    app,
    store,
    setNow(nextNow: number) {
      currentNow = nextNow;
    },
  };
}

function receipt(eventId: string): TrafficReceipt {
  return {
    eventId,
    instanceId: "i-0123456789abcdef0",
    receivedAt: "2026-07-11T12:00:01.000Z",
  };
}

function capabilityFor(
  store: ReturnType<typeof createInMemoryLiveObservationPocStore>,
  observationId: string,
): string {
  const session = store.readSession(observationId);
  assert.ok(session);

  return issueCapability({
    ...capability,
    observationId: session.observationId,
    tokenVersion: session.tokenVersion,
    expiresAt: session.expiresAt,
  });
}

function collectorHeaders(credential: string, origin?: string): Record<string, string> {
  return {
    authorization: `LiveObservation ${credential}`,
    "content-type": "application/json",
    ...(origin ? { origin } : {}),
  };
}

function exactSizedReceipt(eventId: string, byteLength: number): TrafficReceipt {
  const base = receipt(eventId);
  const emptyInstance = { ...base, instanceId: "" };
  const instanceLength = byteLength - Buffer.byteLength(JSON.stringify(emptyInstance));
  const sizedReceipt = { ...base, instanceId: "i".repeat(instanceLength) };

  assert.equal(Buffer.byteLength(JSON.stringify(sizedReceipt)), byteLength);
  return sizedReceipt;
}

async function createSession(app: FastifyInstance) {
  const response = await app.inject({
    method: "POST",
    url: "/api/live-observation-poc/sessions",
    headers: { authorization: "Bearer test-session" },
  });

  assert.equal(response.statusCode, 201);
  return response.json<{
    observationId: string;
    createdAt: string;
    expiresAt: string;
    audienceUrl: string;
    streamUrl: string;
  }>();
}

test("does not register any live observation PoC route when the flag is false", async (t) => {
  const config: LiveObservationPocConfig = { enabled: false };
  const app = createApp({
    config,
    apiOrigin,
    now: () => startedAt,
  });
  t.after(() => app.close());

  for (const [method, url] of [
    ["POST", "/api/live-observation-poc/sessions"],
    ["POST", "/api/live-observation-poc/public/missing/events"],
    ["GET", "/api/live-observation-poc/sessions/missing/stream"],
  ] as const) {
    const response = await app.inject({ method, url });
    assert.equal(response.statusCode, 404);
  }
});

test("creates an authorized session with the prescribed fragment URLs and issued capability", async (t) => {
  const authorizerCalls: Array<string | undefined> = [];
  const { app, store } = createRouteApp({
    authorize: async (_request, observationId) => {
      authorizerCalls.push(observationId);
      return true;
    },
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/api/live-observation-poc/sessions",
    headers: { authorization: "Bearer test-session" },
  });

  assert.equal(response.statusCode, 201);
  const body = response.json<{
    observationId: string;
    createdAt: string;
    expiresAt: string;
    audienceUrl: string;
    streamUrl: string;
  }>();
  assert.deepEqual(authorizerCalls, [undefined]);
  assert.equal(
    body.audienceUrl,
    `${audienceOrigin}/#observationId=${body.observationId}&collector=${encodeURIComponent(apiOrigin)}&capability=${new URL(body.audienceUrl).hash.split("capability=")[1]}`,
  );
  assert.equal(
    body.streamUrl,
    `${apiOrigin}/api/live-observation-poc/sessions/${body.observationId}/stream`,
  );

  const fragment = new URLSearchParams(new URL(body.audienceUrl).hash.slice(1));
  const credential = fragment.get("capability");
  assert.ok(credential);
  const session = store.readSession(body.observationId);
  assert.ok(session);
  assert.equal(
    verifyCapability({
      ...capability,
      credential,
      observationId: session.observationId,
      tokenVersion: session.tokenVersion,
      expiresAt: session.expiresAt,
      now: startedAt,
    }),
    true,
  );
});

test("fails closed with a generic 401 when the session authorizer is missing", async (t) => {
  const { app } = createRouteApp();
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/api/live-observation-poc/sessions",
    headers: { authorization: "Bearer raw-session-token" },
  });

  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.json(), publicError);
  assert.doesNotMatch(response.payload, /raw-session-token/);
});

test("returns 202 and publishes one snapshot when the public collector accepts a receipt", async (t) => {
  const { app, store } = createRouteApp({ authorize: async () => true });
  t.after(() => app.close());
  const session = await createSession(app);
  const snapshots: TrafficReceipt[] = [];
  store.subscribe(session.observationId, (snapshot) => {
    snapshots.push(snapshot.lastReceipt!);
  });
  const credential = capabilityFor(store, session.observationId);

  const response = await app.inject({
    method: "POST",
    url: `/api/live-observation-poc/public/${session.observationId}/events`,
    headers: collectorHeaders(credential, audienceOrigin),
    payload: receipt("69f6bb55-2af2-4787-b36d-0df45cd8e57b"),
  });

  assert.equal(response.statusCode, 202);
  assert.deepEqual(response.json(), { accepted: true, acceptedEventCount: 1 });
  assert.equal(response.headers["access-control-allow-origin"], audienceOrigin);
  assert.deepEqual(snapshots, [receipt("69f6bb55-2af2-4787-b36d-0df45cd8e57b")]);
});

test("returns 200 for a duplicate event without publishing another snapshot", async (t) => {
  const { app, store } = createRouteApp({ authorize: async () => true });
  t.after(() => app.close());
  const session = await createSession(app);
  const snapshots: TrafficReceipt[] = [];
  store.subscribe(session.observationId, (snapshot) => {
    snapshots.push(snapshot.lastReceipt!);
  });
  const credential = capabilityFor(store, session.observationId);
  const event = receipt("f4fb0347-690b-4591-b6e0-a8af12ca878e");

  const first = await app.inject({
    method: "POST",
    url: `/api/live-observation-poc/public/${session.observationId}/events`,
    headers: collectorHeaders(credential),
    payload: event,
  });
  const duplicate = await app.inject({
    method: "POST",
    url: `/api/live-observation-poc/public/${session.observationId}/events`,
    headers: collectorHeaders(credential),
    payload: event,
  });

  assert.equal(first.statusCode, 202);
  assert.equal(duplicate.statusCode, 200);
  assert.deepEqual(duplicate.json(), { accepted: false, acceptedEventCount: 1 });
  assert.deepEqual(snapshots, [event]);
});

test("checks a malformed capability before the Zod receipt schema and returns generic 401", async (t) => {
  const { app, store } = createRouteApp({ authorize: async () => true });
  t.after(() => app.close());
  const session = await createSession(app);

  const response = await app.inject({
    method: "POST",
    url: `/api/live-observation-poc/public/${session.observationId}/events`,
    headers: collectorHeaders("invalid.credential"),
    payload: { eventId: "not-a-uuid", instanceId: "", receivedAt: "not-a-date" },
  });

  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.json(), publicError);
  assert.equal(store.readSession(session.observationId)?.acceptedEventCount, 0);
});

test("returns generic 400 for an invalid receipt after capability verification", async (t) => {
  const { app, store } = createRouteApp({ authorize: async () => true });
  t.after(() => app.close());
  const session = await createSession(app);
  const credential = capabilityFor(store, session.observationId);

  const response = await app.inject({
    method: "POST",
    url: `/api/live-observation-poc/public/${session.observationId}/events`,
    headers: collectorHeaders(credential),
    payload: { eventId: "not-a-uuid", instanceId: "", receivedAt: "2026-07-11" },
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), publicError);
  assert.equal(store.readSession(session.observationId)?.acceptedEventCount, 0);
});

test("returns the generic public error for malformed collector JSON", async (t) => {
  const { app, store } = createRouteApp({ authorize: async () => true });
  t.after(() => app.close());
  const session = await createSession(app);
  const credential = capabilityFor(store, session.observationId);

  const response = await app.inject({
    method: "POST",
    url: `/api/live-observation-poc/public/${session.observationId}/events`,
    headers: collectorHeaders(credential, audienceOrigin),
    payload: "not-valid-json",
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), publicError);
  assert.equal(response.headers["access-control-allow-origin"], audienceOrigin);
});

test("checks an invalid capability before malformed or oversized collector bodies", async (t) => {
  const { app, store } = createRouteApp({ authorize: async () => true });
  t.after(() => app.close());
  const session = await createSession(app);
  const invalidHeaders = collectorHeaders("invalid.credential", audienceOrigin);

  const malformed = await app.inject({
    method: "POST",
    url: `/api/live-observation-poc/public/${session.observationId}/events`,
    headers: invalidHeaders,
    payload: "not-valid-json",
  });
  const oversized = await app.inject({
    method: "POST",
    url: `/api/live-observation-poc/public/${session.observationId}/events`,
    headers: invalidHeaders,
    payload: exactSizedReceipt("3777515f-61c4-40d4-acdf-7cae7f17855a", 1025),
  });

  for (const response of [malformed, oversized]) {
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json(), publicError);
    assert.equal(response.headers["access-control-allow-origin"], audienceOrigin);
  }
  assert.equal(store.readSession(session.observationId)?.acceptedEventCount, 0);
});

test("looks up missing and expired observations before parsing malformed collector bodies", async (t) => {
  const { app, store, setNow } = createRouteApp({ authorize: async () => true });
  t.after(() => app.close());
  const activeSession = await createSession(app);
  setNow(startedAt + 15 * 60 * 1000);
  const headers = collectorHeaders("invalid.credential", audienceOrigin);

  const missing = await app.inject({
    method: "POST",
    url: "/api/live-observation-poc/public/missing/events",
    headers,
    payload: "not-valid-json",
  });
  const expired = await app.inject({
    method: "POST",
    url: `/api/live-observation-poc/public/${activeSession.observationId}/events`,
    headers,
    payload: "not-valid-json",
  });

  assert.equal(missing.statusCode, 404);
  assert.deepEqual(missing.json(), publicError);
  assert.equal(missing.headers["access-control-allow-origin"], audienceOrigin);
  assert.equal(expired.statusCode, 410);
  assert.deepEqual(expired.json(), publicError);
  assert.equal(expired.headers["access-control-allow-origin"], audienceOrigin);
  assert.equal(store.readSession(activeSession.observationId)?.acceptedEventCount, 0);
});

test("keeps unrelated JSON parser errors outside the collector's generic error scope", async (t) => {
  const { app } = createRouteApp({ authorize: async () => true });
  t.after(() => app.close());
  app.post("/unrelated-json", async () => ({ ok: true }));

  const response = await app.inject({
    method: "POST",
    url: "/unrelated-json",
    headers: { "content-type": "application/json" },
    payload: "not-valid-json",
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json<{ code: string }>().code, "FST_ERR_CTP_INVALID_JSON_BODY");
});

test("looks up a missing observation before capability verification and returns generic 404", async (t) => {
  const { app } = createRouteApp({ authorize: async () => true });
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/api/live-observation-poc/public/missing/events",
    headers: collectorHeaders("invalid.credential"),
    payload: receipt("4799178c-3240-4af0-aa84-54410331e867"),
  });

  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json(), publicError);
});

test("returns generic 410 for an expired observation before capability verification", async (t) => {
  const { app, store, setNow } = createRouteApp({ authorize: async () => true });
  t.after(() => app.close());
  const session = await createSession(app);
  setNow(startedAt + 15 * 60 * 1000);

  const response = await app.inject({
    method: "POST",
    url: `/api/live-observation-poc/public/${session.observationId}/events`,
    headers: collectorHeaders("invalid.credential"),
    payload: receipt("5de53f97-7406-469d-a57e-08f7fcf46598"),
  });

  assert.equal(response.statusCode, 410);
  assert.deepEqual(response.json(), publicError);
  assert.equal(store.readSession(session.observationId)?.acceptedEventCount, 0);
});

test("applies the exact 1024-byte body limit only to the public collector", async (t) => {
  const { app, store } = createRouteApp({ authorize: async () => true });
  t.after(() => app.close());
  const session = await createSession(app);
  const credential = capabilityFor(store, session.observationId);
  const atLimit = exactSizedReceipt("6aa854d9-cf23-4f78-a4cf-5d5975688ec2", 1024);
  const overLimit = exactSizedReceipt("cda4a1cf-f9c7-4e66-9a5b-a05cf32200e8", 1025);

  const accepted = await app.inject({
    method: "POST",
    url: `/api/live-observation-poc/public/${session.observationId}/events`,
    headers: collectorHeaders(credential),
    payload: atLimit,
  });
  const rejected = await app.inject({
    method: "POST",
    url: `/api/live-observation-poc/public/${session.observationId}/events`,
    headers: collectorHeaders(credential),
    payload: overLimit,
  });
  const unaffectedSession = await app.inject({
    method: "POST",
    url: "/api/live-observation-poc/sessions",
    headers: { "content-type": "application/json" },
    payload: { padding: "x".repeat(1_100) },
  });

  assert.equal(accepted.statusCode, 202);
  assert.equal(rejected.statusCode, 413);
  assert.deepEqual(rejected.json(), publicError);
  assert.equal(unaffectedSession.statusCode, 201);
});

test("allows CORS only for the exact configured audience origin", async (t) => {
  const { app, store } = createRouteApp({ authorize: async () => true });
  t.after(() => app.close());
  const session = await createSession(app);
  const credential = capabilityFor(store, session.observationId);
  const exact = await app.inject({
    method: "OPTIONS",
    url: `/api/live-observation-poc/public/${session.observationId}/events`,
    headers: {
      origin: audienceOrigin,
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization, content-type",
    },
  });
  const arbitrary = await app.inject({
    method: "OPTIONS",
    url: `/api/live-observation-poc/public/${session.observationId}/events`,
    headers: {
      origin: "https://attacker.example",
      "access-control-request-method": "POST",
    },
  });
  const noOrigin = await app.inject({
    method: "POST",
    url: `/api/live-observation-poc/public/${session.observationId}/events`,
    headers: collectorHeaders(credential),
    payload: receipt("77717a9f-04b0-40a0-8ac1-b8af985410c6"),
  });

  assert.equal(exact.statusCode, 204);
  assert.equal(exact.headers["access-control-allow-origin"], audienceOrigin);
  assert.equal(exact.headers["access-control-allow-methods"], "POST, OPTIONS");
  assert.equal(exact.headers["access-control-allow-headers"], "Authorization, Content-Type");
  assert.equal(arbitrary.statusCode, 204);
  assert.equal(arbitrary.headers["access-control-allow-origin"], undefined);
  assert.equal(noOrigin.headers["access-control-allow-origin"], undefined);
});

test("authorizes the SSE route for the requested observation and writes accepted snapshots", async (t) => {
  const authorizerCalls: Array<string | undefined> = [];
  const { app, store } = createRouteApp({
    authorize: async (_request, observationId) => {
      authorizerCalls.push(observationId);
      return true;
    },
  });
  t.after(async () => {
    await app.close();
  });
  const session = await createSession(app);
  const credential = capabilityFor(store, session.observationId);

  const abortController = new AbortController();
  const streamResponse = await app.inject({
    method: "GET",
    url: `/api/live-observation-poc/sessions/${session.observationId}/stream`,
    headers: {
      authorization: "Bearer test-session",
      accept: "text/event-stream",
    },
    payloadAsStream: true,
    signal: abortController.signal,
  });
  assert.equal(streamResponse.statusCode, 200);
  assert.equal(streamResponse.headers["content-type"], "text/event-stream");
  assert.equal(streamResponse.headers["cache-control"], "no-cache");
  assert.equal(streamResponse.headers.connection, "keep-alive");
  assert.deepEqual(authorizerCalls, [undefined, session.observationId]);

  const snapshotChunk = once(streamResponse.stream(), "data");
  const accepted = await app.inject({
    method: "POST",
    url: `/api/live-observation-poc/public/${session.observationId}/events`,
    headers: collectorHeaders(credential),
    payload: receipt("b7a87d1e-79ad-4a3e-a030-c6c0dfba221a"),
  });
  assert.equal(accepted.statusCode, 202);
  const [chunk] = await snapshotChunk;
  assert.equal(
    chunk.toString(),
    `event: snapshot\ndata: ${JSON.stringify({
      observationId: session.observationId,
      status: "active",
      acceptedEventCount: 1,
      lastReceipt: receipt("b7a87d1e-79ad-4a3e-a030-c6c0dfba221a"),
      observedAt: new Date(startedAt).toISOString(),
    })}\n\n`,
  );

  abortController.abort();
});

test("fails closed with generic 401 for an SSE request when the authorizer is missing", async (t) => {
  const { app, store } = createRouteApp({ authorize: async () => true });
  t.after(() => app.close());
  const session = await createSession(app);

  const unguarded = Fastify({ logger: false });
  registerLiveObservationPocRoutes(unguarded, {
    store,
    audienceOrigin,
    apiOrigin,
    capability,
    now: () => startedAt,
  });
  t.after(() => unguarded.close());

  const response = await unguarded.inject({
    method: "GET",
    url: `/api/live-observation-poc/sessions/${session.observationId}/stream`,
    headers: { authorization: "Bearer raw-session-token" },
  });

  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.json(), publicError);
  assert.doesNotMatch(response.payload, /raw-session-token/);
});

test("redacts authorization, cookie, and set-cookie values in the API logger stream", async (t) => {
  const captured: string[] = [];
  const loggerStream = new Writable({
    write(chunk, _encoding, callback) {
      captured.push(chunk.toString());
      callback();
    },
  });
  const app = createApp({
    config: { enabled: false },
    apiOrigin,
    now: () => startedAt,
    loggerStream,
  });
  t.after(() => app.close());
  app.get("/logger-redaction-check", async (_request, reply) => {
    reply.header("set-cookie", "session=raw-set-cookie-value");
    return { ok: true };
  });

  const response = await app.inject({
    method: "GET",
    url: "/logger-redaction-check",
    headers: {
      authorization: "Bearer raw-authorization-value",
      cookie: "session=raw-cookie-value",
    },
  });
  assert.equal(response.statusCode, 200);

  const logs = captured.join("");
  assert.doesNotMatch(logs, /raw-authorization-value/);
  assert.doesNotMatch(logs, /raw-cookie-value/);
  assert.doesNotMatch(logs, /raw-set-cookie-value/);
  assert.match(logs, /"authorization":"\[REDACTED\]"/);
  assert.match(logs, /"cookie":"\[REDACTED\]"/);
  assert.match(logs, /"set-cookie":"\[REDACTED\]"/);
});
