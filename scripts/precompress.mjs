#!/usr/bin/env node

// Generates .br and .gz siblings for compressible webview assets so
// @fastify/static (preCompressed: true) can serve them without runtime
// compression. Skips files whose compressed siblings are already newer
// than the source, so reruns are cheap.

import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import zlib from "node:zlib";

const brotliCompress = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

const COMPRESSIBLE_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".map",
  ".mjs",
  ".svg",
  ".txt",
  ".wasm",
  ".webmanifest",
]);

const MIN_SIZE_BYTES = 1024;

async function* walk(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* walk(entryPath);
    } else if (entry.isFile()) {
      yield entryPath;
    }
  }
}

async function isUpToDate(sourceMtimeMs, targetPath) {
  try {
    return (await fs.stat(targetPath)).mtimeMs >= sourceMtimeMs;
  } catch {
    return false;
  }
}

async function main() {
  const rootArgument = process.argv[2];
  if (!rootArgument) {
    console.error("usage: precompress.mjs <directory>");
    process.exit(1);
  }

  const root = path.resolve(rootArgument);
  try {
    await fs.access(root);
  } catch {
    console.log(`precompress: ${root} does not exist yet, skipping`);
    return;
  }

  let compressedCount = 0;
  let sourceBytes = 0;
  let brotliBytes = 0;

  for await (const filePath of walk(root)) {
    const extension = path.extname(filePath);
    if (!COMPRESSIBLE_EXTENSIONS.has(extension)) {
      continue;
    }

    const stat = await fs.stat(filePath);
    if (stat.size < MIN_SIZE_BYTES) {
      continue;
    }

    const brotliPath = `${filePath}.br`;
    const gzipPath = `${filePath}.gz`;
    if (
      (await isUpToDate(stat.mtimeMs, brotliPath)) &&
      (await isUpToDate(stat.mtimeMs, gzipPath))
    ) {
      continue;
    }

    const contents = await fs.readFile(filePath);
    const [brotliContents, gzipContents] = await Promise.all([
      brotliCompress(contents, {
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: contents.length,
        },
      }),
      gzip(contents, { level: 9 }),
    ]);
    await Promise.all([
      fs.writeFile(brotliPath, brotliContents),
      fs.writeFile(gzipPath, gzipContents),
    ]);

    compressedCount += 1;
    sourceBytes += contents.length;
    brotliBytes += brotliContents.length;
  }

  console.log(
    `precompressed ${compressedCount} files: ` +
      `${(sourceBytes / 1024 / 1024).toFixed(1)}MiB -> ` +
      `${(brotliBytes / 1024 / 1024).toFixed(1)}MiB brotli`,
  );
}

await main();
