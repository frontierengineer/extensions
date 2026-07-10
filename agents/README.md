# Frontier Agent Catalog

The open catalog of shareable **agents** for [Frontier](https://frontierengineer.com).
An agent is a reusable role — a name, a one-line description, a few tags, and a
system-prompt body — that anyone can install into their Frontier agent library
in one click. Frontier's built-in "Browse the agent catalogue" reads from here.

Like the [extension registry](../README.md), this is open submission with trust
from automation, not gatekeeping — but an agent is **plain text, not code**:
there is no tarball, no install-time execution, and nothing to sandbox. So the
bar to publish is lower and the pipeline is simpler.

- **Identity is your GitHub identity.** An agent id is `<author>/<slug>`, where
  `<author>` is the GitHub account or org that owns it. You may only add or edit
  agents under your own login (or an org you're a public member of). The
  namespace comes from the file path, never a field in the file, so it can't be
  spoofed.
- **`frontier/…` is reserved** for the first-party starter agents. Community
  submissions use their own login.
- **Every submission is schema-checked** (required fields, size caps, no junk
  keys) and — when a review key is configured — passed through an LLM review
  that blocks a clearly-malicious prompt. Passing PRs **auto-merge**, no human
  review.

## How it works

```
publish:  PR agents/catalog/<you>/<slug>.json ──validate+auto-merge──▶ build ──▶ agents/index.json
browse:   Frontier ──reads──▶ agents/index.json ──install──▶ writes the definition into your local library
rate:     👍 a per-agent GitHub issue ──index build counts reactions──▶ `votes` on the catalog entry
```

1. **[`catalog/`](catalog/)** — one file per agent,
   `catalog/<author>/<slug>.json`, added by PR. Auto-merges when it passes
   validation (schema + namespace ownership).
2. **[`index.json`](index.json)** — generated. The build reads every catalog
   file, stamps `id`/`author` from the path, and (best-effort) adds a community
   `votes` count. This is the single file the Frontier host fetches.
3. Frontier caches the index and falls back to a bundled copy of the
   `frontier/…` starters when it can't reach GitHub, so browsing works offline.

## Publishing an agent

Add one file, `catalog/<your-github-login>/<slug>.json`:

```json
{
  "name": "SQL Tuner",
  "description": "Diagnoses slow queries and proposes indexes/rewrites. Use when a query is slow or a plan looks wrong.",
  "tags": ["sql", "performance", "database"],
  "body": "You are a database performance specialist. Given a slow query...\n\n..."
}
```

- `name` — display name (≤ 80 chars).
- `description` — one line; this powers both catalog search and Frontier's
  per-turn agent relevance, so write it as *when to use this agent* (≤ 400).
- `tags` — up to 12 short keywords (optional but recommended).
- `body` — the system prompt (≤ 20 000 chars). `id` and `author` are derived
  from the path; don't put them in the file.

Validate locally before opening the PR:

```
node scripts/build-agents-index.js   # from the repo root; rebuilds index.json
```

Open a PR with just your one file under `catalog/<you>/`. It merges
automatically once checks pass.

## Ratings

Ratings are votes without accounts or a server. Each agent has a GitHub issue
in this repo labelled `agent-rating` whose **title is the agent id**; one 👍
reaction on that issue is one vote. The index build sums the reactions into a
`votes` count and links the issue as `ratingUrl`, and Frontier shows both. The
vote lives on GitHub under the voter's own identity — the same trust model as
the extension registry's per-repo stars, with no Frontier login and no
server-side state.

To vote, open an agent's rating issue from the catalog and add a 👍. If an agent
has no rating issue yet, the catalog's "Vote" link opens a pre-filled issue so
the first voter can create it.

## Reporting a harmful agent

Open an issue with the `abuse` label. An agent is text you can read before
installing, and it runs with the tools you've already granted your assistant —
but a prompt engineered to mislead an assistant is still removable. Confirmed
abuse is delisted and the author's namespace can be blocked.

## Threat model, stated plainly

An installed agent is a **system prompt**, not code: it can't reach the network,
the filesystem, or your machine on its own. It influences how *your* assistant
behaves, using the tools you already gave it — exactly as if you had pasted the
prompt yourself. The real risk is a prompt written to *mislead* an assistant
(prompt injection, social engineering toward a destructive action). Defenses:
you can read the whole body before installing; every submission is
schema-checked and (with a key) LLM-reviewed for malicious intent; the
namespace is a real GitHub identity; and abuse is delistable. What this catalog
does not claim: that a submitted prompt is *good*, only that it is well-formed,
owned by a real identity, and not obviously malicious.
