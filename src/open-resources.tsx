import {
  List,
  ActionPanel,
  Action,
  Icon,
  Color,
  showToast,
  Toast,
} from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { getConfig } from "./utils/preferences";

interface ResourceItem {
  name: string;
  path: string;
  type: "worktree" | "plan";
  repoName?: string;
  modifiedAt: Date;
}

export default function OpenResources() {
  const { data, isLoading, error } = usePromise(async () => {
    const fs = await import("fs/promises");
    const path = await import("path");
    const config = getConfig();
    const items: ResourceItem[] = [];

    // Scan worktrees: <worktreeBasePath>/<repoName>/<branchName>/
    if (config.worktreeBasePath) {
      try {
        const repoDirs = await fs.readdir(config.worktreeBasePath, { withFileTypes: true });
        for (const repoDir of repoDirs) {
          if (!repoDir.isDirectory()) continue;
          const repoPath = path.join(config.worktreeBasePath, repoDir.name);
          try {
            const branchDirs = await fs.readdir(repoPath, { withFileTypes: true });
            for (const branchDir of branchDirs) {
              if (!branchDir.isDirectory()) continue;
              const worktreePath = path.join(repoPath, branchDir.name);
              const stat = await fs.stat(worktreePath);
              items.push({
                name: branchDir.name,
                path: worktreePath,
                type: "worktree",
                repoName: repoDir.name,
                modifiedAt: stat.mtime,
              });
            }
          } catch {
            // Skip unreadable repo dirs
          }
        }
      } catch {
        // Worktree base path doesn't exist
      }
    }

    // Scan plan files: <planFilesPath>/*-plan.md
    if (config.planFilesPath) {
      try {
        const planFiles = await fs.readdir(config.planFilesPath, { withFileTypes: true });
        for (const file of planFiles) {
          if (!file.isFile() || !file.name.endsWith("-plan.md")) continue;
          const filePath = path.join(config.planFilesPath, file.name);
          const stat = await fs.stat(filePath);
          const branchName = file.name.replace(/-plan\.md$/, "");
          items.push({
            name: branchName,
            path: filePath,
            type: "plan",
            modifiedAt: stat.mtime,
          });
        }
      } catch {
        // Plan files path doesn't exist
      }
    }

    // Sort by most recently modified first
    items.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());

    return items;
  });

  if (error) {
    showToast({
      style: Toast.Style.Failure,
      title: "Failed to scan resources",
      message: error.message,
    });
  }

  const worktrees = data?.filter(i => i.type === "worktree") ?? [];
  const plans = data?.filter(i => i.type === "plan") ?? [];

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Filter worktrees and plans...">
      {worktrees.length > 0 && (
        <List.Section title="Worktrees">
          {worktrees.map(item => (
            <List.Item
              key={item.path}
              title={item.name}
              subtitle={item.repoName}
              icon={{ source: Icon.Folder, tintColor: Color.Blue }}
              accessories={[
                { date: item.modifiedAt, tooltip: `Modified: ${item.modifiedAt.toLocaleString()}` },
              ]}
              actions={
                <ActionPanel>
                  <Action.Open
                    title="Open in VS Code"
                    icon={Icon.Code}
                    target={item.path}
                    application="Visual Studio Code"
                  />
                  <Action.ShowInFinder title="Show in Finder" path={item.path} />
                  <Action.CopyToClipboard title="Copy Path" content={item.path} />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}

      {plans.length > 0 && (
        <List.Section title="Plans">
          {plans.map(item => (
            <List.Item
              key={item.path}
              title={item.name}
              icon={{ source: Icon.Document, tintColor: Color.Purple }}
              accessories={[
                { date: item.modifiedAt, tooltip: `Modified: ${item.modifiedAt.toLocaleString()}` },
              ]}
              actions={
                <ActionPanel>
                  <Action.Open
                    title="Open in VS Code"
                    icon={Icon.Code}
                    target={item.path}
                    application="Visual Studio Code"
                  />
                  <Action.ShowInFinder title="Show in Finder" path={item.path} />
                  <Action.CopyToClipboard title="Copy Path" content={item.path} />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}

      {!isLoading && !worktrees.length && !plans.length && (
        <List.EmptyView
          title="No resources found"
          description="No worktrees or plan files exist yet."
          icon={Icon.Folder}
        />
      )}
    </List>
  );
}
