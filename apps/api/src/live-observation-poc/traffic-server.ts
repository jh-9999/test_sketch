import { createInstanceIdentity } from "./instance-identity.js";
import { createTrafficApp } from "./traffic-app.js";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const host = process.env.HOST ?? "0.0.0.0";
const app = createTrafficApp({
  instanceIdentity: createInstanceIdentity({
    environment: process.env,
    fetch: globalThis.fetch,
  }),
});

await app.listen({ host, port });
