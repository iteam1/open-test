---
name: fragment-lookup
description: Before driving any browser test step live, check for a reusable Playwright fragment that already does it. Use this whenever you are about to open a page, click, fill, or otherwise drive a test flow.
---

# fragment-lookup

Live browser driving is expensive — every action is an agent round trip.
A saved fragment runs the same steps in one shot. So before driving a flow
live, always look for one that already exists.

## When to use

At the start of any test step that navigates or interacts with a page.

## How

1. Call `match_fragments` with the target `url` (and `tags` if you know the
   category, e.g. `["auth"]`). It returns a ranked, capped shortlist —
   each entry has a `description`, its `params`, and its actual `code`.
2. Read the shortlist. Pick the one whose description and code genuinely
   fit what you need. If none fit, there's no match — drive the step live.
3. If one fits, call `run_fragment` with its `name` and the `args` its
   params require.
4. If `run_fragment` returns an error, the fragment no longer matches
   today's page — fall back to driving the step live this same turn. Do not
   retry the same fragment.

Never invent a fragment name. Only run one that `match_fragments` returned.
