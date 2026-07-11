import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const audienceAppUrl = new URL("../../public/live-observation-poc/app.js", import.meta.url);

const observationId = "cf616079-3ce5-4f42-b3fd-809b8c3f9b7a";
const eventId = "69f6bb55-2af2-4787-b36d-0df45cd8e57b";
const capability = `poc-20260711.${"a".repeat(43)}`;
const collector = "https://collector.example";
const validFragment = `#observationId=${observationId}&collector=${encodeURIComponent(collector)}&capability=${capability}`;
const validConfig = { observationId, collector, capability };
const validReceipt = {
  eventId,
  instanceId: "i-0123456789abcdef0",
  receivedAt: "2026-07-11T12:00:01.000Z",
};

async function loadAudienceApp() {
  return import(audienceAppUrl.href);
}

function jsonResponse(status: number, body: unknown, contentType = "application/json") {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": contentType },
  });
}

test("parses a valid fragment only when all required values are present", async () => {
  const { parseAudienceFragment } = await loadAudienceApp();

  assert.deepEqual(parseAudienceFragment(validFragment), { ok: true, config: validConfig });
  assert.deepEqual(parseAudienceFragment(`#collector=${encodeURIComponent(collector)}&capability=${capability}`), {
    ok: false,
    reason: "missing",
  });
});

test("rejects duplicate audience fragment parameters", async () => {
  const { parseAudienceFragment } = await loadAudienceApp();

  assert.deepEqual(
    parseAudienceFragment(`${validFragment}&capability=${capability}`),
    { ok: false, reason: "duplicate" },
  );
});

test("rejects malformed audience fragment values", async () => {
  const { parseAudienceFragment } = await loadAudienceApp();

  assert.deepEqual(
    parseAudienceFragment(`#observationId=not-a-uuid&collector=${encodeURIComponent(collector)}&capability=${capability}`),
    { ok: false, reason: "invalid" },
  );
  assert.deepEqual(
    parseAudienceFragment(`#observationId=${observationId}&collector=${encodeURIComponent("http://collector.example")}&capability=${capability}`),
    { ok: false, reason: "invalid" },
  );
});

test("rejects extra audience fragment parameters", async () => {
  const { parseAudienceFragment } = await loadAudienceApp();

  assert.deepEqual(
    parseAudienceFragment(`${validFragment}&unexpected=value`),
    { ok: false, reason: "extra" },
  );
});

test("removes the fragment while retaining the validated configuration in memory", async () => {
  const { readAudienceConfig, sendTrafficReceipt, AUDIENCE_STATUS } = await loadAudienceApp();
  const replaceCalls: unknown[][] = [];
  const location = { hash: validFragment, pathname: "/live-observation-poc/" };
  const history = {
    replaceState(...args: unknown[]) {
      replaceCalls.push(args);
    },
  };

  const config = readAudienceConfig(location, history);
  location.hash = "";
  const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
  const result = await sendTrafficReceipt(config, async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push([input, init]);
    return calls.length === 1
      ? jsonResponse(200, validReceipt)
      : jsonResponse(202, { accepted: true, acceptedEventCount: 1 });
  });

  assert.deepEqual(config, validConfig);
  assert.deepEqual(replaceCalls, [[null, "", "/live-observation-poc/"]]);
  assert.equal(result.message, AUDIENCE_STATUS.success(validReceipt.instanceId));
  assert.equal(calls.length, 2);
  const collectorCall = calls[1];
  assert.ok(collectorCall);
  assert.equal(
    collectorCall[0],
    `${collector}/api/live-observation-poc/public/${observationId}/events`,
  );
  assert.deepEqual(collectorCall[1], {
    method: "POST",
    headers: {
      Authorization: `LiveObservation ${capability}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(validReceipt),
  });
});

test("calls the collector only after a valid 2xx JSON traffic receipt", async () => {
  const { sendTrafficReceipt, AUDIENCE_STATUS } = await loadAudienceApp();
  const invalidScenarios = [
    {
      response: jsonResponse(502, { error: "unavailable" }),
      expected: AUDIENCE_STATUS.trafficFailure,
    },
    {
      response: jsonResponse(200, "not a receipt", "text/plain"),
      expected: AUDIENCE_STATUS.invalidTrafficReceipt,
    },
    {
      response: new Response("{", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      expected: AUDIENCE_STATUS.invalidTrafficReceipt,
    },
    {
      response: jsonResponse(200, { ...validReceipt, receivedAt: "not-a-date" }),
      expected: AUDIENCE_STATUS.invalidTrafficReceipt,
    },
  ];

  for (const scenario of invalidScenarios) {
    let calls = 0;
    const result = await sendTrafficReceipt(validConfig, async () => {
      calls += 1;
      return scenario.response;
    });

    assert.equal(calls, 1);
    assert.equal(result.message, scenario.expected);
  }

  const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
  const result = await sendTrafficReceipt(validConfig, async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push([input, init]);
    return calls.length === 1
      ? jsonResponse(200, validReceipt)
      : jsonResponse(202, { accepted: true, acceptedEventCount: 1 });
  });

  assert.equal(calls.length, 2);
  assert.equal(result.message, AUDIENCE_STATUS.success(validReceipt.instanceId));
  assert.deepEqual(calls[0], ["/api/traffic", { method: "POST", cache: "no-store" }]);
});

test("does not call the collector for an application/jsonp traffic response", async () => {
  const { sendTrafficReceipt, AUDIENCE_STATUS } = await loadAudienceApp();
  let calls = 0;

  const result = await sendTrafficReceipt(validConfig, async () => {
    calls += 1;
    return jsonResponse(200, validReceipt, "application/jsonp");
  });

  assert.equal(calls, 1);
  assert.equal(result.message, AUDIENCE_STATUS.invalidTrafficReceipt);
});

test("does not call the collector for an impossible receipt calendar date", async () => {
  const { sendTrafficReceipt, AUDIENCE_STATUS } = await loadAudienceApp();
  let calls = 0;

  const result = await sendTrafficReceipt(validConfig, async () => {
    calls += 1;
    return jsonResponse(200, { ...validReceipt, receivedAt: "2026-02-31T12:00:01Z" });
  });

  assert.equal(calls, 1);
  assert.equal(result.message, AUDIENCE_STATUS.invalidTrafficReceipt);
});

test("shows distinct Korean messages for traffic, invalid receipt, and collector failures", async () => {
  const { sendTrafficReceipt, AUDIENCE_STATUS } = await loadAudienceApp();
  const collectorFailure = async (status: number) => {
    let calls = 0;
    return sendTrafficReceipt(validConfig, async () => {
      calls += 1;
      return calls === 1
        ? jsonResponse(200, validReceipt)
        : jsonResponse(status, { error: "collector failure" });
    });
  };
  const outcomes = await Promise.all([
    sendTrafficReceipt(validConfig, async () => {
      throw new Error("offline");
    }),
    sendTrafficReceipt(validConfig, async () => jsonResponse(200, { ...validReceipt, instanceId: "" })),
    collectorFailure(401),
    collectorFailure(410),
    collectorFailure(503),
  ]);

  assert.deepEqual(
    outcomes.map((outcome) => outcome.message),
    [
      AUDIENCE_STATUS.trafficFailure,
      AUDIENCE_STATUS.invalidTrafficReceipt,
      AUDIENCE_STATUS.collectorUnauthorized,
      AUDIENCE_STATUS.collectorExpired,
      AUDIENCE_STATUS.collectorFailure,
    ],
  );
  assert.equal(new Set(outcomes.map((outcome) => outcome.message)).size, outcomes.length);
});

test("restores a disabled request button after the complete transaction", async () => {
  const { createAudienceRequestHandler, AUDIENCE_STATUS } = await loadAudienceApp();
  let resolveTraffic: ((response: Response) => void) | undefined;
  const button = { disabled: false };
  const status = { textContent: "", dataset: {} as Record<string, string> };
  const handleRequest = createAudienceRequestHandler({
    button,
    status,
    config: validConfig,
    fetchImpl: async () =>
      new Promise<Response>((resolve) => {
        resolveTraffic = resolve;
      }),
  });

  const pending = handleRequest();
  assert.equal(button.disabled, true);
  resolveTraffic?.(jsonResponse(500, { error: "unavailable" }));
  const result = await pending;

  assert.equal(result.message, AUDIENCE_STATUS.trafficFailure);
  assert.equal(button.disabled, false);
  assert.equal(status.textContent, AUDIENCE_STATUS.trafficFailure);
  assert.equal(status.dataset.state, "error");
});

test("keeps audience source free of persistent or query-string secret paths", async () => {
  const source = await readFile(audienceAppUrl, "utf8");

  for (const forbidden of [
    /console\s*\./,
    /localStorage/,
    /sessionStorage/,
    /indexedDB/,
    /document\.cookie/,
    /(?:window\.)?location\.search/,
    /searchParams/,
    /URLSearchParams/,
    /\.search\s*=/,
  ]) {
    assert.doesNotMatch(source, forbidden);
  }
});
