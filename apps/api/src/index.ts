import type { FastifyInstance, FastifyRequest } from "fastify";

import { createApp } from "./app.js";
import { parseLiveObservationPocConfig } from "./config/env.js";
import type { LiveObservationPocAuthorizer } from "./live-observation-poc/routes.js";

type LoggerStream = {
  write(message: string): void;
};

export const API_RUNTIME_HTTPS_ORIGIN_ERROR =
  "The API origin must be an HTTPS API origin";

/**
 * The host application's existing authentication and ownership boundary.
 * An undefined observation ID means session creation; a supplied ID means
 * stream ownership for that observation.
 */
export type HostLiveObservationAuthorizationGuard = {
  authorizeLiveObservation(
    request: FastifyRequest,
    observationId?: string,
  ): boolean | Promise<boolean>;
};

export type CreateApiRuntimeInput = {
  apiOrigin: string;
  hostGuard: HostLiveObservationAuthorizationGuard;
  environment?: NodeJS.ProcessEnv;
  loggerStream?: LoggerStream;
};

export type StartApiInput = CreateApiRuntimeInput & {
  host: string;
  port: number;
};

/**
 * Adapts the host's session/ownership guard to the PoC route contract.
 * A denied or failed host check is always treated as unauthorized.
 */
export function adaptHostLiveObservationAuthorizationGuard(
  hostGuard: HostLiveObservationAuthorizationGuard,
): LiveObservationPocAuthorizer {
  return async (request, observationId) => {
    try {
      return (await hostGuard.authorizeLiveObservation(request, observationId)) === true;
    } catch {
      return false;
    }
  };
}

/**
 * Composes the API with its real process environment and host-owned guard.
 * This module deliberately supplies no authentication implementation itself.
 */
export function createApiRuntime(input: CreateApiRuntimeInput): FastifyInstance {
  return createApp({
    config: parseLiveObservationPocConfig(input.environment ?? process.env),
    apiOrigin: parseHttpsApiOrigin(input.apiOrigin),
    now: Date.now,
    authorize: adaptHostLiveObservationAuthorizationGuard(input.hostGuard),
    ...(input.loggerStream ? { loggerStream: input.loggerStream } : {}),
  });
}

/**
 * Starts the composed API only after the host supplies its authentication and
 * ownership guard. The returned instance remains available for graceful close.
 */
export async function startApi(input: StartApiInput): Promise<FastifyInstance> {
  const app = createApiRuntime(input);
  await app.listen({ host: input.host, port: input.port });
  return app;
}

function parseHttpsApiOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new Error(API_RUNTIME_HTTPS_ORIGIN_ERROR);
    }

    return url.origin;
  } catch {
    throw new Error(API_RUNTIME_HTTPS_ORIGIN_ERROR);
  }
}
