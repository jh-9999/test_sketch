import { randomUUID } from "node:crypto";

import type {
  LiveObservationPocSnapshot,
  TrafficReceipt,
} from "@sketchcatch/types";

const SESSION_TTL_MS = 15 * 60 * 1000;

export type LiveObservationPocSession = {
  observationId: string;
  status: "active" | "expired";
  capabilityKid: string;
  tokenVersion: 1;
  createdAt: string;
  expiresAt: string;
  acceptedEventCount: number;
  lastReceipt: TrafficReceipt | null;
};

type SessionListener = (snapshot: LiveObservationPocSnapshot) => void;

type StoredSession = {
  session: LiveObservationPocSession;
  expiresAtMs: number;
  acceptedEventIds: Set<string>;
  listeners: Set<SessionListener>;
};

export function createInMemoryLiveObservationPocStore(input: {
  now: () => number;
  capabilityKid: string;
}): {
  createSession(): LiveObservationPocSession;
  readSession(observationId: string): LiveObservationPocSession | null;
  collectReceipt(input: {
    observationId: string;
    receipt: TrafficReceipt;
  }): "accepted" | "duplicate" | "not_found" | "expired";
  subscribe(
    observationId: string,
    listener: (snapshot: LiveObservationPocSnapshot) => void,
  ): () => void;
} {
  const sessions = new Map<string, StoredSession>();

  return {
    createSession() {
      const createdAtMs = input.now();
      const expiresAtMs = createdAtMs + SESSION_TTL_MS;
      const observationId = randomUUID();
      const session: LiveObservationPocSession = {
        observationId,
        status: "active",
        capabilityKid: input.capabilityKid,
        tokenVersion: 1,
        createdAt: new Date(createdAtMs).toISOString(),
        expiresAt: new Date(expiresAtMs).toISOString(),
        acceptedEventCount: 0,
        lastReceipt: null,
      };

      sessions.set(observationId, {
        session,
        expiresAtMs,
        acceptedEventIds: new Set(),
        listeners: new Set(),
      });

      return copySession(session, createdAtMs, expiresAtMs);
    },

    readSession(observationId) {
      const stored = sessions.get(observationId);
      if (!stored) {
        return null;
      }

      return copySession(stored.session, input.now(), stored.expiresAtMs);
    },

    collectReceipt({ observationId, receipt }) {
      const stored = sessions.get(observationId);
      if (!stored) {
        return "not_found";
      }

      const observedAtMs = input.now();
      if (observedAtMs >= stored.expiresAtMs) {
        return "expired";
      }
      if (stored.acceptedEventIds.has(receipt.eventId)) {
        return "duplicate";
      }

      stored.acceptedEventIds.add(receipt.eventId);
      stored.session.acceptedEventCount += 1;
      stored.session.lastReceipt = copyReceipt(receipt);
      const snapshot: LiveObservationPocSnapshot = {
        observationId,
        status: "active",
        acceptedEventCount: stored.session.acceptedEventCount,
        lastReceipt: copyReceipt(stored.session.lastReceipt),
        observedAt: new Date(observedAtMs).toISOString(),
      };

      for (const listener of stored.listeners) {
        listener(copySnapshot(snapshot));
      }

      return "accepted";
    },

    subscribe(observationId, listener) {
      const stored = sessions.get(observationId);
      if (!stored) {
        return () => {};
      }

      stored.listeners.add(listener);
      return () => {
        stored.listeners.delete(listener);
      };
    },
  };
}

function copySession(
  session: LiveObservationPocSession,
  now: number,
  expiresAtMs: number,
): LiveObservationPocSession {
  return {
    ...session,
    status: now >= expiresAtMs ? "expired" : "active",
    lastReceipt: copyReceipt(session.lastReceipt),
  };
}

function copySnapshot(snapshot: LiveObservationPocSnapshot): LiveObservationPocSnapshot {
  return {
    ...snapshot,
    lastReceipt: copyReceipt(snapshot.lastReceipt),
  };
}

function copyReceipt(receipt: TrafficReceipt | null): TrafficReceipt | null {
  return receipt ? { ...receipt } : null;
}
