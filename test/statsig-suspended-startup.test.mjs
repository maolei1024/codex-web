import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import vm from "node:vm";
import test from "node:test";
import * as React from "react";
import { renderToPipeableStream } from "react-dom/server";

// Run the pinned Desktop hook with real React. A streaming render cannot commit
// a state setter while suspended, reproducing the browser's interrupted mount.
async function hook(client) {
  const bundle = await readFile(
    "scratch/asar/webview/assets/app-initial-236e1501144c.js",
    "utf8",
  );
  const start = bundle.search(/_Tn\s*=\s*i\(/);
  const end = bundle.indexOf("vTn", start);
  assert.ok(start >= 0 && end > start);
  const source = bundle.slice(start, end).trim().replace(/,$/, ";");
  return vm.runInNewContext(
    `let ${source}; _Tn.useStatsigInternalClientFactoryAsync`,
    {
      i: (factory) => {
        const exports = {};
        factory(exports);
        return exports;
      },
      c: () => React,
      cx: () => ({ _getInstance: () => client, Log: { error() {} } }),
    },
  );
}

function render(useClient) {
  let stream;
  let timer;
  const errors = [];
  const result = new Promise((resolve, reject) => {
    function App() {
      const { client, isLoading } = useClient(
        () => assert.fail("already exists"),
        { sdkKey: "test" },
      );
      return React.createElement(
        "p",
        null,
        isLoading ? "loading" : client.loadingStatus,
      );
    }
    stream = renderToPipeableStream(
      React.createElement(
        React.Suspense,
        { fallback: "waiting" },
        React.createElement(App),
      ),
      {
        onError: (error) => {
          errors.push(error);
        },
        onAllReady() {
          const output = new PassThrough();
          let html = "";
          output.on("data", (chunk) => {
            html += chunk;
          });
          output.on("end", () => resolve({ html, errors }));
          output.on("error", reject);
          stream.pipe(output);
        },
      },
    );
    timer = setTimeout(() => {
      stream.abort();
      reject(Error("suspended render never completed"));
    }, 1000);
  }).finally(() => clearTimeout(timer));
  return result;
}

test("actual Desktop hook wakes suspended concurrent roots and shares initialization", async () => {
  let finish,
    calls = 0;
  const client = {
    loadingStatus: "Loading",
    initializeAsync() {
      calls++;
      return new Promise((resolve) => {
        finish = () => {
          client.loadingStatus = "Ready";
          resolve({ success: false });
        };
      });
    },
  };
  const useClient = await hook(client);
  const a = render(useClient),
    b = render(useClient);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  finish();
  for (const { html, errors } of await Promise.all([a, b])) {
    assert.match(html, /<p>Ready<\/p>/);
    assert.deepEqual(errors, []);
  }
  const ready = await render(useClient);
  assert.match(ready.html, /<p>Ready<\/p>/);
  assert.equal(calls, 1);
});

test("actual Desktop hook surfaces SDK rejection and never fabricates Ready", async () => {
  for (const rejects of [true, false]) {
    const failure = Error("initialization failed");
    const client = {
      loadingStatus: "Loading",
      initializeAsync: () =>
        rejects ? Promise.reject(failure) : Promise.resolve({ success: false }),
    };
    const { html, errors } = await render(await hook(client));
    assert.equal(errors.length, 1);
    assert.match(
      errors[0].message,
      rejects ? /initialization failed/ : /did not complete/,
    );
    assert.doesNotMatch(html, /<p>Ready<\/p>/);
    assert.equal(client.loadingStatus, "Loading");
  }
});
