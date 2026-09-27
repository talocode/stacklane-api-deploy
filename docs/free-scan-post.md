# Free single-file scan — post copy

The offer is one file, scanned free. It is deliberately small: it costs minutes to
fulfil, it needs no deploy, and it produces a real report the person can look at
before deciding anything. Every reply is a lead that already saw the output.

House style for this copy: short paragraphs with blank lines, ASCII punctuation,
no em dashes, no vendor names, no hype.

---

## Main post

Most leaked keys never actually get fixed.

Someone spots an API key in a commit, deletes the line, and considers it handled. The key
still works. It is still in the history, and everyone who has cloned the repository is
holding a copy. Deleting the line is tidying, not fixing.

Send me one file from your codebase and I will tell you what credentials are sitting in it.
Free, no signup, nothing to install.

First ten replies.

---

## Short variant

Offer: send me one file from your repo. I will scan it for leaked API keys, tokens and
passwords, and tell you exactly what is in it. Free.

The part most people get wrong: deleting a key from your latest commit does not revoke it.
It still works, and it is still in your git history.

First ten.

---

## Telegram variant

Most leaked keys never actually get fixed.

Someone notices an API key in a commit, deletes the line, and moves on. The key still works.
It is still in the history, and anyone who cloned the repo has a copy.

Send me one file from your codebase and I will scan it and tell you what is in it. Free.

First ten.

---

## Reply when a file arrives

> Got it, scanning now, back shortly.

Then send the report as produced by `scripts/secrets-audit.mjs`. Do not pad it.

## Reply if it finds nothing

> Nothing matched. Worth knowing that cheaply, honestly.

That reply matters more than it looks. Someone whose file comes back clean is a person who
now trusts the result when it is not clean.

## What not to say in any version

- Do not call it a security audit, a review, or a certification. It is a pattern scan.
- Do not promise it finds everything. Say what it checks and let the report state its limits.
- Do not say "your keys are exposed" to someone who has not sent you anything. You have not
  looked yet.
- Do not promise a turnaround faster than you can meet on a day you are busy.
