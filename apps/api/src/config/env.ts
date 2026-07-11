import { Buffer } from "node:buffer";

export const LIVE_OBSERVATION_POC_CONFIGURATION_ERROR =
  "Invalid live observation PoC configuration";

export type LiveObservationPocConfig =
  | { enabled: false }
  | {
      enabled: true;
      audienceOrigin: string;
      capability: {
        currentKid: string;
        currentSecret: Buffer;
      };
    };

const KID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export function parseLiveObservationPocConfig(
  environment: NodeJS.ProcessEnv,
): LiveObservationPocConfig {
  const enabled = environment.LIVE_OBSERVATION_POC_ENABLED ?? "false";

  if (enabled === "false") {
    return { enabled: false };
  }

  if (enabled !== "true") {
    throwConfigurationError();
  }

  return {
    enabled: true,
    audienceOrigin: parseAudienceOrigin(
      environment.LIVE_OBSERVATION_POC_AUDIENCE_ORIGIN,
    ),
    capability: {
      currentKid: parseCurrentKid(environment.LIVE_OBSERVATION_POC_CURRENT_KID),
      currentSecret: parseCurrentSecret(
        environment.LIVE_OBSERVATION_POC_CURRENT_SECRET,
      ),
    },
  };
}

function parseAudienceOrigin(value: string | undefined): string {
  if (!value) {
    throwConfigurationError();
  }

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
      throwConfigurationError();
    }

    return url.origin;
  } catch {
    throwConfigurationError();
  }
}

function parseCurrentKid(value: string | undefined): string {
  if (!value || !KID_PATTERN.test(value)) {
    throwConfigurationError();
  }

  return value;
}

function parseCurrentSecret(value: string | undefined): Buffer {
  if (!value || !BASE64URL_PATTERN.test(value)) {
    throwConfigurationError();
  }

  const secret = Buffer.from(value, "base64url");
  if (secret.byteLength !== 32 || secret.toString("base64url") !== value) {
    throwConfigurationError();
  }

  return secret;
}

function throwConfigurationError(): never {
  throw new Error(LIVE_OBSERVATION_POC_CONFIGURATION_ERROR);
}
