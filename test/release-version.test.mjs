import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("extracted Desktop and asset namespace match the shared release manifest", async () => {
  const release = JSON.parse(await readFile("local-build.json", "utf8"));
  const desktop = JSON.parse(
    await readFile("scratch/asar/package.json", "utf8"),
  );
  assert.equal(desktop.version, release.desktopVersion);
  assert.ok(release.id.startsWith(`${release.desktopVersion}-`));
  assert.match(release.desktopSha256, /^[a-f0-9]{64}$/);
  assert.match(release.codexCliVersion, /^\d+\.\d+\.\d+$/);
  for (const platform of [
    "linux-x64",
    "linux-arm64",
    "darwin-x64",
    "darwin-arm64",
  ]) {
    assert.match(
      release.codexCliHashes[platform],
      /^sha256-[A-Za-z0-9+/]{43}=$/,
    );
  }
});
