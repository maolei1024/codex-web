import { constants } from "node:fs";
import { chmod, copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function initializeContainer(env = process.env) {
  const home = env.HOME;
  const codex = env.CODEX_HOME;
  const data = env.CODEX_WEB_DATA_DIR;
  if (![home, codex, data, env.CODEX_WEB_DOCUMENTS_DIR, env.CODEX_WEB_UPLOAD_ROOT].every(
    (value) => value && path.isAbsolute(value),
  )) throw new Error("Container state directories must be absolute paths");
  const ssh = path.join(home, ".ssh");
  for (const directory of [
    home, codex, path.join(codex, "codex-app"), ssh,
    path.join(env.CODEX_WEB_DOCUMENTS_DIR, "ChatGPT"), env.CODEX_WEB_UPLOAD_ROOT,
    ...["userData", "sessionData", "cache", "logs", "temp"].map((name) => path.join(data, name)),
  ]) await mkdir(directory, { recursive: true, mode: 0o700 });
  const seed = env.CODEX_WEB_SEED_DIR || "/run/codex-web-seed";
  for (const [source, target, replace] of [
    ["config.toml", path.join(codex, "config.toml"), false],
    ["auth.json", path.join(codex, "auth.json"), false],
    ["remote-connections.json", path.join(codex, "codex-app/config.json"), false],
    ["ssh-config", path.join(ssh, "config"), true],
    ["ssh-known-hosts", path.join(ssh, "known_hosts"), true],
    ["ssh-private-key", path.join(ssh, "id_ed25519"), true],
  ]) {
    try {
      await copyFile(path.join(seed, source), target, replace ? 0 : constants.COPYFILE_EXCL);
      await chmod(target, 0o600);
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "EEXIST") throw error;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await initializeContainer();
}
