import { describe, expect, test } from "bun:test";
import { parseDevBuildUrl, parseGithubOwnerRepo, parseGithubWebBase } from "./github";

describe("parseDevBuildUrl", () => {
  test("returns the link from a 'deployed to domain' comment", () => {
    const comments = [
      { body: "deployed to domain https://pr-123.dev.example.com" },
    ];
    expect(parseDevBuildUrl(comments)).toBe("https://pr-123.dev.example.com");
  });

  test("is case-insensitive and trims trailing punctuation", () => {
    const comments = [{ body: "Deployed to domain https://pr-123.dev.example.com." }];
    expect(parseDevBuildUrl(comments)).toBe("https://pr-123.dev.example.com");
  });

  test("ignores comments that mention a URL but don't open with the marker", () => {
    const comments = [
      { body: "LGTM, see https://pr-123.dev.example.com" },
      { body: "review pending" },
    ];
    expect(parseDevBuildUrl(comments)).toBeNull();
  });

  test("returns the first matching comment when several exist", () => {
    const comments = [
      { body: "deployed to domain https://first.example.com" },
      { body: "deployed to domain https://second.example.com" },
    ];
    expect(parseDevBuildUrl(comments)).toBe("https://first.example.com");
  });

  test("returns null when no comments match", () => {
    expect(parseDevBuildUrl([])).toBeNull();
  });
});

describe("parseGithubWebBase", () => {
  test("parses an ssh remote", () => {
    expect(parseGithubWebBase("git@github.com:zeriontech/zerion-web-app.git")).toBe(
      "https://github.com/zeriontech/zerion-web-app",
    );
  });

  test("parses an https remote", () => {
    expect(parseGithubWebBase("https://github.com/zeriontech/zerion-wallet-extension.git")).toBe(
      "https://github.com/zeriontech/zerion-wallet-extension",
    );
  });

  test("handles a remote without the .git suffix and trailing slash", () => {
    expect(parseGithubWebBase("https://github.com/zerts/api-developer-dashboard/")).toBe(
      "https://github.com/zerts/api-developer-dashboard",
    );
  });

  test("returns null for a non-GitHub remote", () => {
    expect(parseGithubWebBase("git@gitlab.com:owner/repo.git")).toBeNull();
  });
});

describe("parseGithubOwnerRepo", () => {
  test("parses an ssh remote", () => {
    expect(parseGithubOwnerRepo("git@github.com:zeriontech/zerion-web-app.git")).toEqual({
      owner: "zeriontech",
      repo: "zerion-web-app",
    });
  });

  test("parses an https remote without .git and with a trailing slash", () => {
    expect(parseGithubOwnerRepo("https://github.com/zerts/api-developer-dashboard/")).toEqual({
      owner: "zerts",
      repo: "api-developer-dashboard",
    });
  });

  test("returns null for a non-GitHub remote", () => {
    expect(parseGithubOwnerRepo("git@gitlab.com:owner/repo.git")).toBeNull();
  });
});
