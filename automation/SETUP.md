# Turning the account on

Everything in this repository works today except the last step: putting the
post on Instagram. That step needs two values from Meta. This is how to get
them, with nothing assumed.

Budget about 30 minutes. You need a laptop for the Meta parts — the developer
site does not work properly on a phone.

When you are done, the channel shortlists the news at 08:00 IST every day,
opens an issue showing you every card, and posts only what you approve.

---

## What you are actually getting

| | |
|---|---|
| `IG_USER_ID` | a number that identifies your Instagram account to Meta |
| `IG_ACCESS_TOKEN` | a password-like string that lets this repo post as you |

Both go into GitHub as **repository secrets**. They never appear in the code,
in a commit, or in the app. One workflow step reads them.

---

## Part 1 — Make the account postable (5 minutes, phone is fine)

Instagram does not let any tool post to a **personal** account. Not this one,
not Buffer, not Later. This is Meta's rule and there is no way around it.

1. Open Instagram → your profile → ☰ menu → **Settings and privacy**
2. → **Account type and tools** → **Switch to professional account**
3. Choose **Creator** (or Business — either works)
4. When it offers to connect a Facebook Page, **say yes**

   If you have no Page, let it make one. It can be empty and nobody has to
   see it. The Page is plumbing: Meta's publishing API reaches Instagram
   *through* a Page, so without one nothing can post.

✅ **Check:** your Instagram profile now says "Creator" or "Business", and
Settings shows a linked Facebook Page.

---

## Part 2 — Make a Meta app (10 minutes, laptop)

This sounds scarier than it is. You are not publishing an app or getting
reviewed by anyone. You are making a private key for your own account.

1. Go to **https://developers.facebook.com/apps**
2. Log in with the Facebook account that owns the Page from Part 1
3. **Create app**
4. Use case: choose **Other** → Next
5. Type: choose **Business** → Next
6. Name it anything — `dailyvolex` is fine. Create.
7. On the app dashboard, find **Instagram** in the product list → **Set up**

Leave the app in **Development mode**. You do not need App Review, because
you are only ever posting to your own account, which is what Development
mode allows.

✅ **Check:** you have an app dashboard with Instagram listed as a product.

---

## Part 3 — Get the two values (10 minutes, laptop)

Go to **https://developers.facebook.com/tools/explorer** — the Graph API
Explorer. Top right, pick your app from the dropdown.

### 3a. Grant the permissions

Click **Add a permission** (or "Permissions" dropdown) and tick all four:

```
instagram_basic
instagram_content_publish
pages_show_list
pages_read_engagement
```

Then **Generate Access Token** and approve the dialog. You now have a
*short-lived* token in the box. It dies in an hour — that is expected, keep going.

### 3b. Find your Page

In the query box type `me/accounts` and press **Submit**.

The response looks like:

```json
{ "data": [ { "name": "DailyVolex", "id": "1234567890", "access_token": "EAA..." } ] }
```

**Copy the `id`.** That is your Page id, not the value we want yet.

### 3c. Find your Instagram id — this is `IG_USER_ID`

Query, with your Page id pasted in:

```
1234567890?fields=instagram_business_account
```

Response:

```json
{ "instagram_business_account": { "id": "17841400000000000" } }
```

👉 **That long number is `IG_USER_ID`.** Write it down.

> If `instagram_business_account` is missing, the Page and the Instagram
> account are not actually linked. Go back to Part 1 step 4.

### 3d. Get a token that never expires — this is `IG_ACCESS_TOKEN`

There are two kinds of token and it matters which you take.

- A **long-lived user token** lasts 60 days, then the channel silently stops.
- A **Page token derived from one** never expires at all.

Take the second. Three steps:

**i.** Get your App ID and App Secret: app dashboard → **App settings** →
**Basic**. The secret is hidden behind a "Show" button.

**ii.** In the Explorer, swap the short token for a long-lived one. Paste this
into the query box with your own values, and Submit:

```
oauth/access_token?grant_type=fb_exchange_token&client_id=YOUR_APP_ID&client_secret=YOUR_APP_SECRET&fb_exchange_token=YOUR_SHORT_TOKEN
```

Copy the `access_token` from the response.

**iii.** Now ask for your Pages again, using that long-lived token:

```
me/accounts?access_token=THE_LONG_LIVED_TOKEN_FROM_STEP_ii
```

👉 **The `access_token` on your Page in this response is `IG_ACCESS_TOKEN`.**
It does not expire.

> Treat it like a password. Anyone holding it can post as you. Do not paste
> it into a chat, an issue, or a commit.

---

## Part 4 — Put them into GitHub (2 minutes)

1. Go to **https://github.com/arunvarkey/dailyvolex/settings/secrets/actions**
2. **New repository secret** → name `IG_USER_ID` → paste the number → Add
3. **New repository secret** → name `IG_ACCESS_TOKEN` → paste the token → Add

Names must match exactly, capitals included. GitHub hides the values from
then on — even from you.

✅ **Check:** two secrets listed, `IG_ACCESS_TOKEN` and `IG_USER_ID`.

---

## Part 5 — Prove it works before you post (1 minute)

Go to **Actions** → **Instagram token check** → **Run workflow**.

What you want to see in the log:

```
this token does not expire
```

| Instead you saw | What it means |
|---|---|
| `this token expires in 59 days` | you took the user token, not the Page token — redo 3d iii |
| `the token is no longer valid` | the short token expired before you exchanged it — redo 3a |
| `No IG_ACCESS_TOKEN set yet` | the secret name is misspelled |

This check also runs itself every Monday and will open an issue if the token
ever goes bad, so the channel cannot fail quietly.

---

## Part 6 — The first post

1. Open the newest **"Approve post"** issue
2. Scroll the cards and read them — this is the whole point of the issue
3. Comment the words for what you want:

```
/approve top-1              one story
/approve top-1 reel         that story, and the reel of it
/approve top                every story in Top
/approve all                everything offered
```

That is it. The post goes up. The issue says what was posted and links it.

Nothing posts without one of those comments. Not on a schedule, not by
accident, not from this repository by anyone but you.

---

## What happens tomorrow, and every day after

| When | What |
|---|---|
| 08:00 IST | the run picks the day's stories, draws the cards, builds a reel |
| 08:05 IST | an issue appears with every card and caption |
| whenever | you comment `/approve …` and it posts |
| you do nothing | nothing is posted. The offer is withdrawn by the next day's |
| Mondays | the token is checked |

To post on demand rather than waiting for the morning, edit `.github/run-now`
(add a line, any text) and commit. That triggers a run from a phone.

---

## If something goes wrong

Every failed run opens an issue naming the step that broke, and closes it when
a run succeeds. Nothing fails silently.

Common ones:

| Symptom | Cause |
|---|---|
| "Media cannot be posted to a personal account" | Part 1 did not take |
| "(#200) Requires instagram_content_publish" | the permission was not ticked in 3a |
| "Invalid OAuth access token" | token expired, or has a stray space |
| The run says nothing was offered | the editorial rules refused everything today — not a fault |
