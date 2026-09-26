#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEXT_EXTENSIONS = new Set([
  ".html",
  ".js",
  ".mjs",
  ".css",
  ".json",
  ".svg",
  ".webmanifest",
]);

export function rewriteAssetUrls(text, buildId, isDocument = false) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(buildId))
    throw new Error("invalid local build id");
  // Relative module imports inherit this namespace. Match only root-relative URL
  // literals, never API paths such as /wham/shared_threads/<id>/assets/<id>.
  if (isDocument) {
    text = text.replace(/(["'])\.\/assets\//g, `$1/assets/__build/${buildId}/`);
  }
  return text.replace(
    /(["'`(])\/assets\/(?:__build\/[A-Za-z0-9._-]+\/)?/g,
    `$1/assets/__build/${buildId}/`,
  );
}

export async function versionAssets(root, buildId) {
  let changed = 0;
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(filename);
      else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(filename))) {
        const original = await fs.readFile(filename, "utf8");
        const updated = rewriteAssetUrls(
          original,
          buildId,
          path.extname(filename) === ".html",
        );
        if (updated !== original) {
          await fs.writeFile(filename, updated);
          changed++;
        }
      }
    }
  }
  await walk(root);
  const manifestPath = path.join(root, "asset-version.json");
  const manifest = `${JSON.stringify({ id: buildId })}\n`;
  if ((await fs.readFile(manifestPath, "utf8").catch(() => "")) !== manifest) {
    await fs.writeFile(manifestPath, manifest);
  }
  return changed;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const build = JSON.parse(
    await fs.readFile(path.join(repo, "local-build.json"), "utf8"),
  );
  if (!process.argv[2])
    throw new Error("usage: version-assets.mjs <webview root>");
  console.log(
    `Versioned ${await versionAssets(path.resolve(process.argv[2]), build.id)} assets for ${build.id}`,
  );
}
