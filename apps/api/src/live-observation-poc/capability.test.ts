import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";
import test from "node:test";

import { issueCapability, verifyCapability } from "./capability.js";

const currentKid = "poc-20260711";
const currentSecret = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
const claims = {
  observationId: "cf616079-3ce5-4f42-b3fd-809b8c3f9b7a",
  tokenVersion: 1,
  expiresAt: "2026-07-11T12:15:00.000Z",
};

const issueInput = { currentKid, currentSecret, ...claims };
const verificationInput = {
  currentKid,
  currentSecret,
  ...claims,
  now: Date.parse(claims.expiresAt) - 1,
};

function calculateMac(input: typeof claims): Buffer {
  const message = [
    "sketchcatch:live-observation:poc:v1",
    input.observationId,
    String(input.tokenVersion),
    input.expiresAt,
  ].join("\0");

  return createHmac("sha256", currentSecret).update(message, "utf8").digest();
}

function credentialWithMac(mac: Buffer): string {
  return `${currentKid}.${mac.toString("base64url")}`;
}

test("issues the deterministic HMAC credential for the capability claims", () => {
  const credential = issueCapability(issueInput);

  assert.equal(credential, credentialWithMac(calculateMac(claims)));
  assert.equal(verifyCapability({ ...verificationInput, credential }), true);
});

test("rejects a credential when the observation claim changes", () => {
  const credential = issueCapability(issueInput);

  assert.equal(
    verifyCapability({
      ...verificationInput,
      observationId: "b0ac84d1-9ee2-4ad1-9c3b-7bbe0f1ddaa8",
      credential,
    }),
    false,
  );
});

test("rejects a credential when the session token version claim changes", () => {
  const credential = issueCapability(issueInput);

  assert.equal(
    verifyCapability({ ...verificationInput, tokenVersion: 2, credential }),
    false,
  );
});

test("rejects a credential with a tampered final MAC byte", () => {
  const mac = calculateMac(claims);
  mac[mac.length - 1] = mac[mac.length - 1]! ^ 1;

  assert.equal(
    verifyCapability({
      ...verificationInput,
      credential: credentialWithMac(mac),
    }),
    false,
  );
});

test("rejects a credential with an unknown key ID", () => {
  const credential = issueCapability(issueInput);

  assert.equal(
    verifyCapability({
      ...verificationInput,
      credential: credential.replace(currentKid, "poc-unknown"),
    }),
    false,
  );
});

test("rejects padded or whitespace-wrapped credentials", () => {
  const credential = issueCapability(issueInput);

  for (const invalidCredential of [
    `${credential}=`,
    ` ${credential}`,
    `${credential} `,
  ]) {
    assert.equal(
      verifyCapability({ ...verificationInput, credential: invalidCredential }),
      false,
    );
  }
});

test("rejects a wrong-length decoded MAC without throwing", () => {
  const credential = credentialWithMac(Buffer.alloc(31, 1));

  assert.doesNotThrow(() => {
    assert.equal(
      verifyCapability({ ...verificationInput, credential }),
      false,
    );
  });
});

test("accepts before expiry and rejects at the expiry boundary", () => {
  const credential = issueCapability(issueInput);
  const expiresAt = Date.parse(claims.expiresAt);

  assert.equal(
    verifyCapability({ ...verificationInput, now: expiresAt - 1, credential }),
    true,
  );
  assert.equal(
    verifyCapability({ ...verificationInput, now: expiresAt, credential }),
    false,
  );
  assert.equal(
    verifyCapability({ ...verificationInput, now: expiresAt + 1, credential }),
    false,
  );
});

test("fails closed when the verification clock is not finite", () => {
  const credential = issueCapability(issueInput);

  for (const now of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.equal(
      verifyCapability({ ...verificationInput, now, credential }),
      false,
    );
  }
});

test("validation failures never expose the secret or Authorization value in errors", () => {
  const credential = issueCapability(issueInput);
  const authorization = `LiveObservation ${credential}`;
  const secret = currentSecret.toString("base64url");

  assert.doesNotThrow(() => {
    assert.equal(
      verifyCapability({ ...verificationInput, credential: authorization }),
      false,
    );
  });
  assert.doesNotThrow(() => {
    assert.equal(
      verifyCapability({ ...verificationInput, credential: secret }),
      false,
    );
  });
});
