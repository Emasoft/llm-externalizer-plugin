import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  detectEndpointFlavor,
  clearEndpointFlavorCache,
  getEndpointFlavorForTests,
} from "./endpoint-flavor.js";

const realFetch = globalThis.fetch;
beforeEach(() => {
  clearEndpointFlavorCache();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function fetchMock(routes: Array<{ url: string; status: number; body?: string }>) {
  globalThis.fetch = vi.fn(async (input: unknown) => {
    const url = String(input);
    const hit = routes.find((r) => url === r.url || url.startsWith(r.url));
    return new Response(hit?.body ?? "", { status: hit?.status ?? 404 });
  }) as unknown as typeof fetch;
}

/** A llama.cpp /props answerer: 200 JSON on /props, 404 elsewhere. */
function propsOkFetch() {
  return vi.fn(async (input: unknown) => {
    if (String(input).endsWith("/props")) {
      return new Response(JSON.stringify({ model_path: "/x.gguf" }), { status: 200 });
    }
    return new Response("", { status: 404 });
  }) as unknown as ReturnType<typeof vi.fn>;
}
const isLMStudioProviderStub = () => false;

describe("detectEndpointFlavor", () => {
  it("classifies a llama.cpp server (200 JSON on /props) as llamacpp, probing /props FIRST and never /v1/models", async () => {
    const seen: string[] = [];
    globalThis.fetch = vi.fn(async (input: unknown) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ model_path: "/x.gguf" }), { status: 200 });
    }) as unknown as typeof fetch;
    const flavor = await detectEndpointFlavor("http://127.0.0.1:8080", isLMStudioProviderStub);
    expect(flavor).toBe("llamacpp");
    expect(seen).toEqual(["http://127.0.0.1:8080/props"]);
  });

  it("classifies api.b.ai (403 /props, 200 /v1/models) as openai", async () => {
    fetchMock([
      { url: "https://api.b.ai/props", status: 403 },
      { url: "https://api.b.ai/v1/models", status: 200, body: JSON.stringify({ data: [] }) },
    ]);
    const flavor = await detectEndpointFlavor("https://api.b.ai", isLMStudioProviderStub);
    expect(flavor).toBe("openai");
  });

  it("sends NO auth header on the probes", async () => {
    let seenInit: RequestInit | undefined;
    globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      seenInit = init;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    await detectEndpointFlavor("https://api.b.ai", isLMStudioProviderStub);
    expect(seenInit?.headers).toBeUndefined();
  });

  it("fails open to openai when the endpoint is unreachable", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const flavor = await detectEndpointFlavor("http://127.0.0.1:1", isLMStudioProviderStub);
    expect(flavor).toBe("openai");
    expect(errSpy.mock.calls.every((c) => !String(c[0]).includes("ECONNREFUSED"))).toBe(true);
  });

  it("fails open to openai on a 200 NON-JSON /props body", async () => {
    fetchMock([{ url: "http://h/props", status: 200, body: "<html>not json</html>" }]);
    const flavor = await detectEndpointFlavor("http://h", isLMStudioProviderStub);
    expect(flavor).toBe("openai");
  });

  it("caches per baseUrl: the second call for the same URL makes NO fetch", async () => {
    const fetchMocked = propsOkFetch();
    globalThis.fetch = fetchMocked as unknown as typeof fetch;
    await detectEndpointFlavor("http://h", isLMStudioProviderStub);
    await detectEndpointFlavor("http://h", isLMStudioProviderStub);
    expect(fetchMocked).toHaveBeenCalledTimes(1);
  });

  it("clearEndpointFlavorCache forgets the answer (reset-tool contract)", async () => {
    const fetchMocked = propsOkFetch();
    globalThis.fetch = fetchMocked as unknown as typeof fetch;
    await detectEndpointFlavor("http://h", isLMStudioProviderStub);
    clearEndpointFlavorCache();
    await detectEndpointFlavor("http://h", isLMStudioProviderStub);
    expect(fetchMocked).toHaveBeenCalledTimes(2);
  });

  it("exposes the cached flavor for tests", async () => {
    fetchMock([{ url: "http://h/props", status: 200, body: JSON.stringify({ model_path: "/m.gguf" }) }]);
    await detectEndpointFlavor("http://h", isLMStudioProviderStub);
    expect(getEndpointFlavorForTests("http://h")).toBe("llamacpp");
    expect(getEndpointFlavorForTests("http://other")).toBeUndefined();
  });
});
