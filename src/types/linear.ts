/** Linear GraphQL API types */

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  state: LinearState;
  priority: number;
  priorityLabel: string;
  labels: { nodes: LinearLabel[] };
  assignee: LinearUser | null;
  creator: LinearUser | null;
  cycle: LinearCycle | null;
  comments: { nodes: LinearComment[] };
  createdAt: string;
  updatedAt: string;
  url: string;
}

export interface LinearState {
  id: string;
  name: string;
  /** "backlog" | "unstarted" | "started" | "completed" | "cancelled" | "triage" */
  type: string;
  color: string;
}

export interface LinearUser {
  id: string;
  name: string;
  email?: string;
  avatarUrl?: string;
}

export interface LinearLabel {
  id: string;
  name: string;
  color: string;
}

export interface LinearCycle {
  id: string;
  name: string | null;
  number: number;
  startsAt: string;
  endsAt: string;
}

export interface LinearComment {
  id: string;
  body: string;
  user: LinearUser | null;
  createdAt: string;
  updatedAt: string;
}
