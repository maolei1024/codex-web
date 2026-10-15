// Run as the container user, so venv paths and ownership match the live mount.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
const root = "/data/tools";
const record = `${root}/versions.json`;
const versions = JSON.parse(readFileSync(record, "utf8"));
const uvArtifact = versions.artifacts.find(a => a.target.startsWith("uv/"));
const uv = `${root}/${uvArtifact.target}/uv`;
const env = { ...process.env,
  UV_PYTHON_INSTALL_DIR: `${root}/python/managed`,
  UV_PYTHON_BIN_DIR: `${root}/python/bin`,
  UV_CACHE_DIR: "/data/home/.cache/uv",
};
const version = versions.python?.version || versions.python_minor;
execFileSync(uv, ["python", "install", version], { env, stdio: "inherit" });
const venv = `${root}/python/venv`;
if (!existsSync(`${venv}/pyvenv.cfg`)) {
  execFileSync(uv, ["venv", "--seed", "--python", version, venv], { env, stdio: "inherit" });
}
const python = JSON.parse(execFileSync(`${venv}/bin/python`, ["-c",
  "import json,sys,platform,importlib.metadata; print(json.dumps(dict(version=platform.python_version(),prefix=sys.prefix,base_prefix=sys.base_prefix,pip=importlib.metadata.version('pip'))))",
], { env, encoding: "utf8" }));
if (!python.version.startsWith(`${versions.python_minor}.`) || python.prefix !== venv ||
    !python.base_prefix.startsWith(env.UV_PYTHON_INSTALL_DIR + "/")) {
  throw new Error("Existing venv does not match the managed Python 3.13 installation");
}
const downloads = JSON.parse(execFileSync(uv, ["python", "list", python.version,
  "--only-downloads", "--output-format", "json"], { env, encoding: "utf8" }));
const download = downloads.find(item => item.key === python.base_prefix.split("/").at(-1));
if (!download?.url) throw new Error("Managed Python download missing from the verified uv catalog");
versions.python = { ...python, manager: `uv ${uvArtifact.version}`, url: download.url,
  checksumVerification: "uv built-in download catalog (verified uv artifact)",
  distribution: "https://github.com/astral-sh/python-build-standalone" };
writeFileSync(record, JSON.stringify(versions, null, 2) + "\n");
console.log("Persistent Python:", JSON.stringify(versions.python));
