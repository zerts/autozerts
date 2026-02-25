import {
  List,
  ActionPanel,
  Action,
  Icon,
  Color,
  showToast,
  Toast,
  Clipboard,
  AI,
  environment,
} from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { fetchAllIssuesInActiveCycle } from "./services/linear";
import type { LinearIssue } from "./types/linear";

const RELEASE_TAG_RE = /^(.+)\s+v(\d+(?:\.\d+)*)$/;

function isReleaseLabel(name: string): boolean {
  return RELEASE_TAG_RE.test(name);
}

function isBug(issue: LinearIssue): boolean {
  return issue.labels.nodes.some((l) => l.name.toLowerCase() === "bug");
}

function taskEmoji(issue: LinearIssue): string {
  return isBug(issue) ? "🔧" : "✨";
}

function extractWorkspace(issueUrl: string): string | null {
  const match = issueUrl.match(/^https:\/\/linear\.app\/([^/]+)\//);
  return match?.[1] ?? null;
}

function extractTeamKey(identifier: string): string | null {
  const match = identifier.match(/^([A-Za-z]+)-/);
  return match?.[1] ?? null;
}

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

function parseReleaseLabel(
  label: string,
): { platform: string; version: string } | null {
  const match = label.match(RELEASE_TAG_RE);
  if (!match) return null;
  return { platform: match[1], version: match[2] };
}

function groupByReleaseTags(issues: LinearIssue[]): ReleaseGroup[] {
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

  const DONE_TYPES = new Set(["completed", "cancelled"]);
  return Array.from(groups.values())
    .filter((g) => g.issues.some((i) => !DONE_TYPES.has(i.state.type)))
    .sort((a, b) => a.label.localeCompare(b.label));
}

async function generatePun(taskTitles: string[]): Promise<string> {
  const prompt = `You are writing a short closing line for a software release announcement.
The tasks shipped in this release:
${taskTitles.map((t) => `- ${t}`).join("\n")}

Write ONE short sentence (max 15 words) that is a funny or encouraging pun relevant to these tasks. Make it feel celebratory, slightly nerdy, and fun. Return only the sentence, no quotes, no punctuation at the end.`;

  return AI.ask(prompt, { creativity: "high" });
}

function buildPreviewMarkdown(group: ReleaseGroup): string {
  const parsed = parseReleaseLabel(group.label);
  const releaseName = parsed
    ? `${parsed.platform} ${parsed.version}`
    : group.label;

  const lines: string[] = [];

  if (group.labelUrl) {
    lines.push(
      `[${releaseName}](${group.labelUrl}) was released in production. 🚀`,
    );
  } else {
    lines.push(`${releaseName} was released in production. 🚀`);
  }

  lines.push("");
  lines.push("Changelog:");
  for (const issue of group.issues) {
    lines.push(` • ${taskEmoji(issue)}: ${issue.title}`);
  }

  lines.push("");
  lines.push("*{AI pun}* 🏆");

  return lines.join("\n");
}

function buildReleaseNoteContent(
  group: ReleaseGroup,
  pun: string,
): { text: string; html: string } {
  const parsed = parseReleaseLabel(group.label);
  const releaseName = parsed
    ? `${parsed.platform} ${parsed.version}`
    : group.label;

  const textLines: string[] = [];
  const htmlLines: string[] = [];

  if (group.labelUrl) {
    textLines.push(`${releaseName} was released in production. 🚀`);
    htmlLines.push(
      `<a href="${group.labelUrl}">${releaseName}</a> was released in production. 🚀`,
    );
  } else {
    textLines.push(`${releaseName} was released in production. 🚀`);
    htmlLines.push(`${releaseName} was released in production. 🚀`);
  }

  textLines.push("");
  textLines.push("Changelog:");
  htmlLines.push("<br><br>Changelog:");

  for (const issue of group.issues) {
    const emoji = taskEmoji(issue);
    textLines.push(` • ${emoji}: ${issue.title}`);
    htmlLines.push(
      `<br> • ${emoji}: <a href="${issue.url}">${issue.title}</a>`,
    );
  }

  textLines.push("");
  textLines.push(`${pun} 🏆`);
  htmlLines.push(`<br><br>${pun} 🏆`);

  return { text: textLines.join("\n"), html: htmlLines.join("\n") };
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

export default function PrepareReleaseNote() {
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
          detail={<List.Item.Detail markdown={buildPreviewMarkdown(group)} />}
          actions={
            <ActionPanel>
              <Action
                title="Copy Release Note"
                icon={Icon.Clipboard}
                onAction={async () => {
                  const toast = await showToast({
                    style: Toast.Style.Animated,
                    title: "Generating release note…",
                    message: "Asking AI for a pun",
                  });
                  try {
                    const canUseAI = environment.canAccess(AI);
                    const pun = canUseAI
                      ? await generatePun(group.issues.map((i) => i.title))
                      : "Ship it like it's hot";
                    const { text, html } = buildReleaseNoteContent(group, pun);
                    await Clipboard.copy({ text, html });
                    toast.style = Toast.Style.Success;
                    toast.title = "Release note copied";
                    toast.message = group.label;
                  } catch (err) {
                    toast.style = Toast.Style.Failure;
                    toast.title = "Failed to generate release note";
                    toast.message =
                      err instanceof Error ? err.message : String(err);
                  }
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
