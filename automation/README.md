# DailyVolex automation

Finds the day's news, renders a graphic with the DailyVolex app, and asks you
to approve it before anything is posted.

**Nothing is ever posted without you approving it.** The scheduled job only
opens an issue. Publishing happens in a separate workflow that runs only when
you comment `/approve`.

Runs entirely on free GitHub Actions minutes. No API keys needed except
Instagram's, which are also free.

---

## How it runs

```
Mondays    ─→  check the Instagram token, warn well before it expires

08:00 IST  ─→  read RSS feeds
           ─→  group the same story across outlets, rank, pick the top 3
           ─→  render a carousel with the app itself, headless
                 (cover listing the stories, then a card for each)
           ─→  open a GitHub issue:  image + headlines + caption + sources
                                          │
                        you comment  /approve
                                          │
                                     post to Instagram
                                     record it so it never repeats
```

Stories carried by more outlets rank higher. That is the cheapest available
check that something is real and worth posting.

---

## Seeing what it makes, without an Instagram account

Nothing needs to be connected to watch this work. The daily job renders the
graphic and opens an issue; it has no way to post. Publishing lives in a
separate workflow that runs only on your `/approve` comment.

**On a phone:** <https://arunvarkey.github.io/dailyvolex/preview.html> shows the
latest run — the graphic, the stories with how many outlets carried each, and
the exact caption. It updates itself every time the job runs.

## Try it without posting anything

```bash
npm test                                         # 43 checks on the logic and token monitor
npm run test:all                                 # the above, plus the workflows themselves
node automation/shortlist.mjs --fixtures         # pick stories from saved samples
node automation/shortlist.mjs                    # or from the live feeds
node automation/render.mjs --carousel --ratio 4:5 # cover + a card per story
node automation/caption.mjs --index 0            # write the caption
```

The graphic lands in `data/pending/`. Open it and see what you think.

You can also run the whole thing from the Actions tab — **Daily shortlist** →
*Run workflow*. It will open an approval issue and post nothing.

---

## Instagram setup (one-off, ~15 minutes)

> Doing this for the first time? **[SETUP.md](SETUP.md)** is the same thing
> written out click by click, with what to check after each part and what the
> common errors mean. The summary below assumes you already know the Meta
> developer site.

Instagram only allows posting to **Business** or **Creator** accounts, through
a Facebook Page. A personal account cannot be posted to by any legitimate tool.

1. Instagram app → Settings → Account type → switch to **Business** or **Creator**
2. Link it to a Facebook Page (the app walks you through it; the Page can be new and empty)
3. Go to <https://developers.facebook.com/apps> → Create app → type **Business**
4. Add the **Instagram Graph API** product
5. In Graph API Explorer, grant: `instagram_basic`, `instagram_content_publish`,
   `pages_show_list`, `pages_read_engagement`
6. Get your Instagram account id:
   `GET /me/accounts` → take the Page id → `GET /<page-id>?fields=instagram_business_account`
7. Exchange the short token for a long-lived one (60 days):
   `GET /oauth/access_token?grant_type=fb_exchange_token&client_id=<app-id>&client_secret=<secret>&fb_exchange_token=<short-token>`

Then add two repository secrets (Settings → Secrets and variables → Actions):

| Secret | Value |
|---|---|
| `IG_USER_ID` | the Instagram business account id from step 6 |
| `IG_ACCESS_TOKEN` | the long-lived token from step 7 |

Until these secrets exist, everything else still works; only the final publish
step fails.

### The token expiring is the thing most likely to break this

A long-lived token lasts **60 days**. When it lapses, publishing fails and the
channel quietly stops posting.

Two things guard against that:

**The weekly check.** `Instagram token check` runs every Monday and opens an
issue once the token is within 21 days of expiry, updating that same issue
rather than opening a new one each week. It closes itself once the token is
renewed. A network failure never raises a false alarm — it reports "could not
tell" and stays quiet.

Run it on demand any time: Actions → **Instagram token check** → *Run workflow*.

**Better: use a token that never expires.** A **Page** access token derived
from a long-lived **user** token does not expire at all. Set it up this way
once and the reminder never fires:

1. Get a long-lived *user* token (step 7 above)
2. Call `GET /me/accounts?access_token=<long-lived-user-token>`
3. Take `access_token` from the Page in that response — **that** is the
   non-expiring one
4. Use it for `IG_ACCESS_TOKEN`

The check reports `this token does not expire` when you have it right.

---

## Where the pictures come from

Each story card gets a real photograph where one can legally be used, and a
generated market chart where it cannot. Both are automatic.

**The outlet's own article photograph is used first, and it is not licensed.**
This is the owner's explicit decision, taken twice and in those words: the
story is what matters, and a library picture of something else is not the
story. Those images belong to Reuters, AP, Getty or the publisher, and a
rights holder can issue a takedown against any of them. The approval issue
states it on every run — "N of M pictures are the outlets' own photographs,
used without a licence and credited to them by name" — so whoever approves a
post sees the position restated rather than having to remember it.

This paragraph used to say the opposite, and said it for weeks after the
decision had been made and the code had been changed. A README that
contradicts the behaviour is worse than no README: it is the document someone
reads instead of the code.

Order of preference: the picture in the outlet's own feed, then the one its
article declares as `og:image`, then the openly licensed library below, then a
generated backdrop. A picture smaller than the card is held back while bigger
ones are tried, and used only if nothing bigger exists.

The library, when it is reached, is [Openverse](https://openverse.org), which
indexes openly licensed work, filtered to the licences that permit commercial
reuse:

| Licence | Used | Why |
|---|---|---|
| CC0, Public Domain | yes | no conditions |
| CC BY | yes | credit required — and it is printed on the graphic |
| CC BY-SA | **no** | share-alike would arguably cover the finished graphic |
| CC BY-NC | **no** | non-commercial |
| CC BY-ND | **no** | no derivatives, and the graphic is a derivative |

The credit is drawn onto the card itself, bottom right. A photo with no credit
is never used — that is enforced in the page, not just intended.

The subject is chosen from the headline: "Federal Reserve" finds the building,
"Sensex" finds Mumbai, "oil" finds a refinery. If nothing suitable and suitably
licensed turns up, or the search is slow or down, the card falls back to the
generated chart. A missing photo never fails a run.

Run with `--no-photos` to skip the search entirely.

## Settings

Feeds live in `automation/feeds.json` — add or remove freely, no keys needed.

| Option | Default | Notes |
|---|---|---|
| `--count` | 3 | stories shortlisted |
| `--carousel` | the workflow default | cover slide listing everything, then a card per story — the strongest format for saves and shares |
| `--digest` | — | a single card with every headline |
| `--posy` | `-0.10` | lifts the headline block on story cards; `0` sits it at the bottom |
| `--ratio` | `4:5` | `4:5` is the largest Instagram feed size; `9:16` for Stories |
| `--theme` | `bbc` | any theme the app offers |
| `--layout` | `breaking` | ignored when `--digest` is used |

The schedule is the `cron` line in `.github/workflows/daily.yml` (it is in UTC;
`30 2 * * *` is 08:00 IST).

---

## Things worth knowing

**Check single-source stories.** The approval issue flags any story carried by
only one outlet. Those are the ones most likely to be wrong.

**Headlines are only ever shortened, never rewritten.** The shortener removes
words; it never adds any, never sharpens a claim and never turns a hedge into a
fact. A test enforces this. If a headline gets cut so hard it stops making
sense, it is marked unusable and skipped rather than posted as a fragment.

**Fonts.** If the runner cannot reach Google Fonts the headline silently falls
back to a serif face and looks wrong. The render warns loudly when this
happens — do not approve those.

**Rate limits.** Instagram allows 50 posts per 24 hours. Two or three a day
looks like a normal account; twenty does not.

**Costs.** Nothing. The daily run takes about a minute of the 2,000 free
Actions minutes per month. Rendering video would cost far more time than
images — that is why this posts graphics.
