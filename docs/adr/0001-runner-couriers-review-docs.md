# Review Docs travel through the Runner, never through git

The Implementation Thread and Review Thread sit in different worktrees, so sharing the Review Doc through git would force the Review Thread to push onto the PR branch — two writers on one branch, plus permanent review noise in every PR diff. Instead the Review Thread writes the doc at a fixed path in its own worktree, and the Runner couriers it: archives a copy per Iteration in its data dir, injects the content into the Implementation Thread's next fix turn, and posts it as a PR comment for human visibility.

## Considered options

- Commit to the PR branch (`docs/reviews/<TASK>.md`) — rejected: writer conflicts with the impl thread, diff pollution, must be stripped before merge.
- Gitignored file copied into the impl worktree — rejected: invisible to humans and lost on worktree cleanup.

## Consequences

The original spec's "save result in the doc in the repo" is satisfied by the PR comment + Runner archive, not a committed file. If the Runner's data dir is wiped, review history survives only in PR comments.
