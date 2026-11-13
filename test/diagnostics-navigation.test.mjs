import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  process.env.CODEX_WEB_NAVIGATION_TEST_ASSET ||
    "scratch/asar/webview/assets/app-initial-1ab6fbe93c4f.js",
  "utf8",
);

function nativeFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `pinned Desktop ${name} must exist`);
  const next = source.indexOf("function ", start + 10);
  assert.ok(next > start);
  return source.slice(start, next);
}

function render({ locale = "zh-CN", exportDiagnostics, profile = false } = {}) {
  const jsx = (type, props) => ({ type, props });
  const compiler = {
    c: (length) => Array(length).fill(Symbol.for("react.memo_cache_sentinel")),
  };
  const state = { get() {}, set() {} };
  const context = {
    window: { __ELECTRON_SHIM__: { exportDiagnostics } },
    navigator: { language: "en-US", onLine: false },
    document: { documentElement: { lang: "en" } },
    D2: { jsx, jsxs: jsx, Fragment: "fragment" },
    S2o: { jsx, jsxs: jsx },
    N2o: compiler,
    x2o: compiler,
    zd: () => ({
      locale,
      formatMessage: ({ defaultMessage }) => defaultMessage,
    }),
    eg: (...classes) => classes.filter(Boolean).join(" "),
    Pn: "native-tooltip",
    A0o: "native-rail-button",
    op: "native-icon",
    ije: "native-download-icon",
    Oi: () => state,
    q: "store",
    G: (key) => (key === "profile-enabled" ? profile : false),
    wc: "profile-enabled",
    jr: "rail-state",
    P2o: { useContext: () => () => {} },
    Mni: "sidebar-context",
    mp: () => ({ accountId: "fixture", authMethod: "chatgpt" }),
    Xm: () => () => {},
    ij: "sidebar-customization",
    h2n: (value) => value,
    BN: () => [],
    XN: "drag-sensor",
    AFn: () => ({ moreDestinationIds: [], directDestinationIds: [] }),
    M2o: () => false,
    j2o: () => false,
    A2o: () => {},
    Jee: "settings-icon",
    $: "native-message",
    w2o: "profile-footer",
    JF: "native-list",
    O0o: "drag-modifier-a",
    D0o: "drag-modifier-b",
    E0o: "drag-modifier-c",
    x3n: "drag-context",
    $N: "sortable-list",
    nP: "sort-strategy",
    U0o: "more-menu",
    k2o: () => false,
  };
  return new Function(
    ...Object.keys(context),
    `${nativeFunction("webConnectionDiagnosticsRailButton")}
     ${nativeFunction("b2o")}
     ${nativeFunction("O2o")}
     return { button: webConnectionDiagnosticsRailButton, footer: b2o, rail: O2o };`,
  )(...Object.values(context));
}

function elements(node, predicate) {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node))
    return node.flatMap((child) => elements(child, predicate));
  return [
    ...(predicate(node) ? [node] : []),
    ...elements(node.props?.children, predicate),
  ];
}

test("navigation export uses the native rail button and tooltip and downloads synchronously while offline", () => {
  let clicking = false,
    downloads = 0;
  const native = render({
    exportDiagnostics: () => {
      assert.equal(clicking, true);
      downloads++;
    },
  });
  const tooltip = native.button();
  assert.equal(tooltip.type, "native-tooltip");
  assert.equal(tooltip.props.side, "right");
  assert.equal(tooltip.props.tooltipContent, "导出诊断");
  const button = tooltip.props.children;
  assert.equal(button.type, "native-rail-button");
  assert.equal(button.props["aria-label"], "导出诊断");
  assert.equal(button.props.disabled, undefined);
  assert.equal(button.props.children.props.asset, "native-download-icon");
  clicking = true;
  button.props.onClick();
  clicking = false;
  assert.equal(downloads, 1);
});

test("the compact footer places exactly one export immediately above the profile button", () => {
  const native = render({ exportDiagnostics() {} });
  const footer = native.footer({
    compact: true,
    leading: "profile",
    trailing: "usage",
  });
  const controls = footer.props.children[1].props.children;
  assert.equal(controls[1].props.children, "usage");
  assert.equal(controls[2].type, native.button);
  assert.equal(controls[3].props.children, "profile");
  assert.equal(
    elements(footer, (node) => node.type === native.button).length,
    1,
  );
  const expanded = native.footer({
    compact: false,
    leading: "profile",
    trailing: "usage",
  });
  assert.equal(
    elements(expanded, (node) => node.type === native.button).length,
    0,
  );
});

test("the settings fallback sits directly after export, while profile and custom footers stay intact", () => {
  const native = render({ exportDiagnostics() {} });
  const rail = native.rail({ availableDestinations: [] });
  assert.equal(rail.type, "nav");
  const footer = rail.props.children.at(-1);
  assert.equal(footer.type, "fragment");
  assert.equal(footer.props.children[0].type, native.button);
  assert.equal(
    footer.props.children[1].props.children.type,
    "native-rail-button",
  );
  assert.equal(
    footer.props.children[1].props.children.props.children[0].type,
    "settings-icon",
  );
  const profile = render({ exportDiagnostics() {}, profile: true }).rail({
    availableDestinations: [],
  });
  assert.equal(
    profile.props.children.at(-1).props.children.type,
    "profile-footer",
  );
  const custom = native.rail({
    availableDestinations: [],
    footer: "provided-footer",
  });
  assert.equal(custom.props.children.at(-1), "provided-footer");
});

test("the action follows app locale and is absent outside the Web shim", () => {
  assert.equal(render().button(), null);
  const native = render({ locale: "en-US", exportDiagnostics() {} });
  assert.equal(native.button().props.tooltipContent, "Export diagnostics");
});
