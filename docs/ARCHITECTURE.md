# DailyVolex — architecture

This document is the contract. Where the code disagrees with it, the code is
wrong.

## What this system is

A news channel that posts nothing without its owner's say-so, publishes only
what an outlet actually published, and corrects itself in the open. Everything
below exists to make those three sentences true by construction rather than by
good intentions.

## What was wrong

The pipeline worked and the shape around it did not. Three things, found by
measuring rather than by reading:

**One mutable object pretended to be the whole system.** `data/shortlist.json`
was written by six stages in turn — `stories`, then `sections`, then `output`,
then `options`, and the renderer writing `photo`, `backdrop`, `layout` and
`stat` back onto the stories it had been handed. Nobody declared its shape; it
accreted. Two stages could disagree about a field name and nothing would say
so until something wrong went out under the channel's name.

**Decisions lived in YAML.** Which sections exist, how the approval issue
reads, what `/approve top business` means, what actually gets posted — all of
it inside workflow `script:` blocks. A decision inside a workflow cannot be run
on a laptop, so it was always first executed in production, and the tests for
it worked by string-evaluating JavaScript out of a YAML file. Every expensive
bug in this repo's history was in that layer: the caption file the breaking
watch read by a name that no longer existed, the approval that published
whatever happened to be in `data/` rather than what the issue showed.

**Everything the pipeline touched was committed.** Source photographs are
inputs to the renderer. They are downloaded at full Wikimedia resolution — one
was 18 MB — they are baked into a slide within seconds, and they are never
published. They were being committed anyway, because they were written under
`data/` and `data/` is what gets pushed. The repository was carrying about
290 MB of throwaway JPEGs after a handful of days. At that rate the free
hosting this channel depends on stops working within weeks, which makes it an
architecture problem rather than a tidiness one.

## The three kinds of data

Everything in this system is one of three things, and they have three
different lifetimes. Conflating them is what caused the 290 MB.

| | example | lives for | committed |
|---|---|---|---|
| **work** | source photographs, reel frames, the feed pool | minutes | never |
| **publishable** | slides, `reel.mp4`, captions, alt text, the edition | until posted or discarded | yes — pinned, prunable |
| **record** | media ids, permalinks, what was corrected | forever | yes — text only |

```
work/                      git-ignored. Nothing here is ever published.
data/editions/<id>/        one day's publishable output, immutable once offered
data/ledger.json           the permanent record. Text. Append-only.
```

## The edition

One immutable artefact, written once, with a declared schema:
`data/editions/<id>/edition.json`.

It holds everything that was *decided*: the sections, the stories in each, and
per story the tier, the corroborating newsrooms and who owns them, the
photograph and its licence, the layout, the figure on a stat card, the
backdrop, the alt text and the caption. Also what was refused and why.

After it is written, nothing mutates it. Later stages add sibling files —
`slide-*.png`, `reel.mp4`, `caption.txt`, `alt.json` — they never reach back
into it. The commit containing the edition is what an approval pins, so "what
you approved is what posts" is true because the bytes cannot have changed, not
because a regex found a SHA in an issue body.

## The pipeline

Each stage is a module with a test, plus a thin subcommand. The stages marked
**pure** touch no network, no disk and no clock — they are the ones where every
real bug has been, and purity is what makes them checkable.

| stage | in | out | |
|---|---|---|---|
| `ingest` | feeds | `work/pool.json` | network |
| `editorial` | pool | `edition.json` | **pure** — rank, cluster, corroborate, section, refuse |
| `imagery` | edition | `work/photos/*` | network. Originals never leave `work/` |
| `compose` | edition + photos | card specs | **pure** — layout, stat, backdrop, alt, caption |
| `render` | card specs | `slide-*.png` | headless Chrome |
| `reel` | card specs | `reel.mp4` | ffmpeg |
| `offer` | edition + assets | the approval issue | **pure** — text in, text out |
| `plan` | edition + the owner's comment | what to post | **pure** — `/approve top reel` → exactly those |
| `publish` | plan + credentials | Instagram, receipts | the only stage that holds the token |
| `record` | receipts | `data/ledger.json` | |

A workflow may contain checkout, node, one command, and a push. Nothing else.
If a workflow has to decide something, the decision belongs in a module.

## Invariants

These are the reasons the channel is worth running. Any change that weakens
one is a change that should not land.

1. **Nothing posts without the owner.** `publish` is reachable only from an
   owner-authored `/approve` on an open, labelled issue. No schedule, no other
   workflow, no other person. One step is given the credentials and it is the
   only step that has them.
2. **Nothing is written that an outlet did not publish.** The shortener only
   ever removes words. No stage rephrases a headline, and none invents one —
   including to fit a layout.
3. **Pictures are openly licensed, credited, and labelled "File photo".** CC0,
   public domain or CC BY only; refused at parse time otherwise. No library
   photograph of an identifiable person in a story about harm.
4. **Corroboration means independent.** Two newsrooms with one owner are one
   newsroom, and a republisher is not a newsroom.
5. **Corrections are posted, never deleted** — as a comment on the post they
   correct, so whoever finds the mistake finds the correction with it.
6. **A blind reader gets the news.** Every slide carries a description.
   Instagram does not accept alt text on a reel, so a reel is never the only
   form a story is published in, and its caption carries every headline.
7. **A run that fails says so.** Unattended automation that fails quietly is
   not automation.

## What survives

Every module under `automation/lib/` — importance, outlets, sections, select,
commons, imagery, headline, statcard, alttext, reelplan. That is the editorial
judgement of the channel, about 2,200 lines under 289 tests, and none of it
changes. This architecture is about what surrounds it.

## Order of work

Each step leaves the channel working.

1. **Stop committing work.** `work/`, git-ignored; photographs and reel frames
   move there. Fixes the 290 MB.
2. **Declare the edition.** `lib/edition.mjs` — schema and validator. Written
   alongside the shortlist before anything reads it.
3. **Empty the YAML.** The approval issue becomes `lib/offer.mjs`; `/approve`
   becomes `lib/plan.mjs`. Both pure, both tested. The reel's wiring lands
   here, where it can be tested.
4. **One entry point.** `npm run day` builds a whole edition locally — no
   GitHub, no Instagram — and prints exactly what would be posted.
5. **Retire the god object.** Cut the stages over to the edition and delete
   the adapters.
