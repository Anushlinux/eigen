import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("dashboard responsive and motion contract", () => {
  it("ships a mobile evidence stack and reduced-motion override", async () => {
    const source = await readFile(
      resolve(process.cwd(), "apps/dashboard/src/styles.css"),
      "utf8",
    );
    expect(source).toContain("@media (max-width: 760px)");
    expect(source).toContain(".mobile-evidence-stack");
    expect(source).toContain("@media (prefers-reduced-motion: reduce)");
  });
});
