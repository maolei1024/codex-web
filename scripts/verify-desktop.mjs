import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";

const release = JSON.parse(
  await readFile(new URL("../local-build.json", import.meta.url), "utf8"),
);
const archive = process.argv[2];
if (!archive) throw new Error("usage: verify-desktop.mjs <desktop.zip>");
const hash = createHash("sha256");
for await (const chunk of createReadStream(archive)) hash.update(chunk);
if (hash.digest("hex") !== release.desktopSha256) {
  throw new Error(
    `Desktop archive does not match pinned release ${release.desktopVersion}`,
  );
}
