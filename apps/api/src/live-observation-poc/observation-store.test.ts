import assert from "node:assert/strict";
import test from "node:test";

import type { TrafficReceipt } from "@sketchcatch/types";

import { createInMemoryLiveObservationPocStore } from "./observation-store.js";

const start = Date.parse("2026-07-11T12:00:00.000Z");
const capabilityKid = "poc-20260711";

function receipt(eventId: string): TrafficReceipt {
  return {
    eventId,
    instanceId: "i-0123456789abcdef0",
    receivedAt: "2026-07-11T12:00:01.000Z",
  };
}

function createStore(initialNow = start, advanceAfterClockRead = false) {
  let currentNow = initialNow;
  let clockCallCount = 0;
  const store = createInMemoryLiveObservationPocStore({
    now: () => {
      clockCallCount += 1;
      const clockValue = currentNow;
      if (advanceAfterClockRead) {
        currentNow += 1;
      }
      return clockValue;
    },
    capabilityKid,
  });

  return {
    store,
    setNow(nextNow: number) {
      currentNow = nextNow;
    },
    getClockCallCount() {
      return clockCallCount;
    },
    resetClockCallCount() {
      clockCallCount = 0;
    },
  };
}

test("creates an active session with fixed capability metadata and a 15-minute absolute expiry", () => {
  const { store } = createStore();

  const session = store.createSession();

  assert.match(
    session.observationId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  );
  assert.deepEqual(session, {
    observationId: session.observationId,
    status: "active",
    capabilityKid,
    tokenVersion: 1,
    createdAt: "2026-07-11T12:00:00.000Z",
    expiresAt: "2026-07-11T12:15:00.000Z",
    acceptedEventCount: 0,
    lastReceipt: null,
  });
});

test("returns null for a missing session and expired for collection at the exact expiry boundary", () => {
  const { store, setNow } = createStore();
  const session = store.createSession();

  assert.equal(store.readSession("missing"), null);
  assert.equal(
    store.collectReceipt({ observationId: "missing", receipt: receipt("missing-event") }),
    "not_found",
  );

  setNow(start + 15 * 60 * 1000);

  assert.equal(store.readSession(session.observationId)?.status, "expired");
  assert.equal(
    store.collectReceipt({
      observationId: session.observationId,
      receipt: receipt("expired-event"),
    }),
    "expired",
  );
});

test("accepts a unique receipt once, records its count and last receipt, and deduplicates its event ID", () => {
  const { store } = createStore();
  const session = store.createSession();
  const firstReceipt = receipt("event-1");

  assert.equal(
    store.collectReceipt({
      observationId: session.observationId,
      receipt: firstReceipt,
    }),
    "accepted",
  );
  assert.equal(
    store.collectReceipt({
      observationId: session.observationId,
      receipt: { ...firstReceipt, instanceId: "i-duplicate" },
    }),
    "duplicate",
  );

  assert.deepEqual(store.readSession(session.observationId), {
    ...session,
    acceptedEventCount: 1,
    lastReceipt: firstReceipt,
  });
});

test("protects stored sessions from mutations to receipt inputs and read results", () => {
  const { store } = createStore();
  const session = store.createSession();
  const inputReceipt = receipt("event-1");

  assert.equal(
    store.collectReceipt({
      observationId: session.observationId,
      receipt: inputReceipt,
    }),
    "accepted",
  );
  inputReceipt.instanceId = "i-mutated-input";

  const readResult = store.readSession(session.observationId)!;
  readResult.acceptedEventCount = 999;
  readResult.lastReceipt!.instanceId = "i-mutated-read";

  assert.deepEqual(store.readSession(session.observationId), {
    ...session,
    acceptedEventCount: 1,
    lastReceipt: receipt("event-1"),
  });
});

test("notifies subscribers synchronously with independent snapshots only for accepted receipts", () => {
  const { store, setNow, getClockCallCount, resetClockCallCount } = createStore(
    start,
    true,
  );
  const session = store.createSession();
  const firstListenerSnapshots: Array<{
    acceptedEventCount: number;
    instanceId: string;
    observedAt: string;
  }> = [];
  const secondListenerSnapshots: Array<{
    acceptedEventCount: number;
    instanceId: string;
    observedAt: string;
  }> = [];

  store.subscribe(session.observationId, (snapshot) => {
    firstListenerSnapshots.push({
      acceptedEventCount: snapshot.acceptedEventCount,
      instanceId: snapshot.lastReceipt!.instanceId,
      observedAt: snapshot.observedAt,
    });
    snapshot.acceptedEventCount = 999;
    snapshot.lastReceipt!.instanceId = "i-mutated-listener";
  });
  store.subscribe(session.observationId, (snapshot) => {
    secondListenerSnapshots.push({
      acceptedEventCount: snapshot.acceptedEventCount,
      instanceId: snapshot.lastReceipt!.instanceId,
      observedAt: snapshot.observedAt,
    });
  });

  setNow(start + 1_000);
  resetClockCallCount();
  assert.equal(
    store.collectReceipt({
      observationId: session.observationId,
      receipt: receipt("event-1"),
    }),
    "accepted",
  );
  assert.equal(getClockCallCount(), 1);
  assert.deepEqual(firstListenerSnapshots, [
    {
      acceptedEventCount: 1,
      instanceId: "i-0123456789abcdef0",
      observedAt: new Date(start + 1_000).toISOString(),
    },
  ]);
  assert.deepEqual(secondListenerSnapshots, [
    {
      acceptedEventCount: 1,
      instanceId: "i-0123456789abcdef0",
      observedAt: new Date(start + 1_000).toISOString(),
    },
  ]);
  assert.deepEqual(store.readSession(session.observationId)?.lastReceipt, receipt("event-1"));

  assert.equal(
    store.collectReceipt({
      observationId: session.observationId,
      receipt: receipt("event-1"),
    }),
    "duplicate",
  );
  assert.equal(
    store.collectReceipt({ observationId: "missing", receipt: receipt("missing-event") }), "not_found");
  setNow(start + 15 * 60 * 1000);
  assert.equal(
    store.collectReceipt({
      observationId: session.observationId,
      receipt: receipt("expired-event"),
    }),
    "expired",
  );
  assert.equal(firstListenerSnapshots.length, 1);
  assert.equal(secondListenerSnapshots.length, 1);
});

test("stops a listener after unsubscribe", () => {
  const { store } = createStore();
  const session = store.createSession();
  let notificationCount = 0;

  const unsubscribe = store.subscribe(session.observationId, () => {
    notificationCount += 1;
  });
  unsubscribe();

  assert.equal(
    store.collectReceipt({
      observationId: session.observationId,
      receipt: receipt("event-1"),
    }),
    "accepted",
  );
  assert.equal(notificationCount, 0);
});

test("never refreshes the session TTL during reads, subscriptions, or receipt collection", () => {
  const { store, setNow } = createStore();
  const session = store.createSession();
  const originalExpiry = session.expiresAt;

  setNow(start + 60_000);
  assert.equal(store.readSession(session.observationId)?.expiresAt, originalExpiry);

  setNow(start + 2 * 60_000);
  store.subscribe(session.observationId, () => {});
  assert.equal(store.readSession(session.observationId)?.expiresAt, originalExpiry);

  setNow(start + 3 * 60_000);
  assert.equal(
    store.collectReceipt({
      observationId: session.observationId,
      receipt: receipt("event-1"),
    }),
    "accepted",
  );
  assert.equal(store.readSession(session.observationId)?.expiresAt, originalExpiry);

  setNow(start + 15 * 60 * 1000);
  assert.equal(store.readSession(session.observationId)?.status, "expired");
});
