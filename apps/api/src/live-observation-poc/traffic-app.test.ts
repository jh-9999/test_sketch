import assert from "node:assert/strict";
import test from "node:test";

async function loadTrafficApp() {
  return import("./traffic-app.js");
}

async function loadInstanceIdentity() {
  return import("./instance-identity.js");
}

test("returns an ok health response", async (t) => {
  const { createTrafficApp } = await loadTrafficApp();
  const app = createTrafficApp({ instanceIdentity: async () => "i-test" });
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/health" });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "ok" });
});

test("issues a valid unique receipt with a no-store cache policy for every traffic request", async (t) => {
  const { createTrafficApp } = await loadTrafficApp();
  const app = createTrafficApp({ instanceIdentity: async () => "i-test" });
  t.after(() => app.close());

  const firstResponse = await app.inject({ method: "POST", url: "/api/traffic" });
  const secondResponse = await app.inject({ method: "POST", url: "/api/traffic" });
  const firstReceipt = firstResponse.json<{
    eventId: string;
    instanceId: string;
    receivedAt: string;
  }>();
  const secondReceipt = secondResponse.json<{
    eventId: string;
    instanceId: string;
    receivedAt: string;
  }>();

  assert.equal(firstResponse.statusCode, 200);
  assert.equal(secondResponse.statusCode, 200);
  assert.equal(firstResponse.headers["cache-control"], "no-store");
  assert.equal(secondResponse.headers["cache-control"], "no-store");
  assert.match(
    firstReceipt.eventId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  );
  assert.match(
    secondReceipt.eventId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  );
  assert.notEqual(firstReceipt.eventId, secondReceipt.eventId);
  assert.equal(firstReceipt.instanceId, "i-test");
  assert.equal(secondReceipt.instanceId, "i-test");
  assert.match(firstReceipt.receivedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.match(secondReceipt.receivedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test("keeps the traffic endpoint available when IMDS lookup fails", async (t) => {
  const [{ createTrafficApp }, { createInstanceIdentity }] = await Promise.all([
    loadTrafficApp(),
    loadInstanceIdentity(),
  ]);
  const app = createTrafficApp({
    instanceIdentity: createInstanceIdentity({
      environment: {},
      fetch: async () => new Response("unavailable", { status: 503 }),
    }),
  });
  t.after(() => app.close());

  const response = await app.inject({ method: "POST", url: "/api/traffic" });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json<{ instanceId: string }>().instanceId, "local-dev");
});
