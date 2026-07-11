import assert from "node:assert/strict";
import test from "node:test";

async function loadInstanceIdentity() {
  return import("./instance-identity.js");
}

test("returns INSTANCE_ID without making an IMDS request", async () => {
  const { createInstanceIdentity } = await loadInstanceIdentity();
  let fetchCalls = 0;
  const instanceIdentity = createInstanceIdentity({
    environment: { INSTANCE_ID: "i-from-environment" },
    fetch: async () => {
      fetchCalls += 1;
      return new Response("unexpected");
    },
  });

  assert.equal(await instanceIdentity(), "i-from-environment");
  assert.equal(fetchCalls, 0);
});

test("uses IMDSv2 and caches a successful instance ID for the process lifetime", async () => {
  const { createInstanceIdentity } = await loadInstanceIdentity();
  const requests: Array<{ url: string; method: string; headers: Headers }> = [];
  const instanceIdentity = createInstanceIdentity({
    environment: {},
    fetch: async (input, init) => {
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
      });

      if (requests.length === 1) {
        return new Response("imds-v2-token", { status: 200 });
      }
      return new Response("i-from-imds", { status: 200 });
    },
  });

  assert.equal(await instanceIdentity(), "i-from-imds");
  assert.equal(await instanceIdentity(), "i-from-imds");
  assert.equal(requests.length, 2);
  assert.deepEqual(
    requests.map(({ url, method, headers }) => ({
      url,
      method,
      headers: Object.fromEntries(headers),
    })),
    [
      {
        url: "http://169.254.169.254/latest/api/token",
        method: "PUT",
        headers: { "x-aws-ec2-metadata-token-ttl-seconds": "21600" },
      },
      {
        url: "http://169.254.169.254/latest/meta-data/instance-id",
        method: "GET",
        headers: { "x-aws-ec2-metadata-token": "imds-v2-token" },
      },
    ],
  );
});

test("falls back to local-dev when IMDS times out", async () => {
  const { createInstanceIdentity } = await loadInstanceIdentity();
  const instanceIdentity = createInstanceIdentity({
    environment: {},
    timeoutMs: 5,
    fetch: async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("timed out", "AbortError"));
        });
      }),
  });

  assert.equal(await instanceIdentity(), "local-dev");
});

test("falls back to local-dev when IMDS fails", async () => {
  const { createInstanceIdentity } = await loadInstanceIdentity();
  const instanceIdentity = createInstanceIdentity({
    environment: {},
    fetch: async () => {
      throw new Error("network unavailable");
    },
  });

  assert.equal(await instanceIdentity(), "local-dev");
});

test("falls back to local-dev when IMDS returns a non-success status", async () => {
  const { createInstanceIdentity } = await loadInstanceIdentity();
  const instanceIdentity = createInstanceIdentity({
    environment: {},
    fetch: async () => new Response("unavailable", { status: 503 }),
  });

  assert.equal(await instanceIdentity(), "local-dev");
});

test("falls back to local-dev when IMDS returns an empty response", async () => {
  const { createInstanceIdentity } = await loadInstanceIdentity();
  const instanceIdentity = createInstanceIdentity({
    environment: {},
    fetch: async () => new Response("", { status: 200 }),
  });

  assert.equal(await instanceIdentity(), "local-dev");
});
