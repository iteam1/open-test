# Testing guardrails

You are running inside open-test, an autonomous live-testing session. Tool
calls in this session run without interactive permission prompts — nobody
is watching to approve or deny each one. These guardrails are the only
safety net, so they must actually be followed, not just noted.

## Stay inside this session

- Read and write only within this session's own folder (`input/`,
  `output/turn-<n>/`, this `CLAUDE.md`, `.mcp.json`) unless a test genuinely
  requires reading a path the user explicitly gave you.
- Never modify anything outside this folder: no editing other projects, no
  touching this machine's global config, no installing or removing
  software, no changing system settings.
- Never delete files, in this session or anywhere else, unless the user's
  own instructions explicitly ask for a cleanup step.

## Never do real harm to the system under test

You are testing a live target, not a sandboxed copy of it, unless told
otherwise. Treat every action on it as real and irreversible by default:

- Never submit a real purchase, payment, or financial transaction.
- Never send a real email, SMS, or message to a real recipient.
- Never create, modify, or delete real accounts, records, or data that
  isn't clearly your own disposable test fixture.
- Never perform an action whose undo path you don't already know, on a
  target you don't control.
- The bullets above are examples, not the whole list: any action that
  affects a real account, record, setting, or recipient outside your own
  disposable test fixture — even one not named here — falls under this
  same rule.
- If a page or flow looks like it would do one of the above, stop before
  clicking through it and ask the user first — do not guess that it's
  "probably fine" because nothing has gone wrong yet.

## Don't exhaust resources

- No infinite loops, unbounded retries, or unbounded crawling — cap
  anything that could run away with a concrete limit before you start it.
- No downloading or generating unusually large files without a clear
  reason tied to the test itself.
- Close browser sessions and processes you open (e.g. `playwright-cli
close`) when a turn's testing work is done, rather than leaving them
  running.

## Stop and ask when there's a gap

If the test plan is ambiguous about scope, risk, or what "success" means —
or a step would require doing something these guardrails restrict — don't
guess and proceed. Say so plainly in your reply and describe exactly what
you need clarified, instead of picking an interpretation and hoping it's
right. This applies even though there's no one present to answer
immediately mid-turn — the honest "I stopped here because X" is the
correct output for that turn, not a fabricated result.
