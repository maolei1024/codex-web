import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import { initializeContainer } from "../scripts/container-init.mjs";

test("container restarts preserve edited connections and configuration while allowing SSH key rotation", async () => {
  const root = await mkdtemp(`${tmpdir()}/codex-web-init-`);
  const env = {
    HOME: `${root}/home`, CODEX_HOME: `${root}/codex`, CODEX_WEB_DATA_DIR: `${root}/app`,
    CODEX_WEB_DOCUMENTS_DIR: `${root}/documents`, CODEX_WEB_UPLOAD_ROOT: `${root}/uploads`,
    CODEX_WEB_SEED_DIR: `${root}/seed`,
  };
  try {
    await mkdir(env.CODEX_WEB_SEED_DIR);
    for (const name of ["config.toml", "auth.json", "remote-connections.json", "ssh-private-key"])
      await writeFile(`${root}/seed/${name}`, "initial");
    await initializeContainer(env);
    await writeFile(`${root}/codex/codex-app/config.json`, "edited projects");
    await writeFile(`${root}/codex/config.toml`, "edited config");
    await writeFile(`${root}/seed/ssh-private-key`, "rotated key");
    await initializeContainer(env);
    assert.equal(await readFile(`${root}/codex/codex-app/config.json`, "utf8"), "edited projects");
    assert.equal(await readFile(`${root}/codex/config.toml`, "utf8"), "edited config");
    assert.equal(await readFile(`${root}/home/.ssh/id_ed25519`, "utf8"), "rotated key");
    assert.equal((await stat(`${root}/codex/auth.json`)).mode & 0o777, 0o600);
    assert.equal((await stat(`${root}/home/.ssh/id_ed25519`)).mode & 0o777, 0o600);
  } finally { await rm(root, { recursive: true, force: true }); }
});
