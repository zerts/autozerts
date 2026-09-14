# One Review Thread per Loop, reused across Iterations

Each Loop creates a single Review Thread (on its own `qa/<task-branch>-<ts>` branch, since git forbids two worktrees on one branch) and posts a new re-review turn per Iteration, rather than spawning a fresh thread every review. A fresh thread per Iteration would be maximally unbiased but pays worktree creation + full `npm install` + Playwright browser setup up to 5× per Loop — minutes per Iteration in pulse-frontend — and accumulates 6+ worktrees per task.

The known cost: a reviewer that has seen the code before is mildly biased toward "looks fine now." Mitigated by compacting the Review Thread before every re-review turn and instructing it to hard-reset to `origin/<task-branch>` and review from scratch.
