import fs from "node:fs/promises";
import path from "node:path";

export async function readAssetVersion(webviewRoot: string): Promise<string> {
  const build = JSON.parse(
    await fs.readFile(
      path.resolve(__dirname, "../../local-build.json"),
      "utf8",
    ),
  );
  const assets = JSON.parse(
    await fs.readFile(path.join(webviewRoot, "asset-version.json"), "utf8"),
  );
  if (
    typeof build.id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(build.id) ||
    assets.id !== build.id
  ) {
    throw new Error(
      "asset version does not match the local build; rebuild browser assets before starting",
    );
  }
  return build.id;
}
