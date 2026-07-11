const REQUIRED_FRAGMENT_NAMES = ["observationId", "collector", "capability"];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{1,32}\.[A-Za-z0-9_-]{43}$/;
const ISO_OFFSET_DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
let audienceConfig = null;

export const AUDIENCE_STATUS = Object.freeze({
  loading: "요청을 보내고 있습니다.",
  invalidFragment: "유효하지 않은 관측 링크입니다. 새 링크를 사용하세요.",
  trafficFailure: "EC2 요청에 실패했습니다. 다시 시도하세요.",
  invalidTrafficReceipt: "EC2 응답을 확인할 수 없습니다. 다시 시도하세요.",
  collectorUnauthorized: "EC2 요청에는 성공했지만 SketchCatch 인증이 만료되었습니다. 새 링크를 사용하세요.",
  collectorExpired: "EC2 요청에는 성공했지만 관측 시간이 만료되었습니다. 새 링크를 사용하세요.",
  collectorFailure: "EC2 요청에는 성공했지만 SketchCatch 기록에 실패했습니다. 다시 시도하세요.",
  success(instanceId) {
    return `EC2 ${instanceId}에서 요청을 처리했고 SketchCatch에 기록했습니다.`;
  },
});

export function parseAudienceFragment(hash) {
  const fragment = hash.startsWith("#") ? hash.slice(1) : hash;
  if (fragment.length === 0) {
    return invalidFragment("missing");
  }

  const values = Object.create(null);
  for (const pair of fragment.split("&")) {
    const separatorIndex = pair.indexOf("=");
    if (separatorIndex <= 0) {
      return invalidFragment("invalid");
    }

    const decoded = decodeFragmentPair(pair, separatorIndex);
    if (decoded === null) {
      return invalidFragment("invalid");
    }

    const { name, value } = decoded;
    if (!REQUIRED_FRAGMENT_NAMES.includes(name)) {
      return invalidFragment("extra");
    }
    if (Object.prototype.hasOwnProperty.call(values, name)) {
      return invalidFragment("duplicate");
    }
    values[name] = value;
  }

  for (const name of REQUIRED_FRAGMENT_NAMES) {
    if (!Object.prototype.hasOwnProperty.call(values, name)) {
      return invalidFragment("missing");
    }
  }

  const config = {
    observationId: values.observationId,
    collector: normalizeCollectorOrigin(values.collector),
    capability: values.capability,
  };
  if (!isValidAudienceConfig(config)) {
    return invalidFragment("invalid");
  }

  return { ok: true, config };
}

export function readAudienceConfig(location, history) {
  const fragment = location.hash;
  history.replaceState(null, "", location.pathname);
  const parsed = parseAudienceFragment(fragment);
  if (!parsed.ok) {
    return null;
  }

  return parsed.config;
}

export function isValidTrafficReceipt(receipt) {
  if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt)) {
    return false;
  }

  const { eventId, instanceId, receivedAt } = receipt;
  return (
    typeof eventId === "string" &&
    UUID_PATTERN.test(eventId) &&
    typeof instanceId === "string" &&
    instanceId.length > 0 &&
    typeof receivedAt === "string" &&
    ISO_OFFSET_DATE_TIME_PATTERN.test(receivedAt) &&
    Number.isFinite(Date.parse(receivedAt))
  );
}

export async function sendTrafficReceipt(config, fetchImpl) {
  let trafficResponse;
  try {
    trafficResponse = await fetchImpl("/api/traffic", { method: "POST", cache: "no-store" });
  } catch {
    return errorResult(AUDIENCE_STATUS.trafficFailure);
  }

  if (!trafficResponse.ok) {
    return errorResult(AUDIENCE_STATUS.trafficFailure);
  }
  if (!isJsonResponse(trafficResponse)) {
    return errorResult(AUDIENCE_STATUS.invalidTrafficReceipt);
  }

  let receipt;
  try {
    receipt = await trafficResponse.json();
  } catch {
    return errorResult(AUDIENCE_STATUS.invalidTrafficReceipt);
  }
  if (!isValidTrafficReceipt(receipt)) {
    return errorResult(AUDIENCE_STATUS.invalidTrafficReceipt);
  }

  let collectorResponse;
  try {
    collectorResponse = await fetchImpl(collectorEventsUrl(config), {
      method: "POST",
      headers: {
        Authorization: `LiveObservation ${config.capability}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(receipt),
    });
  } catch {
    return errorResult(AUDIENCE_STATUS.collectorFailure);
  }

  if (collectorResponse.status === 401) {
    return errorResult(AUDIENCE_STATUS.collectorUnauthorized);
  }
  if (collectorResponse.status === 410) {
    return errorResult(AUDIENCE_STATUS.collectorExpired);
  }
  if (!collectorResponse.ok) {
    return errorResult(AUDIENCE_STATUS.collectorFailure);
  }

  return { state: "success", message: AUDIENCE_STATUS.success(receipt.instanceId) };
}

export function createAudienceRequestHandler({ button, status, config, fetchImpl }) {
  return async () => {
    button.disabled = true;
    setStatus(status, { state: "loading", message: AUDIENCE_STATUS.loading });

    try {
      const result = await sendTrafficReceipt(config, fetchImpl);
      setStatus(status, result);
      return result;
    } finally {
      button.disabled = false;
    }
  };
}

function decodeFragmentPair(pair, separatorIndex) {
  try {
    return {
      name: decodeURIComponent(pair.slice(0, separatorIndex)),
      value: decodeURIComponent(pair.slice(separatorIndex + 1)),
    };
  } catch {
    return null;
  }
}

function normalizeCollectorOrigin(value) {
  try {
    const url = new globalThis.URL(value);
    if (
      url.protocol !== "https:" ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.pathname !== "/" ||
      url.href !== `${url.origin}/`
    ) {
      return "";
    }
    return url.origin;
  } catch {
    return "";
  }
}

function isValidAudienceConfig(config) {
  return (
    UUID_PATTERN.test(config.observationId) &&
    config.collector.length > 0 &&
    CAPABILITY_PATTERN.test(config.capability)
  );
}

function isJsonResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  return contentType.toLowerCase().includes("application/json");
}

function collectorEventsUrl(config) {
  return `${config.collector}/api/live-observation-poc/public/${config.observationId}/events`;
}

function invalidFragment(reason) {
  return { ok: false, reason };
}

function errorResult(message) {
  return { state: "error", message };
}

function setStatus(status, result) {
  status.textContent = result.message;
  status.dataset.state = result.state;
}

function mountAudiencePage(pageDocument) {
  const button = pageDocument.getElementById("send-traffic");
  const status = pageDocument.getElementById("traffic-status");
  if (button === null || status === null) {
    return;
  }

  audienceConfig = readAudienceConfig(globalThis.location, globalThis.history);
  if (audienceConfig === null) {
    button.disabled = true;
    setStatus(status, { state: "error", message: AUDIENCE_STATUS.invalidFragment });
    return;
  }

  const handleRequest = createAudienceRequestHandler({
    button,
    status,
    config: audienceConfig,
    fetchImpl: globalThis.fetch.bind(globalThis),
  });
  button.addEventListener("click", handleRequest);
}

if (typeof globalThis.document !== "undefined") {
  mountAudiencePage(globalThis.document);
}
