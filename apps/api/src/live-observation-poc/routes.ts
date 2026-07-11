import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { issueCapability, verifyCapability, type LiveObservationPocCapabilityKey } from "./capability.js";
import { createInMemoryLiveObservationPocStore } from "./observation-store.js";
import { trafficReceiptSchema } from "./traffic-receipt-schema.js";

const PUBLIC_ERROR = { error: "Invalid live observation request" };
const SESSIONS_PATH = "/api/live-observation-poc/sessions";
const PUBLIC_EVENTS_PATH = "/api/live-observation-poc/public/:observationId/events";
const STREAM_PATH = "/api/live-observation-poc/sessions/:observationId/stream";

type LiveObservationPocStore = ReturnType<typeof createInMemoryLiveObservationPocStore>;

export type LiveObservationPocAuthorizer = (
  request: FastifyRequest,
  observationId?: string,
) => Promise<boolean>;

export type LiveObservationPocRouteDependencies = {
  store: LiveObservationPocStore;
  audienceOrigin: string;
  apiOrigin: string;
  capability: LiveObservationPocCapabilityKey;
  now: () => number;
  authorize?: LiveObservationPocAuthorizer;
};

export function registerLiveObservationPocRoutes(
  app: FastifyInstance,
  dependencies: LiveObservationPocRouteDependencies,
): void {
  app.setErrorHandler((error, request, reply) => {
    if (isPublicCollectorRequest(request)) {
      setCorsHeaders(request, reply, dependencies.audienceOrigin);
      return sendPublicError(reply, getErrorStatusCode(error) ?? 400);
    }

    return reply.send(error);
  });

  app.post(SESSIONS_PATH, async (request, reply) => {
    if (!(await isAuthorized(dependencies, request))) {
      return sendPublicError(reply, 401);
    }

    const session = dependencies.store.createSession();
    const issuedCapability = issueCapability({
      ...dependencies.capability,
      observationId: session.observationId,
      tokenVersion: session.tokenVersion,
      expiresAt: session.expiresAt,
    });

    return reply.code(201).send({
      observationId: session.observationId,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      audienceUrl: `${dependencies.audienceOrigin}/#observationId=${session.observationId}&collector=${encodeURIComponent(dependencies.apiOrigin)}&capability=${issuedCapability}`,
      streamUrl: `${dependencies.apiOrigin}${SESSIONS_PATH}/${session.observationId}/stream`,
    });
  });

  app.options(PUBLIC_EVENTS_PATH, async (request, reply) => {
    setCorsHeaders(request, reply, dependencies.audienceOrigin);
    return reply.code(204).send();
  });

  app.post(
    PUBLIC_EVENTS_PATH,
    { bodyLimit: 1024 },
    async (request, reply) => {
      setCorsHeaders(request, reply, dependencies.audienceOrigin);
      const observationId = request.params as { observationId: string };
      const session = dependencies.store.readSession(observationId.observationId);
      if (!session) {
        return sendPublicError(reply, 404);
      }
      if (session.status === "expired") {
        return sendPublicError(reply, 410);
      }

      const credential = extractCredential(request.headers.authorization);
      if (
        !credential ||
        !verifyCapability({
          ...dependencies.capability,
          credential,
          observationId: session.observationId,
          tokenVersion: session.tokenVersion,
          expiresAt: session.expiresAt,
          now: dependencies.now(),
        })
      ) {
        return sendPublicError(reply, 401);
      }

      const parsedReceipt = trafficReceiptSchema.safeParse(request.body);
      if (!parsedReceipt.success) {
        return sendPublicError(reply, 400);
      }

      const outcome = dependencies.store.collectReceipt({
        observationId: session.observationId,
        receipt: parsedReceipt.data,
      });
      if (outcome === "not_found") {
        return sendPublicError(reply, 404);
      }
      if (outcome === "expired") {
        return sendPublicError(reply, 410);
      }

      const currentSession = dependencies.store.readSession(session.observationId);
      if (!currentSession) {
        return sendPublicError(reply, 404);
      }

      return reply
        .code(outcome === "accepted" ? 202 : 200)
        .send({
          accepted: outcome === "accepted",
          acceptedEventCount: currentSession.acceptedEventCount,
        });
    },
  );

  app.get(STREAM_PATH, async (request, reply) => {
    const observationId = request.params as { observationId: string };
    if (!(await isAuthorized(dependencies, request, observationId.observationId))) {
      return sendPublicError(reply, 401);
    }

    const session = dependencies.store.readSession(observationId.observationId);
    if (!session) {
      return sendPublicError(reply, 404);
    }
    if (session.status === "expired") {
      return sendPublicError(reply, 410);
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const unsubscribe = dependencies.store.subscribe(
      session.observationId,
      (snapshot) => {
        reply.raw.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
      },
    );
    request.raw.once("close", unsubscribe);
  });
}

async function isAuthorized(
  dependencies: LiveObservationPocRouteDependencies,
  request: FastifyRequest,
  observationId?: string,
): Promise<boolean> {
  if (!dependencies.authorize) {
    return false;
  }

  try {
    return (await dependencies.authorize(request, observationId)) === true;
  } catch {
    return false;
  }
}

function sendPublicError(reply: FastifyReply, statusCode: number) {
  return reply.code(statusCode).send(PUBLIC_ERROR);
}

function extractCredential(authorization: string | undefined): string | null {
  if (!authorization?.startsWith("LiveObservation ")) {
    return null;
  }

  const credential = authorization.slice("LiveObservation ".length);
  return credential || null;
}

function setCorsHeaders(
  request: FastifyRequest,
  reply: FastifyReply,
  audienceOrigin: string,
): void {
  if (request.headers.origin !== audienceOrigin) {
    return;
  }

  reply.header("Access-Control-Allow-Origin", audienceOrigin);
  reply.header("Access-Control-Allow-Methods", "POST, OPTIONS");
  reply.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
}

function isPublicCollectorRequest(request: FastifyRequest): boolean {
  return request.raw.url?.startsWith("/api/live-observation-poc/public/") ?? false;
}

function getErrorStatusCode(error: unknown): number | undefined {
  if (
    typeof error !== "object" ||
    error === null ||
    !("statusCode" in error) ||
    typeof error.statusCode !== "number"
  ) {
    return undefined;
  }

  return error.statusCode;
}
