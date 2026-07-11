import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";

const HMAC_PREFIX = "sketchcatch:live-observation:poc:v1";
const KID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAC_LENGTH = 32;

export type LiveObservationPocCapabilityClaims = {
  observationId: string;
  tokenVersion: number;
  expiresAt: string;
};

export type LiveObservationPocCapabilityKey = {
  currentKid: string;
  currentSecret: Buffer;
};

export type IssueCapabilityInput = LiveObservationPocCapabilityKey &
  LiveObservationPocCapabilityClaims;

export type VerifyCapabilityInput = IssueCapabilityInput & {
  credential: string;
  now: number;
};

export function issueCapability(input: IssueCapabilityInput): string {
  const mac = signCapability(input);

  return `${input.currentKid}.${mac.toString("base64url")}`;
}

export function verifyCapability(input: VerifyCapabilityInput): boolean {
  const expiresAt = Date.parse(input.expiresAt);
  if (!Number.isFinite(expiresAt) || input.now >= expiresAt) {
    return false;
  }

  const credential = parseCredential(input.credential);
  if (!credential || credential.kid !== input.currentKid) {
    return false;
  }

  const expectedMac = signCapability(input);
  if (credential.mac.byteLength !== MAC_LENGTH) {
    return false;
  }

  return timingSafeEqual(credential.mac, expectedMac);
}

function signCapability(input: IssueCapabilityInput): Buffer {
  return createHmac("sha256", input.currentSecret)
    .update(
      [
        HMAC_PREFIX,
        input.observationId,
        String(input.tokenVersion),
        input.expiresAt,
      ].join("\0"),
      "utf8",
    )
    .digest();
}

function parseCredential(value: string): { kid: string; mac: Buffer } | null {
  const separatorIndex = value.indexOf(".");
  if (
    separatorIndex <= 0 ||
    separatorIndex !== value.lastIndexOf(".")
  ) {
    return null;
  }

  const kid = value.slice(0, separatorIndex);
  const encodedMac = value.slice(separatorIndex + 1);
  if (!KID_PATTERN.test(kid) || !BASE64URL_PATTERN.test(encodedMac)) {
    return null;
  }

  const mac = Buffer.from(encodedMac, "base64url");
  if (
    mac.byteLength !== MAC_LENGTH ||
    mac.toString("base64url") !== encodedMac
  ) {
    return null;
  }

  return { kid, mac };
}
