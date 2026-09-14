# autozerts-private

Private companion to your public `autozerts` checkout. Everything the Runner
and its skills need that must **not** be published lives here: per-repo QA
recipes (test-account setup, internal hosts, feature-flag tricks) and internal
docs.

Keep this repo private. Commit it to your own remote or leave it local.

## Layout

```
qa-profiles/<repo>.md   read by /loop-qa; one file per target repo, named after
                        `basename $(git remote get-url origin)` (minus .git)
docs/                   internal notes: QA gate design, per-repo gotchas
```

No secret **values** live here either. Credentials, Playwright `storageState`
fixtures and seeded personas stay in the Runner's data dir (`DATA_DIR`, default
`~/.ai-runner/data`) under `qa/`:

```
qa/secrets/<repo>.json      credentials a profile reads (test accounts, dev keys)
qa/fixtures/                Playwright storageState files
qa/personas/<repo>/<name>/  other seeded state (e.g. an extension vault)
```

## Where this repo must live

Skills resolve this repo as `<autozerts>/../autozerts-private`, so the directory
name and the side-by-side layout matter:

```
<parent>/autozerts/
<parent>/autozerts-private/
```

## Adding a repo

1. Copy `qa-profiles/_example.md` to `qa-profiles/<repo>.md`.
2. Fill in the four sections. Serve and Authenticate are required; the rest can
   start empty and grow as `/loop-qa` records the blockers it solves (§7 of the
   skill appends to this file).
3. Put any credentials in `DATA_DIR/qa/secrets/<repo>.json` and reference the
   path from the profile.
4. Set `qaGate: true` and `qaPort` for the repo on the Runner's Config page.
5. Run `bun run doctor` in `autozerts` to confirm the profile is found.
