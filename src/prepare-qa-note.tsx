import {
  List,
  ActionPanel,
  Action,
  Icon,
  Color,
  showToast,
  Toast,
  Clipboard,
} from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { fetchAllIssuesInActiveCycle } from "./services/linear";
import type { LinearIssue } from "./types/linear";
import { GITHUB_OWNER, REPOS } from "./config";

/** Matches labels like "Extension v1.2.3", "Web App v2.0" */
const RELEASE_TAG_RE = /^(.+)\s+v(\d+(?:\.\d+)*)$/;

function isReleaseLabel(name: string): boolean {
  console.log(
    "Checking if label is release tag:",
    name,
    RELEASE_TAG_RE.test(name),
  );
  return RELEASE_TAG_RE.test(name);
}

function isBug(issue: LinearIssue): boolean {
  return issue.labels.nodes.some((l) => l.name.toLowerCase() === "bug");
}

function taskEmoji(issue: LinearIssue): string {
  return isBug(issue) ? "🐛" : "✨";
}

/** Strip leading bracket prefixes like "[Web] " or "[Extension] " from titles */
function cleanTitle(title: string): string {
  return title.replace(/^\[.+?\]\s*/g, "");
}

/**
 * Extract the workspace slug from a Linear issue URL.
 * e.g. "https://linear.app/zerion/issue/EXT-1234/..." → "zerion"
 */
function extractWorkspace(issueUrl: string): string | null {
  const match = issueUrl.match(/^https:\/\/linear\.app\/([^/]+)\//);
  return match?.[1] ?? null;
}

/**
 * Extract the team key from a Linear issue identifier.
 * e.g. "EXT-1234" → "EXT"
 */
function extractTeamKey(identifier: string): string | null {
  const match = identifier.match(/^([A-Za-z]+)-/);
  return match?.[1] ?? null;
}

/** Build a Linear filter URL showing all issues with a given label. */
function buildLabelFilterUrl(
  workspace: string,
  teamKey: string,
  labelName: string,
): string {
  return `https://linear.app/${workspace}/team/${teamKey}/issue-label/${encodeURIComponent(labelName.toLowerCase())}`;
}

interface ReleaseGroup {
  label: string;
  color: string;
  labelUrl: string | null;
  issues: LinearIssue[];
}

function groupByReleaseTags(issues: LinearIssue[]): ReleaseGroup[] {
  // Extract workspace slug from the first available issue URL
  let workspace: string | null = null;
  for (const issue of issues) {
    workspace = extractWorkspace(issue.url);
    if (workspace) break;
  }

  const groups = new Map<string, ReleaseGroup>();

  for (const issue of issues) {
    for (const label of issue.labels.nodes) {
      if (!isReleaseLabel(label.name)) continue;

      let group = groups.get(label.name);
      if (!group) {
        const teamKey = extractTeamKey(issue.identifier);
        group = {
          label: label.name,
          color: label.color,
          labelUrl:
            workspace && teamKey
              ? buildLabelFilterUrl(workspace, teamKey, label.name)
              : null,
          issues: [],
        };
        groups.set(label.name, group);
      }
      group.issues.push(issue);
    }
  }

  // Filter out releases where every task is done or cancelled
  const DONE_TYPES = new Set(["completed", "cancelled"]);
  return Array.from(groups.values())
    .filter((g) => g.issues.some((i) => !DONE_TYPES.has(i.state.type)))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Extract platform and version from a release label. */
function parseReleaseLabel(
  label: string,
): { platform: string; version: string } | null {
  const match = label.match(RELEASE_TAG_RE);
  if (!match) return null;
  return { platform: match[1], version: match[2] };
}

function buildExtensionHeader(version: string): {
  text: string[];
  html: string[];
} {
  const shortVersion = version.split(".").slice(0, 2).join(".");
  const parts = version.split(".");
  const fullVersion = parts.length < 3 ? `${version}.0` : version;
  const releaseUrl = `https://github.com/${GITHUB_OWNER}/${REPOS.extension}/releases/tag/v${fullVersion}`;
  const branchLink = `x-github-client://openRepo/https://github.com/${GITHUB_OWNER}/${REPOS.extensionQa}?branch=v${fullVersion}`;

  const text = [
    "Hey team!",
    "Here is the new release candidate!",
    `📦 *version ${shortVersion}* 📦`,
    "",
    "I will appreciate if you take a look and help me with the brief QA before publishing.",
    "",
    `Release link: ${releaseUrl}`,
    `Branch name: \`v${fullVersion}\``,
    `Branch link (for Github desktop app): ${branchLink}`,
  ];

  const html = [
    "Hey team!",
    "<br>Here is the new release candidate!",
    `<br>📦 <b>version ${shortVersion}</b> 📦`,
    "<br>",
    "<br>I will appreciate if you take a look and help me with the brief QA before publishing.",
    "<br>",
    `<br>Release link: <a href="${releaseUrl}">${releaseUrl}</a>`,
    `<br>Branch name: <code>v${fullVersion}</code>`,
    `<br>Branch link (for Github desktop app): <a href="${branchLink}">Open in GitHub Desktop</a>`,
  ];

  return { text, html };
}

function buildReleaseNote(group: ReleaseGroup): { text: string; html: string } {
  const textLines: string[] = [];
  const htmlLines: string[] = [];

  const parsed = parseReleaseLabel(group.label);
  const isExtension = parsed?.platform.toLowerCase() === "extension";

  if (isExtension && parsed) {
    const header = buildExtensionHeader(parsed.version);
    textLines.push(...header.text);
    htmlLines.push(...header.html);
  } else if (group.labelUrl) {
    textLines.push(`${group.label} is ready for QA (${group.labelUrl})`);
    htmlLines.push(
      `<b><a href="${group.labelUrl}">${group.label}</a></b> is ready for QA`,
    );
  } else {
    textLines.push(`${group.label} is ready for QA`);
    htmlLines.push(`<b>${group.label}</b> is ready for QA`);
  }

  textLines.push("");
  textLines.push("Changelog:");
  htmlLines.push("<br><br>Changelog:");

  for (const issue of group.issues) {
    const emoji = taskEmoji(issue);
    const title = cleanTitle(issue.title);
    textLines.push(`• ${emoji} ${title} (${issue.url})`);
    htmlLines.push(`<br>• ${emoji} <a href="${issue.url}">${title}</a>`);
  }

  if (group.labelUrl) {
    textLines.push("");
    textLines.push(`List of tickets in Linear: ${group.labelUrl}`);
    htmlLines.push(
      `<br><br>List of tickets in Linear: <a href="${group.labelUrl}">${group.label}</a>`,
    );
  }

  return {
    text: textLines.join("\n"),
    html: htmlLines.join("\n"),
  };
}

function hexToRaycastColor(hex: string): Color {
  const h = hex.replace("#", "").toLowerCase();
  if (["d73a4a", "b60205", "e11d48"].includes(h)) return Color.Red;
  if (["0075ca", "0969da", "1d76db"].includes(h)) return Color.Blue;
  if (["008672", "0e8a16", "22863a"].includes(h)) return Color.Green;
  if (["e4e669", "fbca04", "f9d0c4"].includes(h)) return Color.Yellow;
  if (["d876e3", "7057ff", "6f42c1"].includes(h)) return Color.Purple;
  if (["f28c18", "e99695", "ff7a00"].includes(h)) return Color.Orange;
  return Color.SecondaryText;
}

export default function PrepareQaNote() {
  const { data, isLoading, error } = usePromise(async () => {
    const issues = await fetchAllIssuesInActiveCycle();
    return groupByReleaseTags(issues);
  });

  if (error) {
    showToast({
      style: Toast.Style.Failure,
      title: "Failed to fetch Linear issues",
      message: error.message,
    });
  }

  return (
    <List
      isLoading={isLoading}
      isShowingDetail
      searchBarPlaceholder="Filter release tags..."
    >
      {(data ?? []).map((group) => (
        <List.Item
          key={group.label}
          title={group.label}
          icon={{ source: Icon.Tag, tintColor: hexToRaycastColor(group.color) }}
          accessories={[
            {
              text: `${group.issues.length} task${group.issues.length === 1 ? "" : "s"}`,
            },
          ]}
          detail={
            <List.Item.Detail
              metadata={
                <List.Item.Detail.Metadata>
                  <List.Item.Detail.Metadata.Label
                    title="Release"
                    text={group.label}
                    icon={{
                      source: Icon.Tag,
                      tintColor: hexToRaycastColor(group.color),
                    }}
                  />
                  <List.Item.Detail.Metadata.Label
                    title="Tasks"
                    text={String(group.issues.length)}
                  />
                  <List.Item.Detail.Metadata.Separator />
                  {group.issues.map((issue) => (
                    <List.Item.Detail.Metadata.Link
                      key={issue.id}
                      title={`[${issue.state.name}] ${taskEmoji(issue)} ${cleanTitle(issue.title)}`}
                      target={issue.url}
                      text={issue.identifier}
                    />
                  ))}
                </List.Item.Detail.Metadata>
              }
            />
          }
          actions={
            <ActionPanel>
              <Action
                title="Copy Release Note"
                icon={Icon.Clipboard}
                onAction={async () => {
                  const { text, html } = buildReleaseNote(group);
                  await Clipboard.copy({ text, html });
                  await showToast({
                    style: Toast.Style.Success,
                    title: "Release note copied",
                    message: group.label,
                  });
                }}
              />
              <Action.CopyToClipboard
                title="Copy Tag Name"
                content={group.label}
                shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
              />
            </ActionPanel>
          }
        />
      ))}

      {!isLoading && (!data || data.length === 0) && (
        <List.EmptyView
          title="No release tags found"
          description="No tasks with release-like tags (e.g. 'Extension v1.2.3') in the current cycle."
          icon={Icon.Tag}
        />
      )}
    </List>
  );
}
