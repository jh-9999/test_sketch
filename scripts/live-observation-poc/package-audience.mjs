import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const audienceDirectory = resolve(projectRoot, "apps/web/public/live-observation-poc");
const artifactPath = resolve(projectRoot, "dist/live-observation-poc-audience.tar.gz");
const assetFiles = ["index.html", "app.js", "styles.css"];
const forbiddenAudienceSource = [
  /console\s*\./,
  /localStorage/,
  /sessionStorage/,
  /indexedDB/,
  /document\.cookie/,
  /(?:window\.)?location\.search/,
  /searchParams/,
  /URLSearchParams/,
  /\.search\s*=/,
];

await verifyAudienceAssets();
await mkdir(dirname(artifactPath), { recursive: true });
verifyArtifactIsIgnored();
await rm(artifactPath, { force: true });

try {
  execFileSync("tar", ["-czf", artifactPath, "--", ...assetFiles], {
    cwd: audienceDirectory,
    stdio: "ignore",
  });
} catch (error) {
  await rm(artifactPath, { force: true });
  throw error;
}

process.stdout.write(`${artifactPath}\n`);

async function verifyAudienceAssets() {
  assert.ok((await lstat(audienceDirectory)).isDirectory());

  for (const assetFile of assetFiles) {
    const asset = await lstat(resolve(audienceDirectory, assetFile));
    assert.ok(asset.isFile());
    assert.ok(!asset.isSymbolicLink());
  }

  const [index, audienceApp] = await Promise.all([
    readFile(resolve(audienceDirectory, "index.html"), "utf8"),
    readFile(resolve(audienceDirectory, "app.js"), "utf8"),
  ]);
  assert.match(index, /href="\.\/styles\.css"/);
  assert.match(index, /src="\.\/app\.js"/);

  for (const pattern of forbiddenAudienceSource) {
    assert.doesNotMatch(audienceApp, pattern);
  }
}

function verifyArtifactIsIgnored() {
  execFileSync("git", ["check-ignore", "--quiet", artifactPath], {
    cwd: projectRoot,
    stdio: "ignore",
  });
}
