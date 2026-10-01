type NetworkFetch = (url: string, init?: RequestInit) => Promise<Response>;
type StatsigOptions = {
  networkConfig?: {
    networkOverrideFunc?: NetworkFetch;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

/** Keep large configuration responses off the native AppHost message stream. */
export function configureStatsigOptions(
  options: StatsigOptions | null | undefined,
  request: NetworkFetch = globalThis.fetch.bind(globalThis),
): StatsigOptions {
  const original = options?.networkConfig?.networkOverrideFunc ?? request;
  return {
    ...options,
    networkConfig: {
      ...options?.networkConfig,
      networkOverrideFunc: (input, init) => {
        const url = new URL(input);
        if (
          url.origin === "https://ab.chatgpt.com" &&
          url.pathname === "/v1/initialize" &&
          !url.username &&
          !url.password &&
          !url.hash &&
          init?.method?.toUpperCase() === "POST"
        ) {
          return request(`/__backend/feature-config${url.search}`, {
            ...init,
            credentials: "same-origin",
            mode: "same-origin",
            cache: "no-store",
            redirect: "error",
          });
        }
        return original(input, init);
      },
    },
  };
}
