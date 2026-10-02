import assert from "node:assert/strict";
import test from "node:test";
import { importTypescriptModule } from "./import-typescript-module.mjs";

const { adaptDesktopBridge, desktopCapabilityOverrides: overrides } =
  await importTypescriptModule("src/browser/desktop-capabilities.ts");

test("translation loading is enabled while keeping locale policy and metadata", () => {
  const config = Object.freeze({
    name: "72216192",
    rule_id: "upstream",
    __value: Object.freeze({ enable_i18n: false, locale_source: "SYSTEM" }),
  });
  assert.deepEqual(overrides.getLayerOverride(config), {
    ...config,
    __value: { enable_i18n: true, locale_source: "SYSTEM" },
  });
  assert.deepEqual(
    overrides.getLayerOverride({ name: "72216192", __value: {} }).__value,
    { enable_i18n: true },
  );
  assert.equal(
    overrides.getLayerOverride({ name: "unrelated", __value: {} }),
    null,
  );
});

test("SSH and activity UI work without Statsig values; unknown permissions are untouched", () => {
  for (const name of ["4114442250", "4039078146"]) {
    const evaluation = Object.freeze({
      name,
      value: false,
      details: { reason: "NoValues" },
    });
    assert.deepEqual(overrides.getGateOverride(evaluation), {
      ...evaluation,
      value: true,
    });
  }
  assert.equal(
    overrides.getGateOverride({ name: "cloud-projects", value: false }),
    null,
  );
  assert.equal(
    overrides.getDynamicConfigOverride({
      name: "account-permissions",
      value: {},
    }),
    null,
  );
});

test("native model availability is authoritative, including empty or restricted catalogs", () => {
  for (const available_models of [[], ["gpt-6-astra"], ["gpt-6.1-sol"]]) {
    const evaluation = Object.freeze({
      name: "107580212",
      value: Object.freeze({ available_models: Object.freeze(available_models) }),
    });
    assert.equal(overrides.getDynamicConfigOverride(evaluation), null);
  }
});

test("browser bridge selects Desktop's DOM menus while retaining SSH and IPC methods", () => {
  const native = Object.freeze({
    showContextMenu() {
      throw new Error("native menu must not run in a browser");
    },
    sendMessageFromView: (...args) => args,
    getSharedObjectSnapshotValue: () => ["remote-host"],
  });
  const browser = adaptDesktopBridge("electronBridge", native);
  assert.equal(browser.showContextMenu, undefined);
  assert.deepEqual(browser.sendMessageFromView("request"), ["request"]);
  assert.deepEqual(browser.getSharedObjectSnapshotValue(), ["remote-host"]);
  assert.equal(typeof native.showContextMenu, "function");
  assert.equal(adaptDesktopBridge("otherBridge", native), native);
});
