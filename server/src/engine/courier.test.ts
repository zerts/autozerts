import { describe, expect, test } from "bun:test";
import { buildQaPrComment, parseQaDoc, parseReviewDoc } from "./courier";
import { taskBranchFromIssue } from "../branch";

describe("parseReviewDoc", () => {
  test("parses approved with empty findings", () => {
    const doc = `---\nverdict: approved\nfindings: []\n---\n## Summary\nAll good.`;
    const parsed = parseReviewDoc(doc);
    expect(parsed?.verdict).toBe("approved");
    expect(parsed?.findings).toEqual([]);
    expect(parsed?.body).toContain("All good.");
  });

  test("parses needs-changes with findings", () => {
    const doc = [
      "---",
      "verdict: needs-changes",
      "findings:",
      "  - severity: major",
      "    area: visual",
      "    title: Banner overlaps the nav",
      "    file: src/Banner.tsx:42",
      "  - severity: minor",
      "    area: code",
      "    title: Dead constant",
      "---",
      "## Summary",
      "Problems found.",
    ].join("\n");
    const parsed = parseReviewDoc(doc);
    expect(parsed?.verdict).toBe("needs-changes");
    expect(parsed?.findings).toHaveLength(2);
    expect(parsed?.findings[0]).toEqual({
      severity: "major",
      area: "visual",
      title: "Banner overlaps the nav",
      file: "src/Banner.tsx:42",
    });
    expect(parsed?.findings[1].severity).toBe("minor");
    expect(parsed?.findings[1].file).toBeUndefined();
  });

  test("rejects docs without frontmatter", () => {
    expect(parseReviewDoc("# Just markdown")).toBeNull();
  });

  test("rejects invalid verdict values", () => {
    expect(parseReviewDoc("---\nverdict: maybe\n---\nbody")).toBeNull();
  });

  test("rejects missing verdict", () => {
    expect(parseReviewDoc("---\nfindings: []\n---\nbody")).toBeNull();
  });
});

describe("parseQaDoc", () => {
  test("parses a pass with screenshots and no findings", () => {
    const doc = [
      "---",
      "qa: pass",
      "boots: true",
      "visual_change: true",
      "screenshots:",
      "  - file: .qa-artifacts/01-overview.png",
      "    label: Portfolio overview",
      "  - file: .qa-artifacts/02-send.png",
      "    label: Send modal",
      "findings: []",
      "---",
      "## Summary",
      "Booted and rendered.",
    ].join("\n");
    const parsed = parseQaDoc(doc);
    expect(parsed?.qa).toBe("pass");
    expect(parsed?.boots).toBe(true);
    expect(parsed?.visualChange).toBe(true);
    expect(parsed?.screenshots).toEqual([
      { file: ".qa-artifacts/01-overview.png", label: "Portfolio overview" },
      { file: ".qa-artifacts/02-send.png", label: "Send modal" },
    ]);
    expect(parsed?.findings).toEqual([]);
    expect(parsed?.body).toContain("Booted and rendered.");
  });

  test("parses a fail with a blocker finding", () => {
    const doc = [
      "---",
      "qa: fail",
      "boots: false",
      "visual_change: true",
      "screenshots: []",
      "findings:",
      "  - severity: blocker",
      "    area: build",
      "    title: App fails to start on 3000",
      "    file: src/main.tsx:1",
      "---",
      "## Summary",
      "Dead on arrival.",
    ].join("\n");
    const parsed = parseQaDoc(doc);
    expect(parsed?.qa).toBe("fail");
    expect(parsed?.boots).toBe(false);
    expect(parsed?.screenshots).toEqual([]);
    expect(parsed?.findings).toHaveLength(1);
    expect(parsed?.findings[0]).toEqual({
      severity: "blocker",
      area: "build",
      title: "App fails to start on 3000",
      file: "src/main.tsx:1",
    });
  });

  test("rejects docs without a qa verdict", () => {
    expect(parseQaDoc("---\nboots: true\n---\nbody")).toBeNull();
    expect(parseQaDoc("# no frontmatter")).toBeNull();
    expect(parseQaDoc("---\nqa: maybe\n---\nbody")).toBeNull();
  });
});

describe("buildQaPrComment", () => {
  test("embeds hosted screenshots and a findings table", () => {
    const parsed = parseQaDoc(
      ["---", "qa: fail", "boots: true", "visual_change: true", "screenshots: []",
        "findings:", "  - severity: major", "    area: behavior", "    title: Modal throws",
        "---", "## Summary", "Broken modal."].join("\n"),
    )!;
    const comment = buildQaPrComment(2, 5, parsed, [
      { name: "01.png", label: "Overview", url: "https://github.com/o/r/blob/qa-artifacts/x/01.png?raw=1" },
    ]);
    expect(comment).toContain("QA smoke gate — iteration 2/5");
    expect(comment).toContain("`fail`");
    expect(comment).toContain("| major | behavior | Modal throws |");
    expect(comment).toContain("![Overview](https://github.com/o/r/blob/qa-artifacts/x/01.png?raw=1)");
  });

  test("falls back to a note when a screenshot has no hosted url", () => {
    const parsed = parseQaDoc("---\nqa: pass\nboots: true\nvisual_change: true\nscreenshots: []\nfindings: []\n---\nok")!;
    const comment = buildQaPrComment(1, 5, parsed, [{ name: "01.png", label: "Overview" }]);
    expect(comment).toContain("not hosted");
    expect(comment).not.toContain("![Overview](");
  });
});

describe("taskBranchFromIssue", () => {
  test("keeps short names verbatim", () => {
    expect(taskBranchFromIssue("zerts/wlt-123-fix-login")).toBe("zerts/wlt-123-fix-login");
  });

  test("truncates at the last dash boundary before 64", () => {
    const long = `zerts/wlt-1509-${"word-".repeat(20)}end`;
    const result = taskBranchFromIssue(long);
    expect(result.length).toBeLessThanOrEqual(64);
    expect(result.endsWith("-")).toBe(false);
    expect(long.startsWith(result)).toBe(true);
  });
});
