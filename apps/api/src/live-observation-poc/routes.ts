import { Buffer } from "node:buffer";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { issueCapability, verifyCapability, type LiveObservationPocCapabilityKey } from "./capability.js";
import { createInMemoryLiveObservationPocStore } from "./observation-store.js";
import { trafficReceiptSchema } from "./traffic-receipt-schema.js";

const PUBLIC_ERROR = { error: "Invalid live observation request" };
const COLLECTOR_BODY_LIMIT = 1024;
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

  registerPublicCollector(app, dependencies);

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

function registerPublicCollector(
  app: FastifyInstance,
  dependencies: LiveObservationPocRouteDependencies,
): void {
  app.register((collector, _options, done) => {
    collector.removeAllContentTypeParsers();
    collector.addContentTypeParser("*", (request, payload, next) => {
      next(null, payload);
    });

    collector.options(PUBLIC_EVENTS_PATH, async (request, reply) => {
      setCorsHeaders(request, reply, dependencies.audienceOrigin);
      return reply.code(204).send();
    });

    collector.post(PUBLIC_EVENTS_PATH, async (request, reply) => {
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

      const rawBody = await readCollectorBody(request.body);
      if (rawBody === "too_large") {
        return sendPublicError(reply, 413);
      }
      if (rawBody === "invalid") {
        return sendPublicError(reply, 400);
      }

      const parsedReceipt = parseCollectorReceipt(rawBody);
      if (!parsedReceipt) {
        return sendPublicError(reply, 400);
      }

      const outcome = dependencies.store.collectReceipt({
        observationId: session.observationId,
        receipt: parsedReceipt,
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
    });

    done();
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

async function readCollectorBody(
  body: unknown,
): Promise<Buffer | "too_large" | "invalid"> {
  if (!isAsyncIterable(body)) {
    return "invalid";
  }

  const chunks: Buffer[] = [];
  let length = 0;

  try {
    for await (const value of body) {
      const chunk = toBuffer(value);
      if (!chunk) {
        return "invalid";
      }

      length += chunk.byteLength;
      if (length > COLLECTOR_BODY_LIMIT) {
        return "too_large";
      }
      chunks.push(chunk);
    }
  } catch {
    return "invalid";
  }

  return Buffer.concat(chunks);
}

function parseCollectorReceipt(rawBody: Buffer) {
  try {
    const parsedReceipt = trafficReceiptSchema.safeParse(
      JSON.parse(rawBody.toString("utf8")),
    );
    return parsedReceipt.success ? parsedReceipt.data : null;
  } catch {
    return null;
  }
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value
  );
}

function toBuffer(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (typeof value === "string" || value instanceof Uint8Array) {
    return Buffer.from(value);
  }

  return null;
}
