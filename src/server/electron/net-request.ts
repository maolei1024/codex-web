import { Readable, Writable } from "node:stream";

type RequestOptions = {
  url?: string;
  protocol?: string;
  hostname?: string;
  port?: number;
  path?: string;
  method?: string;
  headers?: Record<string, string>;
  redirect?: RequestRedirect;
};

/** The Desktop preview/Sentry ClientRequest contract, using Node's proxy-aware fetch. */
export class NetRequest extends Writable {
  private headers: Headers;
  private controller = new AbortController();
  private chunks: Buffer[] = [];
  private bytes = 0;
  private response?: Readable;
  private options: RequestOptions;
  private url: URL;

  constructor(options: RequestOptions | string) {
    super({ autoDestroy: false });
    this.options = typeof options === "string" ? { url: options } : options;
    this.url = this.options.url
      ? new URL(this.options.url)
      : new URL(
          `${this.options.protocol ?? "https:"}//${this.options.hostname ?? "localhost"}`,
        );
    if (!this.options.url) {
      if (Number.isFinite(this.options.port))
        this.url.port = String(this.options.port);
      const target = this.options.path ?? "/";
      const query = target.indexOf("?");
      this.url.pathname = query < 0 ? target : target.slice(0, query);
      this.url.search = query < 0 ? "" : target.slice(query);
    }
    this.headers = new Headers(this.options.headers);
  }

  setHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }
  getHeader(name: string): string | undefined {
    return this.headers.get(name) ?? undefined;
  }
  removeHeader(name: string): void {
    this.headers.delete(name);
  }

  abort(): void {
    if (this.controller.signal.aborted) return;
    this.controller.abort();
    this.response?.emit("aborted");
    this.response?.destroy();
    this.emit("abort");
    this.destroy();
  }

  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    this.controller.abort();
    this.response?.destroy();
    this.chunks = [];
    callback(error);
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.bytes += chunk.length;
    if (this.bytes > 8 * 1024 * 1024) {
      callback(new Error("net.request body too large"));
      return;
    }
    this.chunks.push(chunk);
    callback();
  }

  override _final(callback: (error?: Error | null) => void): void {
    const body = this.bytes
      ? new Uint8Array(Buffer.concat(this.chunks, this.bytes))
      : undefined;
    this.chunks = [];
    callback();
    if (this.controller.signal.aborted) return;
    void (async () => {
      try {
        const response = await globalThis.fetch(this.url, {
          method: this.options.method ?? "GET",
          headers: this.headers,
          body,
          redirect: this.options.redirect ?? "follow",
          signal: this.controller.signal,
          credentials: "omit",
        });
        if (this.controller.signal.aborted) {
          await response.body?.cancel();
          return;
        }
        const headers: Record<string, string | string[]> = Object.fromEntries(
          response.headers,
        );
        const cookies = response.headers.getSetCookie();
        if (cookies.length) headers["set-cookie"] = cookies;
        const location = response.headers.get("location");
        if (
          this.options.redirect === "manual" &&
          location &&
          [301, 302, 303, 307, 308].includes(response.status)
        ) {
          this.emit(
            "redirect",
            response.status,
            this.options.method ?? "GET",
            new URL(location, this.url).href,
            headers,
          );
          await response.body?.cancel();
          return;
        }
        const stream = response.body
          ? Readable.fromWeb(
              response.body as import("node:stream/web").ReadableStream,
            )
          : Readable.from([]);
        this.response = stream;
        Object.assign(stream, {
          statusCode: response.status,
          statusMessage: response.statusText,
          headers,
        });
        stream.once("end", () => this.destroy());
        this.emit("response", stream);
      } catch (error) {
        if (!this.controller.signal.aborted) this.destroy(error as Error);
      }
    })();
  }
}
