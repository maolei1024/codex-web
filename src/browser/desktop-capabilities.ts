type GateEvaluation = {
  name: string;
  value: boolean;
  [key: string]: unknown;
};

type DynamicConfigEvaluation = {
  name: string;
  value: unknown;
  [key: string]: unknown;
};

type LayerEvaluation = {
  name: string;
  __value: Record<string, unknown>;
  [key: string]: unknown;
};

// Capabilities implemented by the pinned Desktop bundle and our Web bridge.
// Cloud/account permissions must continue to come from the signed-in account.
export const desktopCapabilityOverrides = {
  getGateOverride(evaluation: GateEvaluation): GateEvaluation | null {
    if (
      evaluation.name === "2911712394" ||
      evaluation.name === "1042620455" || // Remote control (Slingshot).
      evaluation.name === "4114442250" || // Native SSH connections and settings.
      evaluation.name === "4039078146" // Sidebar activity view.
    ) {
      return { ...evaluation, value: true };
    }
    return null;
  },
  getDynamicConfigOverride(
    evaluation: DynamicConfigEvaluation,
  ): DynamicConfigEvaluation | null {
    const value =
      evaluation.value && typeof evaluation.value === "object"
        ? (evaluation.value as Record<string, unknown>)
        : {};
    if (evaluation.name !== "107580212") return null;
    const existing = Array.isArray(value.available_models)
      ? (value.available_models as string[])
      : [];
    if (existing.length === 0) return null;
    const additions = [
      "gpt-6-astra",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ].filter((model) => !existing.includes(model));
    if (additions.length === 0) return null;
    return {
      ...evaluation,
      value: { ...value, available_models: [...existing, ...additions] },
    };
  },
  getLayerOverride(evaluation: LayerEvaluation): LayerEvaluation | null {
    if (evaluation.name !== "72216192") return null;
    // This is a Statsig Layer (__value), not a DynamicConfig (value).
    // localeOverride already persists; this enables the bundled translations.
    return {
      ...evaluation,
      __value: { ...evaluation.__value, enable_i18n: true },
    };
  },
};

export function adaptDesktopBridge(key: string, api: unknown): unknown {
  if (key !== "electronBridge" || !api || typeof api !== "object") return api;
  // Desktop's shared menu component already has an accessible DOM fallback.
  // Advertising showContextMenu sends it to the server's no-op Menu.popup and
  // leaves the caller waiting forever. Omit only this unsupported capability.
  const { showContextMenu: _nativeMenu, ...browserBridge } = api as Record<
    string,
    unknown
  >;
  return browserBridge;
}
