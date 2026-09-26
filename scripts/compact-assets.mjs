#!/usr/bin/env node
/** Undo patch-time pretty-printing; no dead-code removal, renaming or rebundling. */
import { promises as fs } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// Use the exact parser/code generator shipped with the locked Vite toolchain.
const require = createRequire(import.meta.url);
const viteRequire = createRequire(require.resolve("vite/package.json"));
const { minify } = await import(
  pathToFileURL(viteRequire.resolve("rolldown/experimental"))
);

export async function compactJavascript(filename, source) {
  const result = await minify(filename, source, {
    module: true,
    compress: false,
    mangle: false,
    codegen: { removeWhitespace: true, legalComments: "inline" },
  });
  if (result.errors.length) throw new Error(`Cannot compact ${filename}`);
  return result.code;
}

export async function compactAssets(root) {
  let before = 0,
    after = 0,
    count = 0;
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
    // preload has its own source map and remains owned by Vite.
    if (entry.name === "preload.js") continue;
    const filename = path.join(root, entry.name);
    const source = await fs.readFile(filename, "utf8");
    if (source.length < 50_000 || source.split("\n").length < 500) continue;
    const compact = await compactJavascript(entry.name, source);
    before += Buffer.byteLength(source);
    after += Buffer.byteLength(compact);
    count++;
    await fs.writeFile(filename, compact);
  }
  return { count, before, after };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (!process.argv[2])
    throw new Error("usage: compact-assets.mjs <asset root>");
  console.log(
    JSON.stringify(await compactAssets(path.resolve(process.argv[2]))),
  );
}
