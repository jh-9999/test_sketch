/* global __ENV, URL */

import http from "k6/http";
import { check } from "k6";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_OFFSET_DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const COLLECTOR_PATH_PATTERN = /^\/api\/live-observation-poc\/public\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/events$/i;
const CAPABILITY_PATTERN = /^LiveObservation [A-Za-z0-9_-]{1,32}\.[A-Za-z0-9_-]{43}$/;

const baseUrl = parseOrigin("BASE_URL", requireEnvironment("BASE_URL", __ENV.BASE_URL));
const collectorUrl = parseCollectorUrl(
  requireEnvironment("COLLECTOR_URL", __ENV.COLLECTOR_URL),
);
const collectorAuthorization = parseCollectorAuthorization(
  requireEnvironment("COLLECTOR_AUTH", __ENV.COLLECTOR_AUTH),
);

export const options = {
  scenarios: {
    scale_out: {
      executor: "constant-arrival-rate",
      rate: 120,
      timeUnit: "1m",
      duration: "5m",
      preAllocatedVUs: 10,
      maxVUs: 50,
    },
  },
};

export default function () {
  const trafficResponse = http.post(`${baseUrl}/api/traffic`);
  const receipt = parseTrafficReceipt(trafficResponse);
  const trafficAccepted = check(trafficResponse, {
    "traffic status is 200": (response) => response.status === 200,
    "traffic receipt is valid": () => receipt !== null,
  });

  if (!trafficAccepted || receipt === null) {
    return;
  }

  const collectorResponse = http.post(collectorUrl, JSON.stringify(receipt), {
    headers: {
      Authorization: collectorAuthorization,
      "Content-Type": "application/json",
    },
  });
  check(collectorResponse, {
    "collector accepts receipt": (response) => response.status === 202,
  });
}

function requireEnvironment(name, value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseOrigin(name, value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid ${name}`);
  }

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(`Invalid ${name}`);
  }
  return url.origin;
}

function parseCollectorUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid COLLECTOR_URL");
  }

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !COLLECTOR_PATH_PATTERN.test(url.pathname) ||
    url.search ||
    url.hash
  ) {
    throw new Error("Invalid COLLECTOR_URL");
  }
  return url.href;
}

function parseCollectorAuthorization(value) {
  if (!CAPABILITY_PATTERN.test(value)) {
    throw new Error("Invalid COLLECTOR_AUTH");
  }
  return value;
}

function parseTrafficReceipt(response) {
  if (response.status !== 200) {
    return null;
  }

  let receipt;
  try {
    receipt = response.json();
  } catch {
    return null;
  }

  if (
    receipt === null ||
    typeof receipt !== "object" ||
    Array.isArray(receipt) ||
    Object.keys(receipt).length !== 3 ||
    !UUID_PATTERN.test(receipt.eventId) ||
    typeof receipt.instanceId !== "string" ||
    receipt.instanceId.length === 0 ||
    typeof receipt.receivedAt !== "string" ||
    !isValidIsoOffsetDateTime(receipt.receivedAt)
  ) {
    return null;
  }

  return receipt;
}

function isValidIsoOffsetDateTime(value) {
  const match = ISO_OFFSET_DATE_TIME_PATTERN.exec(value);
  if (match === null) {
    return false;
  }

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offset] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return false;
  }

  if (offset === "Z") {
    return true;
  }

  const offsetHour = Number(offset.slice(1, 3));
  const offsetMinute = Number(offset.slice(4, 6));
  return offsetHour <= 23 && offsetMinute <= 59;
}

function daysInMonth(year, month) {
  if (month === 2) {
    const isLeapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return isLeapYear ? 29 : 28;
  }

  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}
