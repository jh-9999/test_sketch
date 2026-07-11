const IMDS_TOKEN_URL = "http://169.254.169.254/latest/api/token";
const IMDS_INSTANCE_ID_URL = "http://169.254.169.254/latest/meta-data/instance-id";
const LOCAL_DEVELOPMENT_INSTANCE_ID = "local-dev";

type InstanceIdentityEnvironment = {
  INSTANCE_ID?: string;
};

export type InstanceIdentity = () => Promise<string>;

export type CreateInstanceIdentityDependencies = {
  environment: InstanceIdentityEnvironment;
  fetch: typeof globalThis.fetch;
  timeoutMs?: number;
};

export function createInstanceIdentity(
  dependencies: CreateInstanceIdentityDependencies,
): InstanceIdentity {
  const timeoutMs = dependencies.timeoutMs ?? 200;
  let cachedInstanceId: string | null = null;

  return async () => {
    const configuredInstanceId = dependencies.environment.INSTANCE_ID?.trim();
    if (configuredInstanceId) {
      return configuredInstanceId;
    }
    if (cachedInstanceId) {
      return cachedInstanceId;
    }

    const token = await readImdsText(dependencies.fetch, timeoutMs, IMDS_TOKEN_URL, {
      method: "PUT",
      headers: { "X-aws-ec2-metadata-token-ttl-seconds": "21600" },
    });
    if (!token) {
      return LOCAL_DEVELOPMENT_INSTANCE_ID;
    }

    const instanceId = await readImdsText(dependencies.fetch, timeoutMs, IMDS_INSTANCE_ID_URL, {
      headers: { "X-aws-ec2-metadata-token": token },
    });
    if (!instanceId) {
      return LOCAL_DEVELOPMENT_INSTANCE_ID;
    }

    cachedInstanceId = instanceId;
    return instanceId;
  };
}

async function readImdsText(
  fetch: typeof globalThis.fetch,
  timeoutMs: number,
  url: string,
  init: RequestInit,
): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }

    const value = (await response.text()).trim();
    return value || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
