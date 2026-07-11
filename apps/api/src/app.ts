import Fastify, { type FastifyInstance } from "fastify";

import type { LiveObservationPocConfig } from "./config/env.js";
import {
  registerLiveObservationPocRoutes,
  type LiveObservationPocAuthorizer,
} from "./live-observation-poc/routes.js";
import { createInMemoryLiveObservationPocStore } from "./live-observation-poc/observation-store.js";

type LoggerStream = {
  write(message: string): void;
};

export type CreateAppDependencies = {
  config: LiveObservationPocConfig;
  apiOrigin: string;
  now: () => number;
  authorize?: LiveObservationPocAuthorizer;
  loggerStream?: LoggerStream;
};

export function createApp(input: CreateAppDependencies): FastifyInstance {
  const app = Fastify({
    logger: {
      level: "info",
      ...(input.loggerStream ? { stream: input.loggerStream } : {}),
      serializers: {
        req(request) {
          return {
            method: request.method,
            url: request.url,
            headers: request.headers,
          };
        },
        res(reply) {
          return {
            statusCode: reply.statusCode,
            headers: reply.getHeaders?.(),
          };
        },
      },
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          'res.headers["set-cookie"]',
        ],
        censor: "[REDACTED]",
      },
    },
  });

  if (!input.config.enabled) {
    return app;
  }

  const store = createInMemoryLiveObservationPocStore({
    now: input.now,
    capabilityKid: input.config.capability.currentKid,
  });
  registerLiveObservationPocRoutes(app, {
    store,
    audienceOrigin: input.config.audienceOrigin,
    apiOrigin: input.apiOrigin,
    capability: input.config.capability,
    now: input.now,
    ...(input.authorize ? { authorize: input.authorize } : {}),
  });

  return app;
}
