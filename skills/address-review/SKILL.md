---
name: address-review
description: Fetches all unresolved review threads from the PR associated with the current branch and works through them one-by-one — applying code changes where the reviewer is right, replying with reasoning where they aren't, and resolving threads as it goes — then runs a Playwright QA pass with screenshots to verify the changes work. Use when the user says "address review", "handle review comments", asks to respond to PR feedback, or invokes /address-review.
---

# Address Review

## Quick start

User has a branch with an open PR that has review comments. Run the workflow: find PR → list unresolved threads → address each → commit and push.

## Workflow

### 1. Locate the PR

```bash
gh pr view --json number,headRefName,headRepository,baseRepository,url
```

If there is no PR for the current branch, stop and tell the user.

### 2. Fetch unresolved review threads

REST doesn't expose thread-resolution state. Use GraphQL:

```bash
gh api graphql -F owner=<owner> -F repo=<repo> -F pr=<number> -f query='
  query($owner:String!,$repo:String!,$pr:Int!) {
    repository(owner:$owner,name:$repo) {
      pullRequest(number:$pr) {
        reviewThreads(first:100) {
          nodes {
            id
            isResolved
            isOutdated
            path
            line
            comments(first:50) {
              nodes { id databaseId author { login } body diffHunk }
            }
          }
        }
      }
    }
  }'
```

Filter to threads where `isResolved == false`. Outdated threads (line no longer exists in the diff) are still worth reading — they may still be valid.

### 3. Address each thread

For every unresolved thread, in order:

1. **Read the context.** Open the file at `path:line`. Read enough surrounding code to understand the comment, not just the line.
2. **Decide.** Three outcomes:
   - **Agree** → apply the fix in code.
   - **Disagree** → don't change the code; prepare a reply explaining why.
   - **Need clarification** → prepare a reply asking the specific question. Don't guess.
3. **Reply to the thread** using the first comment's `databaseId`:
   ```bash
   gh api -X POST repos/<owner>/<repo>/pulls/<number>/comments/<databaseId>/replies \
     -f body="<reply text>"
   ```
   - If you applied a fix: reply briefly noting what changed (one line).
   - If you disagreed: reply with the reason.
   - If you're asking a question: reply with the question and skip resolving.
4. **Resolve the thread** (only when fix applied or disagreement is stated, not when waiting on an answer):
   ```bash
   gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id}}}' -F id=<thread.id>
   ```

Work through threads sequentially — don't batch the decision-making. Each thread can change your understanding of the next.

### 4. Commit and push

If any code changed, stage and commit with a message like `address review feedback` (or more specific if the changes share a theme). Push the branch — no force-push unless rebasing was explicitly required.

If no code changed (all replies, no fixes), skip the commit step.

### 5. QA the result with screenshots

After pushing, verify the addressed changes actually work in the running app —
don't trust the diff alone.

Skip this step only when no code changed, or when the changes are purely
non-UI (server-only, config, docs, tests). Otherwise run a QA pass:

1. Determine the affected flows from the threads you just addressed plus
   `git diff --name-only origin/<base>...HEAD`.
2. Follow the **`qa-playwright`** skill's mechanics for the heavy lifting:
   launch the app (§2), bootstrap Playwright outside the repo in a `$QA_DIR`
   (§3), and drive it headless at 1440×900 (also 390×844 if mobile-relevant).
3. Screenshot every affected flow — before AND after each interaction — into
   `$QA_DIR/screenshots/`. Collect console errors and failed requests on every
   page.
4. **READ each screenshot yourself** (the Read tool renders images) and judge
   it: does the change behave and look as the review asked? A screenshot you
   didn't look at is not evidence.
5. Read-only checks only — never submit transactions or mutate remote state.
6. Kill the dev server you started; leave `$QA_DIR` for the user and mention its
   path.

Report the QA verdict to the user with the screenshot directory path. If a
review thread asked for a visible change, reference the screenshot that proves
it. If QA surfaces that a fix didn't actually land or broke something, fix it
and re-run before considering the pass done — don't leave a thread resolved on
a change that doesn't work.

## Notes

- One commit for the whole pass is fine; don't fragment unless the changes are genuinely independent.
- Don't resolve a thread you didn't actually address. A thread the reviewer needs to see your reply on can stay unresolved.
- If a comment requests a change that conflicts with the original task or a prior decision, surface it to the user rather than silently complying.
- Never close or merge the PR.
