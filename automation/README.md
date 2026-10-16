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
08:00 IST  ─→  read RSS feeds
           ─→  group the same story across outlets, rank, pick the top 3
           ─→  render a graphic with the app itself, headless
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

## Try it without posting anything

```bash
node automation/test.mjs                         # 27 checks on the logic
node automation/shortlist.mjs --fixtures         # pick stories from saved samples
node automation/shortlist.mjs                    # or from the live feeds
node automation/render.mjs --digest --ratio 4:5  # make the graphic
node automation/caption.mjs --index 0            # write the caption
```

The graphic lands in `data/pending/`. Open it and see what you think.

You can also run the whole thing from the Actions tab — **Daily shortlist** →
*Run workflow*. It will open an approval issue and post nothing.

---

## Instagram setup (one-off, ~15 minutes)

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

**The token expires every 60 days.** Set a reminder — when it lapses, publishing
fails with a clear error on the issue and nothing is posted.

Until these secrets exist, everything else still works; only the final publish
step fails.

---

## Settings

Feeds live in `automation/feeds.json` — add or remove freely, no keys needed.

| Option | Default | Notes |
|---|---|---|
| `--count` | 3 | stories shortlisted |
| `--digest` | on in the workflow | one card with every headline, instead of one card per story |
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
