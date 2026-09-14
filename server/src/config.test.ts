import { describe, expect, test } from "bun:test";
import { parseReposJson, validateRepos } from "./config";

describe("parseReposJson", () => {
  test("returns null for missing or invalid JSON", () => {
    expect(parseReposJson(undefined)).toBeNull();
    expect(parseReposJson("")).toBeNull();
    expect(parseReposJson("not json")).toBeNull();
    expect(parseReposJson('{"not":"an array"}')).toBeNull();
  });

  test("drops entries missing required fields", () => {
    const raw = JSON.stringify([
      { name: "ok", localPath: "/a", defaultBranch: "main" },
      { name: "missing-path", defaultBranch: "main" },
    ]);
    const parsed = parseReposJson(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed?.[0]?.name).toBe("ok");
  });
});

describe("validateRepos", () => {
  test("trims fields and drops empty optional arrays", () => {
    const result = validateRepos([
      { name: " web ", localPath: " /repo ", defaultBranch: " main ", issuePrefixes: [" Web ", ""], labels: [] },
    ]);
    expect(result).toEqual([{ name: "web", localPath: "/repo", defaultBranch: "main", issuePrefixes: ["Web"] }]);
  });

  test("keeps labels and icon when present", () => {
    const result = validateRepos([
      { name: "web", localPath: "/repo", defaultBranch: "main", labels: ["dashboard"], icon: "/x.png" },
    ]);
    expect(result[0]).toEqual({
      name: "web",
      localPath: "/repo",
      defaultBranch: "main",
      labels: ["dashboard"],
      icon: "/x.png",
    });
  });

  test("rejects missing required fields", () => {
    expect(() => validateRepos([{ localPath: "/x", defaultBranch: "main" }])).toThrow(/name is required/);
    expect(() => validateRepos([{ name: "x", defaultBranch: "main" }])).toThrow(/local path is required/);
    expect(() => validateRepos([{ name: "x", localPath: "/x" }])).toThrow(/default branch is required/);
  });

  test("rejects duplicate names case-insensitively", () => {
    expect(() =>
      validateRepos([
        { name: "Web", localPath: "/a", defaultBranch: "main" },
        { name: "web", localPath: "/b", defaultBranch: "main" },
      ]),
    ).toThrow(/Duplicate repo name/);
  });

  test("rejects a non-array", () => {
    expect(() => validateRepos({})).toThrow(/must be an array/);
  });
});
