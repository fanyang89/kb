import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageJson = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
) as { engines?: { node?: string } };

describe("package manifest", () => {
  it("declares the Node.js floor required by pi 0.84", () => {
    expect(packageJson.engines?.node).toBe(">=22.19.0");
  });
});
