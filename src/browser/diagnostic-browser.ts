import { DiagnosticJournal } from "./diagnostic-journal";

/** Observers are fail-open and never read DOM text, request bodies or response bodies. */
export function installDiagnosticObservers(
  journal: DiagnosticJournal,
  target: Window = window,
) {
  const cleanups: (() => void)[] = [];
  const listen = (name: string, fn: EventListener, capture = false) => {
    target.addEventListener(name, fn, capture);
    cleanups.push(() => target.removeEventListener(name, fn, capture));
  };
  listen(
    "error",
    ((event: ErrorEvent) => {
      if (event.target !== target && event.target != null)
        journal.error(new Error("resource load failed"), {
          layer: "browser",
          category: "resource-load",
        });
      else
        journal.error(event.error ?? event.message, {
          layer: "browser",
          category: "uncaught-exception",
        });
    }) as EventListener,
    true,
  );
  listen("unhandledrejection", ((event: PromiseRejectionEvent) => {
    journal.error(event.reason, {
      layer: "browser",
      category: "unhandled-rejection",
    });
  }) as EventListener);
  listen("pagehide", (() => journal.flush()) as EventListener);
  const lifecycle = () =>
    journal.lifecycle("visibility", {
      hidden: target.document.visibilityState === "hidden",
      online: target.navigator.onLine !== false,
    });
  target.document.addEventListener("visibilitychange", lifecycle);
  cleanups.push(() =>
    target.document.removeEventListener("visibilitychange", lifecycle),
  );
  listen("online", lifecycle);
  listen("offline", lifecycle);
  lifecycle();

  const perf = target.performance;
  const resource = (entry: PerformanceResourceTiming) => {
    let url: URL;
    try {
      url = new URL(entry.name, target.location.href);
    } catch {
      return;
    }
    const sameOrigin = url.origin === target.location.origin;
    const known =
      sameOrigin &&
      (url.pathname.startsWith("/assets/") ||
        url.pathname.startsWith("/__backend/"));
    if (!known && entry.entryType !== "navigation") return;
    // Values of zero can mean reused connections, cache, or restricted timing.
    const timing = entry.responseStart > 0;
    journal.record("performance", {
      method: entry.entryType === "navigation" ? "navigation" : "resource",
      category: url.pathname.startsWith("/assets/") ? "resource" : "http",
      id: journal.alias(url.pathname),
      initiatorType: entry.initiatorType,
      protocol: entry.nextHopProtocol,
      startTime: entry.startTime,
      durationMs: entry.duration,
      transferBytes: timing ? entry.transferSize : null,
      encodedBytes: timing ? entry.encodedBodySize : null,
      decodedBytes: timing ? entry.decodedBodySize : null,
      ttfbMs:
        timing && entry.requestStart > 0
          ? entry.responseStart - entry.requestStart
          : null,
      downloadMs: timing ? entry.responseEnd - entry.responseStart : null,
      dnsMs:
        entry.domainLookupEnd > 0
          ? entry.domainLookupEnd - entry.domainLookupStart
          : null,
      connectMs:
        entry.connectEnd > 0 ? entry.connectEnd - entry.connectStart : null,
      tlsMs:
        entry.secureConnectionStart > 0
          ? entry.connectEnd - entry.secureConnectionStart
          : null,
      supported: timing,
      ...("domInteractive" in entry
        ? {
            domInteractive: (entry as PerformanceNavigationTiming)
              .domInteractive,
            domContentLoadedEventEnd: (entry as PerformanceNavigationTiming)
              .domContentLoadedEventEnd,
            loadEventEnd: (entry as PerformanceNavigationTiming).loadEventEnd,
          }
        : {}),
    });
  };
  const observe = (
    type: string,
    callback: (entry: PerformanceEntry) => void,
    capability: string,
  ) => {
    try {
      const Observer = (
        target as unknown as {
          PerformanceObserver?: typeof PerformanceObserver;
        }
      ).PerformanceObserver;
      if (!Observer || !Observer.supportedEntryTypes?.includes(type))
        throw new Error();
      const observer = new Observer((list) => {
        for (const entry of list.getEntries())
          try {
            callback(entry);
          } catch {}
      });
      observer.observe({ type, buffered: true });
      journal.record("performance", { capability, supported: true });
      cleanups.push(() => observer.disconnect());
    } catch {
      journal.record("performance", { capability, supported: false });
    }
  };
  observe(
    "resource",
    (entry) => resource(entry as PerformanceResourceTiming),
    "resourceTiming",
  );
  observe(
    "navigation",
    (entry) => resource(entry as PerformanceNavigationTiming),
    "navigationTiming",
  );
  observe(
    "longtask",
    (entry) =>
      journal.record("performance", {
        method: "longtask",
        startTime: entry.startTime,
        durationMs: entry.duration,
      }),
    "longTasks",
  );
  observe(
    "paint",
    (entry) =>
      journal.milestone("paint", entry.name, { startTime: entry.startTime }),
    "paint",
  );
  observe(
    "mark",
    (entry) => {
      if (!entry.name.startsWith("codex-web:statsig-")) return;
      journal.record("performance", {
        method: "statsig",
        phase: entry.name.slice("codex-web:".length),
        startTime: entry.startTime,
      });
    },
    "mark",
  );
  if (!perf)
    journal.record("performance", {
      capability: "resourceTiming",
      supported: false,
    });

  const original = target.fetch;
  if (typeof original === "function") {
    const wrapped: typeof fetch = function (input, init) {
      let method: string | undefined;
      try {
        const url = new URL(
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
          target.location.href,
        );
        if (url.origin === target.location.origin)
          method = (
            {
              "/__backend/upload": "upload",
              "/__backend/binary-read": "binary-read",
              "/__backend/shared-object/statsig-evaluations": "shared-object",
              "/__backend/feature-config": "feature-config",
            } as Record<string, string>
          )[url.pathname];
      } catch {}
      if (!method) return original.call(target, input, init);
      let bytes: number | undefined;
      try {
        if (init?.body instanceof Blob) bytes = init.body.size;
        if (init?.body instanceof FormData) {
          bytes = 0;
          for (const value of init.body.values())
            if (value instanceof Blob) bytes += value.size;
        }
      } catch {}
      const signal =
        init?.signal ??
        (typeof Request !== "undefined" && input instanceof Request
          ? input.signal
          : undefined);
      const id = journal.begin(method, {
        layer: "http",
        httpMethod: init?.method ?? "GET",
        bytes,
      });
      // Header completion and full resource download are deliberately separate.
      try {
        return original.call(target, input, init).then(
          (response) => {
            const length = response.headers.get("content-length");
            journal.end(
              id,
              response.ok ? undefined : new Error(`HTTP ${response.status}`),
              {
                statusCode: response.status,
                phase: "response",
                transferBytes: length == null ? null : Number(length),
              },
            );
            return response;
          },
          (error) => {
            journal.end(id, error, {
              cancelSource: signal?.aborted ? "caller" : "unknown",
            });
            throw error;
          },
        );
      } catch (error) {
        journal.end(id, error);
        throw error;
      }
    };
    target.fetch = wrapped;
    cleanups.push(() => {
      if (target.fetch === wrapped) target.fetch = original;
    });
  }
  return () => {
    cleanups.forEach((fn) => fn());
    journal.dispose();
  };
}
