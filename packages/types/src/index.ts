export type TrafficReceipt = {
  eventId: string;
  instanceId: string;
  receivedAt: string;
};

export type CreateLiveObservationPocSessionResponse = {
  observationId: string;
  createdAt: string;
  expiresAt: string;
  audienceUrl: string;
  streamUrl: string;
};

export type CollectLiveObservationPocEventRequest = TrafficReceipt;

export type CollectLiveObservationPocEventResponse = {
  accepted: boolean;
  acceptedEventCount: number;
};

export type LiveObservationPocSnapshot = {
  observationId: string;
  status: "active" | "expired";
  acceptedEventCount: number;
  lastReceipt: TrafficReceipt | null;
  observedAt: string;
};
