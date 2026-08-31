import { once } from "node:events";
import { createServer } from "node:http";
import { fetch as undiciFetch } from "undici";
import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { configurePiSdkHttp, getAgentToolNames } from "./pi.js";

function customTool(name: string): ToolDefinition {
  return { name } as ToolDefinition;
}

describe("configurePiSdkHttp", () => {
  it("preserves a fetch implementation deliberately installed by the host", () => {
    const originalFetch = globalThis.fetch;
    const hostFetch = (() => Promise.reject(new Error("not called"))) as typeof fetch;
    globalThis.fetch = hostFetch;

    try {
      configurePiSdkHttp();
      expect(globalThis.fetch).toBe(hostFetch);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects an interrupted response without an unhandled dispatcher error", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("partial");
      res.socket?.destroy(new Error("interrupted"));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing test server address");
      await expect(
        undiciFetch(`http://127.0.0.1:${address.port}`).then((response) => response.text()),
      ).rejects.toThrow();
    } finally {
      server.close();
    }
  });
});

describe("getAgentToolNames", () => {
  it("includes custom tools in the read-only allowlist", () => {
    expect(getAgentToolNames("readonly", [customTool("review_spec")])).toEqual([
      "read",
      "grep",
      "find",
      "ls",
      "review_spec",
    ]);
  });

  it("includes custom tools in the coding allowlist", () => {
    expect(getAgentToolNames("coding", [customTool("task_update"), customTool("review_step")])).toEqual([
      "read",
      "bash",
      "edit",
      "write",
      "task_update",
      "review_step",
    ]);
  });
});
