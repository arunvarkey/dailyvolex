# Posting, every day

The setup in [SETUP.md](SETUP.md) is done once. This is the bit you do
forever, and it takes about two minutes a morning.

---

## The whole thing in one picture

```
08:00 IST   the run picks the day's stories, draws the cards, builds a reel
08:05 IST   an issue appears in your repo with every card and caption
you        read it, comment /approve …
instantly   it posts, and the issue tells you where
```

That's it. **Nothing posts unless you comment.** Not on a schedule, not by
accident, not if you ignore it.

---

## Your two minutes

### 1. Open the issue

GitHub app, or <https://github.com/arunvarkey/dailyvolex/issues>. It is titled
**"Approve post — "** and today's date. The newest one is the only live one;
yesterday's withdraws itself.

### 2. Look at the cards

Each story is its own block. Tap one open and you see:

- the card exactly as it will appear
- the headline, the outlets that carried it, and how many
- the caption, word for word
- a **⚠️ Check** section — anything the run was unsure about

**Read the Check section.** That is the whole reason a human is in this loop.
It says things like "has only ONE newsroom behind it", "was shortened to fit
the card", "no photo", or "N pictures are the outlets' own, used without a
licence". None of those stops the post — they are for you to judge.

### 3. Comment what you want

| You type | What posts |
|---|---|
| `/approve top-1` | that one story |
| `/approve top-1 reel` | that story, and the reel of it |
| `/approve top` | every story in the Top section |
| `/approve all` | everything offered |
| `/approve` | Top stories only |
| nothing | nothing |

You can approve one story now and another later — the issue stays open while
it still has something left to offer, and tells you what remains.

**Wrong word?** It refuses rather than guessing. `/approve tpo-1` posts
nothing and says so.

### 4. Done

The issue replies `✅ Posted to Instagram` with what went out. If something
failed, it says which step and what the error was, and anything already
posted stays posted.

---

## Posting right now, not at 08:00

Two ways, both from a phone.

**From the repo:** edit `.github/run-now`, add any line, commit. A run starts
within a minute.

**From the Actions tab:** **Daily shortlist** → *Run workflow*.

Both open a new approval issue. Neither posts anything on its own.

> One caution: a story offered and not approved is remembered for 36 hours and
> will not be offered again, so running repeatedly in one day uses up the
> day's news. If you just want to look without spending it, tick
> **Measure only** on the Run workflow form.

---

## Reach, and what this channel will and will not do for it

You asked for stories people share. Here is exactly what was built, so you
know what you are getting.

**The follow line is on every card.** The strip along the bottom used to say
"DAILYVOLEX ··· TODAY'S NEWS", which tells a reader what they are already
looking at. It now says **FOLLOW @DAILYVOLEX FOR MORE STORIES LIKE THIS**. It
is the only furniture on every card, so it is the only place the invitation
can live without adding clutter.

**The caption asks for a share first, then a follow.**

```
Know someone who should see this? Send it to them.
Follow @dailyvolex for more stories like this — every morning,
with the outlets named.
```

Share first on purpose: a share reaches people who have never seen the
account, a follow only reaches somebody already looking at it.

**The ranking now has a reach score.** Among stories that matter equally, the
one a reader would pass on goes first. It pays for:

| Signal | Why people forward it |
|---|---|
| a figure — "$25bn", "40 killed" | one fact you can retell in a sentence |
| how many people it happened to | scale is what makes it matter to a stranger |
| a first, a record, a largest | genuinely new |
| somebody convicted, fined, resigning | people share consequences |
| a rescue, a release, a recovery | good news travels, and this channel is short of it |
| it happened in India | it is about the reader |

The approval issue prints the reason under each headline (`reach: carries a
figure people can repeat; …`) so you can disagree with the order.

**What it will not do, and this is deliberate.** It does not pay for outrage
("slams", "blasts", "shocking"), celebrity, speculation about what might
happen, headlines phrased as questions, or stories about what somebody said
rather than what somebody did. Those are what make a news account go viral and
then stop being a news account.

And the score is **capped below one tier**. The most shareable trivial story
still loses to the dullest genuine lead. Reach decides what goes first among
equals; it never decides what matters. There is a test holding that open, and
if you ever want it changed, that is the number to argue about.

---

## Once a week, roughly

Nothing to do. Two things watch themselves:

- **Mondays** the token is checked. If it is within 21 days of expiring, or
  broken, an issue opens. If you took the non-expiring Page token in setup,
  this never fires.
- **Any failed run** opens an issue naming the step that broke, and closes it
  when a run succeeds.

If neither has opened an issue, nothing is wrong.

---

## If you got something wrong after posting

Corrections are a first-class thing here, not an afterthought.

Open an issue describing what was wrong. The correction is drafted as its own
card, offered for approval like anything else, and when you approve it, it is
**posted as a comment on the original post** — so anyone who finds the mistake
finds the correction with it.

The original is never deleted. A channel that quietly removes its mistakes is
less trustworthy than one that owns them.
