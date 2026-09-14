# Animation & motion pass

Invoke the `review-animations` skill (Skill tool) scoped to the changed motion
code. It reviews against a high craft bar (Emil Kowalski's animation
philosophy) that general code review does not cover.

Fold its output into `LOOP-REVIEW.md` as findings with `area: animation`:

- review-animations **Block** — or any feel-breaking regression it names
  (`ease-in` on UI, `scale(0)`/pure-fade entrance, animation on a
  keyboard/high-frequency action, a non-GPU animation with an easy GPU fix) —
  is at least `major` and drives the verdict to `needs-changes`.
- Pure polish (a nicer curve, an optional stagger, cohesion tuning) is `minor`
  and does not block, same as any other minor nit.

Cite `file:line` per finding, exactly as review-animations reports it.
