# Secrets audit

I scan your codebase for credentials that should not be there — API keys, access tokens,
private keys, hardcoded passwords — and tell you what to rotate, what to remove, and what is
still sitting in your git history.

**$99. One repository. Report back within 48 hours.**

## The part most people get wrong

Deleting a key from your latest commit does not make it stop working.

If a credential ever landed in a repository, it is readable by anyone with that repository —
in an old commit, a deleted branch, a fork somebody cloned months ago. Removing it from the
current code is tidying, not fixing. The key has to be **rotated at its source**, and that has
to happen before history is rewritten, because rewriting history does nothing for a key that
still authenticates.

That is usually where a leak turns into an incident: somebody removes the line, feels finished,
and never revokes the key.

## What you get

- Every finding with **file, line and severity**, ordered so the dangerous ones are first
- A **git-history pass**, so you know which credentials are still live regardless of what the
  current commit says
- **What to do for each one** — where to rotate it, what to replace it with, and how to stop it
  recurring
- A **scope statement** naming exactly what was scanned and what was skipped, so you know what
  the report does and does not cover

## What I do not need

You keep the credentials. I never need working keys, database access, or production logins to
run this — a copy of the repository or a tarball is enough. If a scan turns up something live,
rotating it is your action, not mine, and the report tells you exactly what to do.

## Try it before you buy it

**Send me one file and I will scan it free.** You see the actual output before any money
changes hands. If it finds nothing, you have learned that cheaply.

Send a file to start: [your contact handle here]

## Limits, stated plainly

- Detection is pattern-based. It finds credentials that look like credentials. It can miss
  unusual formats, and it can flag a string that turns out to be a harmless example.
- A clean report means nothing matched these patterns. It is not a guarantee that no credential
  is exposed, and it is not a security certification or a compliance audit.
- Scans run against a copy you provide. I do not retain it afterwards.
