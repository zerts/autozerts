import { describe, expect, test } from "bun:test";
import path from "node:path";
import { config } from "./config";
import { iterationDir, resolveDataPath, toStoredPath } from "./data-paths";

describe("data-paths", () => {
  test("iterationDir nests issue → loop → iteration under loops/", () => {
    expect(iterationDir("WLT-1", "loop-a", 2)).toBe(path.join(config.dataDir, "loops", "WLT-1", "loop-a", "2"));
  });

  test("stored paths are data-dir-relative and round-trip", () => {
    const abs = path.join(iterationDir("WLT-1", "loop-a", 1), "screenshots", "01.png");
    const stored = toStoredPath(abs);
    expect(stored).toBe("loops/WLT-1/loop-a/1/screenshots/01.png");
    expect(resolveDataPath(stored)).toBe(abs);
  });

  test("pre-migration absolute paths resolve unchanged", () => {
    expect(resolveDataPath("/somewhere/else/1.md")).toBe("/somewhere/else/1.md");
  });
});
