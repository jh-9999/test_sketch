import assert from "node:assert/strict";
import test from "node:test";

import type {
  CollectLiveObservationPocEventRequest,
  CollectLiveObservationPocEventResponse,
  CreateLiveObservationPocSessionResponse,
  LiveObservationPocSnapshot,
  TrafficReceipt,
} from "./index.js";

test("live observation PoC DTOs describe the public receipt flow", () => {
  const receipt: TrafficReceipt = {
    eventId: "0c9ab3ad-e053-4a57-a978-413e0b19e06f",
    instanceId: "i-0123456789abcdef0",
    receivedAt: "2026-07-11T00:00:00.000Z",
  };
  const session: CreateLiveObservationPocSessionResponse = {
    observationId: "cf616079-3ce5-4f42-b3fd-809b8c3f9b7a",
    createdAt: "2026-07-11T00:00:00.000Z",
    expiresAt: "2026-07-11T00:15:00.000Z",
    audienceUrl: "https://audience.example/#observationId=cf616079-3ce5-4f42-b3fd-809b8c3f9b7a",
    streamUrl: "https://api.example/api/live-observation-poc/sessions/cf616079-3ce5-4f42-b3fd-809b8c3f9b7a/stream",
  };
  const collectRequest: CollectLiveObservationPocEventRequest = receipt;
  const collectResponse: CollectLiveObservationPocEventResponse = {
    accepted: true,
    acceptedEventCount: 1,
  };
  const snapshot: LiveObservationPocSnapshot = {
    observationId: session.observationId,
    status: "active",
    acceptedEventCount: collectResponse.acceptedEventCount,
    lastReceipt: collectRequest,
    observedAt: "2026-07-11T00:00:01.000Z",
  };

  assert.deepEqual(snapshot.lastReceipt, receipt);
  assert.equal(snapshot.status, "active");
});
