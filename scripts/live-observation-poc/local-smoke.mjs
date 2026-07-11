import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
import { once } from "node:events";
import process from "node:process";
import { URL, URLSearchParams } from "node:url";

import { createApp } from "../../apps/api/src/app.ts";
import { createTrafficApp } from "../../apps/api/src/live-observation-poc/traffic-app.ts";
import { trafficReceiptSchema } from "../../apps/api/src/live-observation-poc/traffic-receipt-schema.ts";

const startedAt = Date.parse("2026-07-11T12:00:00.000Z");
const sessionTtlMs = 15 * 60 * 1000;
const audienceOrigin = "https://audience.local.example";
const apiOrigin = "https://api.local.example";

async function run() {
  let currentNow = startedAt;
  const api = createApp({
    config: {
      enabled: true,
      audienceOrigin,
      capability: {
        currentKid: "local-smoke",
        currentSecret: Buffer.alloc(32, 1),
      },
    },
    apiOrigin,
    now: () => currentNow,
    authorize: async () => true,
    loggerStream: { write() {} },
  });
  const traffic = createTrafficApp({
    instanceIdentity: async () => "local-smoke-traffic",
  });
  const streamAbortController = new globalThis.AbortController();

  try {
    const sessionResponse = await api.inject({
      method: "POST",
      url: "/api/live-observation-poc/sessions",
      headers: { authorization: "Bearer local-smoke-session" },
    });
    assert.equal(sessionResponse.statusCode, 201);
    const session = sessionResponse.json();
    const audienceUrl = new URL(session.audienceUrl);
    const fragment = new URLSearchParams(audienceUrl.hash.slice(1));
    const credential = fragment.get("capability");

    assert.equal(audienceUrl.origin, audienceOrigin);
    assert.equal(fragment.get("observationId"), session.observationId);
    assert.ok(credential);

    const streamResponse = await api.inject({
      method: "GET",
      url: `/api/live-observation-poc/sessions/${session.observationId}/stream`,
      headers: {
        authorization: "Bearer local-smoke-session",
        accept: "text/event-stream",
      },
      payloadAsStream: true,
      signal: streamAbortController.signal,
    });
    assert.equal(streamResponse.statusCode, 200);
    assert.equal(streamResponse.headers["content-type"], "text/event-stream");
    const snapshotChunk = once(streamResponse.stream(), "data");

    const trafficResponse = await traffic.inject({
      method: "POST",
      url: "/api/traffic",
    });
    assert.equal(trafficResponse.statusCode, 200);
    const receipt = trafficReceiptSchema.parse(trafficResponse.json());

    const collectorRequest = {
      method: "POST",
      url: `/api/live-observation-poc/public/${session.observationId}/events`,
      headers: {
        authorization: `LiveObservation ${credential}`,
        origin: audienceOrigin,
        "content-type": "application/json",
      },
      payload: receipt,
    };
    const acceptedResponse = await api.inject(collectorRequest);
    assert.equal(acceptedResponse.statusCode, 202);
    const accepted = acceptedResponse.json();
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.acceptedEventCount, 1);

    const [chunk] = await snapshotChunk;
    const snapshot = parseSnapshot(chunk);
    assert.equal(snapshot.observationId, session.observationId);
    assert.equal(snapshot.acceptedEventCount, 1);
    assert.equal(snapshot.lastReceipt?.eventId, receipt.eventId);

    const duplicateResponse = await api.inject(collectorRequest);
    assert.equal(duplicateResponse.statusCode, 200);
    const duplicate = duplicateResponse.json();
    assert.equal(duplicate.accepted, false);
    assert.equal(duplicate.acceptedEventCount, 1);

    currentNow += sessionTtlMs;
    const expiredResponse = await api.inject(collectorRequest);
    assert.equal(expiredResponse.statusCode, 410);
  } finally {
    streamAbortController.abort();
    await Promise.all([api.close(), traffic.close()]);
  }
}

function parseSnapshot(chunk) {
  assert.ok(Buffer.isBuffer(chunk));
  const event = chunk.toString("utf8");
  assert.ok(event.startsWith("event: snapshot\ndata: "));
  assert.ok(event.endsWith("\n\n"));

  return JSON.parse(event.slice("event: snapshot\ndata: ".length, -2));
}

run()
  .then(() => {
    process.stdout.write("Local live observation smoke passed.\n");
  })
  .catch(() => {
    process.stderr.write("Local live observation smoke failed.\n");
    process.exitCode = 1;
  });
