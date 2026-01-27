/** JIRA REST API v3 types */

export interface JiraIssue {
  id: string;
  key: string;
  self: string;
  fields: JiraIssueFields;
}

export interface JiraIssueFields {
  summary: string;
  description: AdfDocument | null;
  status: JiraStatus;
  priority: JiraPriority;
  issuetype: JiraIssueType;
  assignee: JiraUser | null;
  reporter: JiraUser | null;
  sprint?: JiraSprint | null;
  comment?: JiraCommentPage;
  created: string;
  updated: string;
}

export interface JiraStatus {
  name: string;
  statusCategory: {
    key: string;
    name: string;
  };
}

export interface JiraPriority {
  name: string;
  iconUrl: string;
}

export interface JiraIssueType {
  name: string;
  iconUrl: string;
}

export interface JiraUser {
  accountId: string;
  displayName: string;
  emailAddress?: string;
  avatarUrls: Record<string, string>;
}

export interface JiraSprint {
  id: number;
  name: string;
  state: "active" | "closed" | "future";
}

export interface JiraCommentPage {
  comments: JiraComment[];
  total: number;
}

export interface JiraComment {
  id: string;
  author: JiraUser;
  body: AdfDocument;
  created: string;
  updated: string;
}

/** Atlassian Document Format */
export interface AdfDocument {
  version: 1;
  type: "doc";
  content: AdfNode[];
}

export interface AdfNode {
  type: string;
  content?: AdfNode[];
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: AdfMark[];
}

export interface AdfMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface JiraSearchResponse {
  issues: JiraIssue[];
  total: number;
  startAt: number;
  maxResults: number;
}
