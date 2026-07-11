import { existsSync } from "node:fs";

const requiredPaths = ["apps/api", "apps/web", "packages/types"];
const missing = requiredPaths.filter((path) => !existsSync(path));

if (missing.length > 0) {
  throw new Error(`Missing workspace paths: ${missing.join(", ")}`);
}
