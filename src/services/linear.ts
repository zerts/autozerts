import { getConfig } from "../utils/preferences";
import type { LinearIssue } from "../types/linear";

const GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";

async function linearFetch<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const { linearApiKey } = getConfig();
  const response = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: linearApiKey,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Linear API ${response.status}: ${body}`);
  }

  const json = (await response.json()) as {
    data?: T;
    errors?: { message: string }[];
  };
  if (json.errors?.length) {
    throw new Error(`Linear API: ${json.errors[0].message}`);
  }
  if (!json.data) {
    throw new Error("Linear API: no data returned");
  }

  return json.data;
}

const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  state {
    id
    name
    type
    color
  }
  priority
  priorityLabel
  labels {
    nodes {
      id
      name
      color
    }
  }
  assignee {
    id
    name
    email
    avatarUrl
  }
  creator {
    id
    name
    email
  }
  cycle {
    id
    name
    number
    startsAt
    endsAt
  }
  comments {
    nodes {
      id
      body
      user {
        id
        name
      }
      createdAt
      updatedAt
    }
  }
  createdAt
  updatedAt
  url
`;

/**
 * Fetch issues assigned to the current user in the active cycle.
 */
export async function fetchMyIssues(): Promise<LinearIssue[]> {
  const data = await linearFetch<{
    viewer: { assignedIssues: { nodes: LinearIssue[] } };
  }>(`
    query {
      viewer {
        assignedIssues(
          filter: {
            cycle: { isActive: { eq: true } }
            state: { type: { nin: ["completed", "cancelled"] } }
          }
          first: 50
          orderBy: updatedAt
        ) {
          nodes {
            ${ISSUE_FIELDS}
          }
        }
      }
    }
  `);

  return data.viewer.assignedIssues.nodes;
}

/**
 * Fetch issues assigned to the current user in the active cycle (all states).
 */
export async function fetchMyIssuesAllStates(): Promise<LinearIssue[]> {
  const data = await linearFetch<{
    viewer: { assignedIssues: { nodes: LinearIssue[] } };
  }>(`
    query {
      viewer {
        assignedIssues(
          filter: {
            cycle: { isActive: { eq: true } }
          }
          first: 100
          orderBy: updatedAt
        ) {
          nodes {
            ${ISSUE_FIELDS}
          }
        }
      }
    }
  `);

  return data.viewer.assignedIssues.nodes;
}

/**
 * Fetch all issues in the active cycle across all assignees.
 */
export async function fetchAllIssuesInActiveCycle(): Promise<LinearIssue[]> {
  const data = await linearFetch<{
    issues: { nodes: LinearIssue[] };
  }>(`
    query {
      issues(
        filter: {
          cycle: { isActive: { eq: true } }
        }
        first: 250
        orderBy: updatedAt
      ) {
        nodes {
          ${ISSUE_FIELDS}
        }
      }
    }
  `);

  return data.issues.nodes;
}

/**
 * Fetch a single issue by identifier (e.g. "ENG-123").
 */
export async function fetchIssue(identifier: string): Promise<LinearIssue> {
  const data = await linearFetch<{
    issueSearch: { nodes: LinearIssue[] };
  }>(
    `
    query($query: String!) {
      issueSearch(query: $query, first: 1) {
        nodes {
          ${ISSUE_FIELDS}
        }
      }
    }
  `,
    { query: identifier },
  );

  if (!data.issueSearch.nodes.length) {
    throw new Error(`Issue not found: ${identifier}`);
  }

  return data.issueSearch.nodes[0];
}

/**
 * Add a comment to a Linear issue.
 */
export async function addComment(issueId: string, body: string): Promise<void> {
  await linearFetch(
    `
    mutation($issueId: String!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) {
        success
      }
    }
  `,
    { issueId, body },
  );
}

/**
 * Transition a Linear issue to a target state by name.
 * Looks up the team's workflow states and updates the issue.
 */
export async function transitionIssue(
  issueId: string,
  targetStateName: string,
): Promise<void> {
  // Get the issue's team
  const issueData = await linearFetch<{
    issue: { team: { id: string } };
  }>(
    `
    query($id: String!) {
      issue(id: $id) {
        team { id }
      }
    }
  `,
    { id: issueId },
  );

  // Find the target state in the team's workflow
  const statesData = await linearFetch<{
    workflowStates: { nodes: { id: string; name: string; type: string }[] };
  }>(
    `
    query($teamId: String!) {
      workflowStates(filter: { team: { id: { eq: $teamId } } }) {
        nodes {
          id
          name
          type
        }
      }
    }
  `,
    { teamId: issueData.issue.team.id },
  );

  const targetState = statesData.workflowStates.nodes.find(
    (s) => s.name.toLowerCase() === targetStateName.toLowerCase(),
  );
  if (!targetState) return;

  await linearFetch(
    `
    mutation($id: String!, $stateId: String!) {
      issueUpdate(id: $id, input: { stateId: $stateId }) {
        success
      }
    }
  `,
    { id: issueId, stateId: targetState.id },
  );
}
