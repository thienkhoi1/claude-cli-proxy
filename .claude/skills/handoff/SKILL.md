---
name: handoff
description: "Use when the user wants to wrap up a session, hand off to the next session, resume from a prior session, or asks anything like \"handoff\", \"/handoff\", \"continue from yesterday\", \"where did we leave off\", \"pick this up later\". Reads/updates `progress.md` at the repo root so future sessions can resume without re-deriving context."
---

# Handoff

The single source of truth for cross-session continuity in this repo is
`progress.md` at the repo root. This skill writes to it on the way out and
reads from it on the way in. **Do not** scatter state into ad-hoc notes,
scratchpads, or memory entries that duplicate what belongs here.

There are exactly two flows: **resuming** and **handing off**. Pick the one
that matches what the user just asked for; never run both in the same turn.

## Resuming (start of a session)

Trigger phrases: *"continue", "resume", "pick this up", "where did we leave
off", "what's the state", "yesterday we were …"*

1. `Read` `progress.md`. The **most recent dated entry at the top** is the
   handoff that was written when the previous session ended — that is your
   ground truth.
2. Cross-check it against reality before trusting it:
   - `git -C <proxy repo> status` and `git log --oneline -5` to see if commits
     have moved since the handoff was written.
   - `lsof -nP -iTCP:3000 -sTCP:LISTEN` to see if the proxy is running.
   - For any file path or commit the handoff names, verify it still exists.
   If the handoff is stale, trust what you observe now and update the handoff
   entry — don't act on the stale claim.
3. State out loud, in one sentence, what you understood the resume point to
   be, before doing anything else. Lets the user correct you cheaply.
4. Then carry on with whatever the **Next steps** list said.

## Handing off (end of a session)

Trigger phrases: *"handoff", "/handoff", "wrap this up", "let's stop for the
day", "save progress"*

1. Do a quick honesty pass on what's actually true *right now*:
   - `git status` (both `claude-cli-proxy` and `awesome-a2a` if both were
     touched). Note any uncommitted edits — they are part of the handoff.
   - `git log --oneline -5` per branch to capture commits made this session.
   - `lsof -nP -iTCP:3000 -sTCP:LISTEN` and a quick `docker ps` for any
     supporting containers (a2a broker, MCP bridges).
2. **Prepend** a new dated entry to `progress.md` (most-recent-first). Use
   the template at the bottom of this file. Keep prose tight — a future
   reader skims this in 30 seconds, not 5 minutes.
3. Do **not** delete or rewrite previous entries. Old entries are the audit
   trail; if something is wrong, add a "**Correction (YYYY-MM-DD):** …" line
   under it rather than mutating history.
4. Offer to commit `progress.md`. Don't commit it automatically — the user
   may want to keep the working tree clean for a separate commit.
5. End the turn with the single line: `Handoff written. Resume with /handoff
   when you're back.` Nothing more.

## What goes in an entry, what does not

A good entry answers three questions a future reader will ask:

- **What changed this session?** Commits + uncommitted edits. Reference
  files by path and (where useful) `path:line`. Skip blow-by-blow narration.
- **What's the state right now?** Is the proxy running. Which branch each
  repo is on. What's deployed where. What's queued.
- **What's the very next step?** One sentence, action-oriented. If there
  are several, list them in priority order.

What does NOT belong in `progress.md`:
- Recaps of the conversation itself.
- Anything derivable from `git log` (the log is the log).
- Secrets, tokens, credentials, or anything from `~/.openclaw/openclaw.json`
  or `~/.claude.json`. Reference by name only ("Lily's A2A token").
- "Things we discussed but didn't decide" — those go in a Plan or a memory,
  not here.

## Entry template (copy this, prepend to `progress.md`)

```markdown
## YYYY-MM-DD — <one-line summary in active voice>

**Done**
- <change>, commit `<sha>` on `<repo>@<branch>`
- <uncommitted edit on path/to/file:line>

**State**
- Proxy: <running on :3000 since X, or stopped>
- Branches: `<repo>@<branch>` (clean / N uncommitted), …
- External: <any container/service the work depends on>

**Next**
1. <single-sentence next action>
2. …

**Blockers / notes**
- <anything that would surprise the next reader>
```

## When you decide not to write an entry

Trivial sessions (a one-line answer, a documentation tweak, a question
answered without changing state) do not need a handoff entry. Use judgement:
if the answer to "would the next session waste time without this?" is no,
skip it. Better one good entry per week than one shallow entry per turn.
