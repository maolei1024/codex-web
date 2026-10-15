import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, symlinkSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("archive extraction accepts JDK links and rejects escaping paths", () => {
  execFileSync("python3", ["-B", "-m", "unittest", "discover", "-s", "test",
    "-p", "test_persistent_tools_installer.py"], { stdio: "pipe" });
});

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "codex-tools-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, "tools");
  const bin = path.join(dir, "bin");
  mkdirSync(root); mkdirSync(bin);
  copyFileSync("scripts/persistent-tools-env.sh", path.join(root, "env.sh"));
  // Bash may treat Node's socket-backed stdin as a remote shell and read
  // .bashrc instead of BASH_ENV, matching the container's existing hook.
  writeFileSync(path.join(dir, ".bashrc"), '. "$BASH_ENV"\n');
  const wrapper = path.join(root, "persistent-tool");
  copyFileSync("scripts/persistent-tool", wrapper);
  execFileSync("chmod", ["+x", wrapper]);
  for (const name of ["python", "pip", "java", "java8", "javac24", "with-java"])
    symlinkSync(wrapper, path.join(bin, name));
  function executable(relative, body) {
    const file = path.join(dir, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return file;
  }
  executable("tools/python/venv/bin/python", 'printf "default-python:%s\\n" "$*"');
  executable("project/bin/python", 'printf "project-python:%s\\n" "$*"');
  for (const major of [8, 24, 25]) {
    executable(`tools/java/${major}/bin/java`, `echo java-${major}`);
    executable(`tools/java/${major}/bin/javac`, `echo javac-${major}`);
  }
  const env = {
    HOME: dir, PATH: "/usr/bin:/bin", CODEX_TOOLS_ROOT: root,
    CODEX_TOOLS_BIN: bin, BASH_ENV: path.join(root, "env.sh"),
  };
  const shell = (script, extra = {}, shellName = "bash") => execFileSync(shellName, ["-c", script], {
    env: { ...env, ...extra }, encoding: "utf8",
  }).trim();
  return { dir, root, bin, env, shell };
}

test("noninteractive Bash loads defaults and repeated sourcing does not grow PATH", t => {
  const f = fixture(t);
  assert.equal(f.shell('before=$PATH; . "$BASH_ENV"; . "$BASH_ENV"; [ "$PATH" = "$before" ]; python --version'), "default-python:--version");
  assert.equal(f.shell('pip install sample'), "default-python:-m pip install sample");
  assert.equal(execFileSync("bash", ["-c", "python -V"], {
    env: f.env, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8",
  }).trim(), "default-python:-V");
});

test("project venv survives BASH_ENV and Python wrappers honor it", t => {
  const f = fixture(t);
  const project = path.join(f.dir, "project");
  assert.equal(f.shell('python -V', { VIRTUAL_ENV: project }), "project-python:-V");
  assert.equal(f.shell('"$CODEX_TOOLS_BIN/pip" list', { VIRTUAL_ENV: project }), "project-python:-m pip list");
});

test("old PATH snapshots and plain sh can use persistent entrypoints", t => {
  const f = fixture(t);
  assert.equal(f.shell('python -V; java', { PATH: `${f.bin}:/usr/bin:/bin` }, "sh"), "default-python:-V\njava-25");
});

test("Java selection stays inside the child command and respects explicit JAVA_HOME", t => {
  const f = fixture(t);
  assert.equal(f.shell('java; with-java 8 java; java; java8; javac24'), "java-25\njava-8\njava-25\njava-8\njavac-24");
  assert.equal(f.shell('java', { JAVA_HOME: path.join(f.root, "java/24") }), "java-24");
  const bad = spawnSync(path.join(f.bin, "with-java"), ["17", "java"], { env: f.env });
  assert.equal(bad.status, 2);
});
