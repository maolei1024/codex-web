#!/usr/bin/env node
/** Read-only browser measurements. Never submit a task, emit cookies or record page text. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import WebSocket from "ws";

const version = await (
  await fetch("http://100.90.94.39:39222/json/version")
).json();
const wsUrl = new URL(version.webSocketDebuggerUrl);
wsUrl.hostname = "100.90.94.39";
wsUrl.port = "39222";
const socket = new WebSocket(wsUrl);
await new Promise((resolve, reject) => {
  socket.once("open", resolve);
  socket.once("error", reject);
});
let nextId = 0;
const pending = new Map();
const exceptions = [];
socket.on("message", (raw) => {
  const response = JSON.parse(raw);
  if (response.id && pending.has(response.id)) {
    const call = pending.get(response.id);
    pending.delete(response.id);
    clearTimeout(call.timer);
    if (response.error) call.reject(new Error(response.error.message));
    else call.resolve(response.result);
  } else if (response.method === "Runtime.exceptionThrown") {
    exceptions.push({
      text: response.params.exceptionDetails.text,
      name: response.params.exceptionDetails.exception?.className,
    });
  }
});
function cdp(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, 20000);
    pending.set(id, { resolve, reject, timer });
    socket.send(
      JSON.stringify({
        id,
        method,
        params,
        ...(sessionId ? { sessionId } : {}),
      }),
    );
  });
}
const env = await readFile("/home/ml/.config/codex-web/env", "utf8");
let token = env.match(/^CODEX_WEB_TOKEN=(.*)$/m)?.[1]?.trim();
if (token?.startsWith('"') || token?.startsWith("'"))
  token = token.slice(1, -1);
if (!token) throw new Error("authentication unavailable");
const keepPage = process.argv.includes("--keep-page");
const onlyCandidate = process.argv.includes("--candidate-only");
const short = process.argv.includes("--smoke");
const profile = process.argv.includes("--profile");
const unthrottled = process.argv.includes("--unthrottled");
const persistent = process.argv.includes("--persistent");
const outputRoot =
  "/srv/docker-data/codex-maintenance/tmp/perf-verification-20260907";
await mkdir(outputRoot, { recursive: true, mode: 0o700 });
const contexts = [];
const ordinaryTargets = [];
const results = [];
try {
  for (const [label, port] of onlyCandidate
    ? [["candidate", 28214]]
    : [
        ["baseline", 28215],
        ["candidate", 28214],
      ]) {
    const browserContextId = persistent
      ? undefined
      : (await cdp("Target.createBrowserContext")).browserContextId;
    if (browserContextId) contexts.push(browserContextId);
    const origin = `http://${persistent ? `${label}-perf-20260907.localhost` : "localhost"}:${port}`;
    const { targetId } = await cdp("Target.createTarget", {
      url: "about:blank",
      ...(browserContextId ? { browserContextId } : {}),
      background: true,
    });
    const { sessionId } = await cdp("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    if (persistent) ordinaryTargets.push({ targetId, origin, sessionId });
    await cdp("Page.enable", {}, sessionId);
    await cdp("Runtime.enable", {}, sessionId);
    await cdp("Network.enable", {}, sessionId);
    await cdp(
      "Network.setCookie",
      {
        name: "codex_web_token",
        value: token,
        url: `${origin}/`,
        httpOnly: true,
        sameSite: "Lax",
      },
      sessionId,
    );
    await cdp(
      "Emulation.setDeviceMetricsOverride",
      { width: 1365, height: 900, deviceScaleFactor: 1, mobile: false },
      sessionId,
    );
    if (!unthrottled)
      await cdp(
        "Network.emulateNetworkConditions",
        {
          offline: false,
          latency: 80,
          downloadThroughput: (10 * 1024 * 1024) / 8,
          uploadThroughput: (5 * 1024 * 1024) / 8,
          connectionType: "wifi",
        },
        sessionId,
      );
    await cdp(
      "Page.addScriptToEvaluateOnNewDocument",
      {
        source: `
      window.__codexPerfProbe = {readyAt:null, lcp:null, cls:0, longTasks:[], events:[]};
      try {new PerformanceObserver(list => {for(const e of list.getEntries()) window.__codexPerfProbe.longTasks.push({start:e.startTime,duration:e.duration})}).observe({type:'longtask',buffered:true});} catch {}
      try {new PerformanceObserver(list => {for(const e of list.getEntries()) window.__codexPerfProbe.lcp=e.startTime}).observe({type:'largest-contentful-paint',buffered:true});} catch {}
      try {new PerformanceObserver(list => {for(const e of list.getEntries()) if(!e.hadRecentInput) window.__codexPerfProbe.cls+=e.value}).observe({type:'layout-shift',buffered:true});} catch {}
      try {new PerformanceObserver(list => {for(const e of list.getEntries()) window.__codexPerfProbe.events.push({name:e.name,duration:e.duration})}).observe({type:'event',durationThreshold:16,buffered:true});} catch {}
      const timer=setInterval(()=>{const e=document.querySelector('.ProseMirror[contenteditable="true"]');const threads=document.querySelectorAll('[data-app-action-sidebar-thread-id]').length;if(e&&e.getBoundingClientRect().height>0&&threads>0){window.__codexPerfProbe.readyAt=performance.now();window.__codexPerfProbe.threadCount=threads;clearInterval(timer)}},25);
    `,
      },
      sessionId,
    );
    for (let run = 0; run < (short ? 2 : 6); run++) {
      exceptions.length = 0;
      if (profile && run === 1) {
        await cdp("Profiler.enable", {}, sessionId);
        await cdp("Profiler.start", {}, sessionId);
      }
      await cdp("Page.navigate", { url: `${origin}/` }, sessionId);
      let metrics;
      for (let attempt = 0; attempt < 90; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const evaluated = await cdp(
          "Runtime.evaluate",
          {
            expression: `JSON.stringify({probe:window.__codexPerfProbe,marks:performance.getEntriesByType('mark').filter(e=>e.name.startsWith('codex-web:statsig')).map(e=>({name:e.name,time:e.startTime})),secure:isSecureContext,editorCount:document.querySelectorAll('.ProseMirror[contenteditable="true"]').length,bodySize:document.body?.textContent?.length||0})`,
            returnByValue: true,
          },
          sessionId,
        );
        if (!evaluated.result?.value) continue;
        metrics = JSON.parse(evaluated.result.value);
        if (metrics.probe?.readyAt) break;
      }
      const row = { label, run, ...metrics, exceptions: [...exceptions] };
      results.push(row);
      console.log(JSON.stringify(row));
      if (profile && run === 1) {
        const { profile: cpu } = await cdp("Profiler.stop", {}, sessionId);
        const nodes = new Map(cpu.nodes.map((n) => [n.id, n]));
        const selfTimes = new Map();
        cpu.samples.forEach((id, index) =>
          selfTimes.set(
            id,
            (selfTimes.get(id) || 0) + (cpu.timeDeltas[index] || 0),
          ),
        );
        row.cpuTop = [...selfTimes]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 20)
          .map(([id, microseconds]) => ({
            name: nodes.get(id).callFrame.functionName,
            file: nodes.get(id).callFrame.url.split("/").pop(),
            line: nodes.get(id).callFrame.lineNumber + 1,
            selfMs: Math.round(microseconds / 1000),
          }));
        console.log(JSON.stringify({ label, cpuTop: row.cpuTop }));
      }
      await new Promise((resolve) =>
        setTimeout(resolve, run === 0 ? 3500 : 500),
      );
      if (!metrics?.probe?.readyAt) break;
    }
    if (keepPage)
      console.log(
        JSON.stringify({
          retainedPage: { label, targetId, browserContextId, port },
        }),
      );
    else if (browserContextId) {
      await cdp("Target.disposeBrowserContext", { browserContextId });
      contexts.splice(contexts.indexOf(browserContextId), 1);
    }
  }
  await writeFile(
    `${outputRoot}/${persistent ? "persistent-" : ""}${unthrottled ? "local-" : ""}${short ? "smoke" : "benchmark"}.json`,
    `${JSON.stringify({ conditions: { latencyMs: unthrottled ? null : 80, downMbps: unthrottled ? null : 10, upMbps: unthrottled ? null : 5, browser: version.Browser, readyCriterion: "visible editor and nonempty task list", cpuProfile: profile, persistent }, results }, null, 2)}\n`,
    { mode: 0o600 },
  );
} finally {
  if (!keepPage)
    for (const browserContextId of contexts)
      await cdp("Target.disposeBrowserContext", { browserContextId }).catch(
        () => {},
      );
  if (!keepPage)
    for (const { targetId, origin, sessionId } of ordinaryTargets) {
      await cdp(
        "Network.deleteCookies",
        { name: "codex_web_token", url: origin },
        sessionId,
      ).catch(() => {});
      await cdp("Storage.clearDataForOrigin", {
        origin,
        storageTypes: "all",
      }).catch(() => {});
      await cdp("Target.closeTarget", { targetId }).catch(() => {});
    }
  socket.close();
}
