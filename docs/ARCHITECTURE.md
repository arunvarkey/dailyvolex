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
work/                      git-ignored. Photos, reel frames, receipts, the
                           text of a /correct comment on its way in.
data/editions/2026-10-20/  edition.json, caption-<section>.txt, and per
                           section slide-*.jpg, alt.json, reel.mp4
data/editions/2026-10-20-breaking-0915/
data/editions/2026-10-20-correction-1100/
data/latest.json           which edition is current
data/ledger.json           the permanent record. Text. Append-only.
```

Every run writes its own directory and nothing overwrites anything. The watch
fires every fifteen minutes; when they all shared one folder, an approval from
an hour ago pointed at files that had since been replaced, and the only thing
between that and the account was a commit hash parsed out of an issue body.
An approval now pins the edition **and** the commit, both read from the image
URLs the issue is showing.

Slides are JPEG at quality 0.95. A card is type over a gradient or a
photograph, which is what JPEG is for: the same fifteen slides came to 10.5 MB
as PNG and 1.6 MB as JPEG, with no visible difference in the headline, and
Instagram re-encodes to JPEG whatever arrives. `dv.mjs prune` keeps the last
ten editions in the working tree; the history keeps them all, because an
approved post has to stay fetchable from the commit it was pinned to.

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

1. ✅ **Stop committing work.** `work/`, git-ignored; photographs and reel
   frames move there, and the download takes the 1600-pixel rendition rather
   than the master.
2. ✅ **Declare the edition.** `lib/edition.mjs` — the shape, a validator that
   refuses to offer a malformed edition, and `fromShortlist` so the stages
   downstream could be built against it before the stages upstream produce it.
3. ✅ **Empty the YAML.** Every decision is a module now:
   `lib/offer.mjs` (all three approval issues — daily, breaking, correction),
   `lib/plan.mjs` (what `/approve top reel` posts), `lib/ledger.mjs` (the
   permanent record). `publish.mjs` takes the plan and publishes it, reels
   included. Four workflows lost 237 lines between them, and
   `test-workflows.mjs` now fails if a decision creeps back in.
4. ✅ **One entry point.** `automation/dv.mjs` — `offer`, `plan`, `record` and
   `day`. `npm run day` reads whatever has been rendered and prints the
   edition, every warning the owner would see, and what each possible
   approval would post. No GitHub, no Instagram.
5. ✅ **Retire the god object.** `data/shortlist.json` is gone. Every stage
   reads and writes an edition: the shortlist creates one, the render attaches
   a carousel per section, the caption fills in its path, the reel attaches a
   second post. `lib/compose.mjs` is the pure stage the table above promises —
   layout, figure, backdrop and description decided without a browser.
   `data/posted.json` became `data/ledger.json`, and `data/rejected.json` went
   inside the edition, which is where the approval issue was already looking
   for it.
6. ✅ **Prune the history.** `data/pending/` was removed from all 128
   commits with `git filter-repo`. The packed repository went from **293 MB
   to 601 KiB**, and a fresh clone of `main` is 1.2 MB.

   It was checked rather than assumed: the HEAD tree hash is byte-identical
   before and after (`186ac699…`), so not one tracked file changed; every
   commit message, author and date is preserved; and the single commit that
   disappeared was one whose entire content was four slides and a caption
   under `data/pending/`, which becomes an empty commit once that path is
   gone. 283.5 MB of the 293.1 MB lived under that one directory.

   `backup/pre-prune-2026-10-20` on the remote still holds the old history.
   **Until it is deleted the space is not actually reclaimed** — a default
   `git clone` fetches every branch, so it still pulls 268 MB. Delete it with
   `git push origin --delete backup/pre-prune-2026-10-20` once the result
   looks right.

   The seven open approval issues were closed with it. They pinned
   `data/pending/` paths the approval workflow no longer accepts and commits
   that no longer exist, so none of them could have been published anyway.

## What still grows

An edition is about 4.3 MB — fifteen JPEG slides and a reel — and the history
keeps every one, because an approved post has to stay fetchable from the
commit it was pinned to. That is roughly 1.5 GB a year, which is a problem to
solve once rather than a problem now. The options, when it matters: prune
editions older than a few months from the history the same way, or host the
published assets somewhere that is not a git repository. Both need deciding;
neither is urgent while the number is small.
