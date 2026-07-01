---
name: fragment-combine
description: Assemble several existing fragments into a larger composite flow for a multi-step test (e.g. login then add-to-cart then checkout), then save the whole sequence as one new fragment. Use when a test needs several already-saved fragments run in order.
---

# fragment-combine

When a test is really a sequence of flows you already have fragments for,
combine them into one composite rather than re-driving each live.

## When to use

A multi-step test where each step already exists as a fragment — e.g.
`login-flow` → `add-to-cart` → `checkout-flow`.

## How

1. Run each step in order with `run_fragment`, sharing the one browser
   context (the app keeps it across calls within the turn). Confirm the
   whole sequence passes end to end.
2. Write a composite that imports each dependency by name using the
   `fragment:` specifier — not a file path:

   ```js
   import { run as login } from 'fragment:login-flow'
   import { run as addToCart } from 'fragment:add-to-cart'

   export async function run(page, args) {
     await login(page, args)
     await addToCart(page, args)
   }
   ```

3. Save it with `save_fragment` (same verify gate as any fragment — its
   cold run must pass). Tag it so `match_fragments` can find it later.

If a dependency changes later, the app marks this composite
`needs_reverification` automatically, so it won't be silently trusted
against a changed dependency.
