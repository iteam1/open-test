---
name: fragment-learn
description: After driving a reusable browser flow live and confirming it worked, save it as a fragment so the next turn can replay it cheaply instead of driving it live again. Use this once a live-driven flow has succeeded.
---

# fragment-learn

The point of this whole system: after you do a flow the expensive way
(live), capture it so it never has to be done live again. But only capture
flows worth reusing — recurring steps, not one-offs.

## When to use

Right after a live-driven flow succeeds and it's the kind of step a later
turn (or a later test) will need again — login, navigation, add-to-cart,
cookie-banner dismissal, and so on.

## How

Call `save_fragment` with:

- `name`: a short kebab-case id (e.g. `login-flow`).
- `description`: one line on what it does — this is what a future
  `match_fragments` shortlist shows.
- `scope`: `specific` if it targets one app with a precise `url_pattern`
  (brittle CSS selectors are allowed), or `common` if it's general and
  matched by tags (use role-based selectors so it generalizes).
- `url_pattern`: a glob like `https://example.com/login*`. Empty/broad for
  `common` fragments.
- `verify_url`: the concrete page you just tested on. **Required for a
  `common` fragment** — its `url_pattern` is broad/empty and can't be
  navigated to, so the cold run needs a real URL. Optional for a
  `specific` fragment (the `url_pattern` with its `*` stripped is used).
- `tags`: categories for matching, e.g. `["auth"]`.
- `params`: the inputs the code takes, each with `name`, `type`,
  `required`, optional `default`, and `description`.
- `code`: an ES module exporting
  `export async function run(page, args) { ... }`. Start it with a
  precondition assert (e.g. the URL) so a stale fragment fails fast.

`save_fragment` re-runs your code once from a cold, isolated browser before
saving. If that cold run fails, it rejects the save — usually because the
code secretly depended on state left over from your live run. Fix the code
to be self-contained (declare and set up what it needs) and try again. You
don't need to verify it yourself; the tool does.
