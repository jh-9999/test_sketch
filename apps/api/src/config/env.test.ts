import assert from "node:assert/strict";
import test from "node:test";

import {
  LIVE_OBSERVATION_POC_CONFIGURATION_ERROR,
  parseLiveObservationPocConfig,
} from "./env.js";

const validSecret = Buffer.alloc(32, 1).toString("base64url");

function validEnvironment(): NodeJS.ProcessEnv {
  return {
    LIVE_OBSERVATION_POC_ENABLED: "true",
    LIVE_OBSERVATION_POC_AUDIENCE_ORIGIN: "https://audience.example",
    LIVE_OBSERVATION_POC_CURRENT_KID: "poc-20260711",
    LIVE_OBSERVATION_POC_CURRENT_SECRET: validSecret,
  };
}

test("defaults the live observation PoC flag to false", () => {
  assert.deepEqual(parseLiveObservationPocConfig({}), { enabled: false });
});

test("parses enabled live observation PoC capability configuration", () => {
  const config = parseLiveObservationPocConfig(validEnvironment());

  assert.equal(config.enabled, true);
  if (!config.enabled) {
    assert.fail("expected enabled configuration");
  }

  assert.equal(config.audienceOrigin, "https://audience.example");
  assert.equal(config.capability.currentKid, "poc-20260711");
  assert.equal(config.capability.currentSecret.byteLength, 32);
  assert.equal(config.capability.currentSecret.toString("base64url"), validSecret);
});

for (const [name, environment] of [
  ["missing secret", { ...validEnvironment(), LIVE_OBSERVATION_POC_CURRENT_SECRET: undefined }],
  ["non-canonical secret", { ...validEnvironment(), LIVE_OBSERVATION_POC_CURRENT_SECRET: "invalid=" }],
  ["missing key ID", { ...validEnvironment(), LIVE_OBSERVATION_POC_CURRENT_KID: undefined }],
  ["invalid key ID", { ...validEnvironment(), LIVE_OBSERVATION_POC_CURRENT_KID: "invalid key id" }],
  ["missing audience origin", { ...validEnvironment(), LIVE_OBSERVATION_POC_AUDIENCE_ORIGIN: undefined }],
  ["non-origin audience URL", { ...validEnvironment(), LIVE_OBSERVATION_POC_AUDIENCE_ORIGIN: "https://audience.example/path" }],
] as const) {
  test(`returns a generic configuration error for ${name}`, () => {
    assert.throws(
      () => parseLiveObservationPocConfig(environment),
      (error: unknown) =>
        error instanceof Error && error.message === LIVE_OBSERVATION_POC_CONFIGURATION_ERROR,
    );
  });
}
