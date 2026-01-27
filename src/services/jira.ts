import { getConfig } from "../utils/preferences";
import type { JiraIssue, JiraSearchResponse } from "../types/jira";

function authHeader(): string {
  const { jiraEmail, jiraApiToken } = getConfig();
  return `Basic ${Buffer.from(`${jiraEmail}:${jiraApiToken}`).toString("base64")}`;
}

function baseUrl(): string {
  return getConfig().jiraBaseUrl.replace(/\/$/, "");
}

async function jiraFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${baseUrl()}${path}`;
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/json",
      Accept: "application/json",
      ...init?.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`JIRA API ${response.status}: ${body}`);
  }

  return response.json() as Promise<T>;
}

/**
 * Fetch issues assigned to the current user that are not done.
 */
export async function fetchMyIssues(): Promise<JiraIssue[]> {
  const { jiraProjectKeys } = getConfig();
  const projectFilter =
    jiraProjectKeys.length > 0
      ? ` AND project IN (${jiraProjectKeys.join(", ")})`
      : "";

  const jql = `assignee = currentUser() AND sprint in openSprints() AND status NOT IN (Done, Released, Cancelled, "Ready for Release")${projectFilter} ORDER BY status ASC, priority DESC, updated DESC`;

  const data = await jiraFetch<JiraSearchResponse>(`/rest/api/3/search/jql`, {
    method: "POST",
    body: JSON.stringify({
      jql,
      maxResults: 50,
      fields: [
        "summary",
        "description",
        "status",
        "priority",
        "issuetype",
        "assignee",
        "reporter",
        "sprint",
        "comment",
        "created",
        "updated",
      ],
    }),
  });

  return data.issues;
}

/**
 * Fetch a single issue by key.
 */
export async function fetchIssue(key: string): Promise<JiraIssue> {
  return jiraFetch<JiraIssue>(
    `/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description,status,priority,issuetype,assignee,reporter,sprint,comment,created,updated`,
  );
}

/**
 * Add a comment to a JIRA issue.
 */
export async function addComment(
  issueKey: string,
  markdown: string,
): Promise<void> {
  await jiraFetch(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, {
    method: "POST",
    body: JSON.stringify({
      body: {
        version: 1,
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: markdown }],
          },
        ],
      },
    }),
  });
}

/**
 * Build a JIRA issue URL.
 */
export function issueUrl(key: string): string {
  return `${baseUrl()}/browse/${key}`;
}

/**
 * Group issues by sprint status: active sprint vs backlog.
 */
export function groupIssuesBySprint(issues: JiraIssue[]): {
  activeSprint: JiraIssue[];
  backlog: JiraIssue[];
} {
  const activeSprint: JiraIssue[] = [];
  const backlog: JiraIssue[] = [];

  for (const issue of issues) {
    if (issue.fields.sprint?.state === "active") {
      activeSprint.push(issue);
    } else {
      backlog.push(issue);
    }
  }

  return { activeSprint, backlog };
}
