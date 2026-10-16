#!/usr/bin/env node
/* Check how much life is left in the Instagram token.
 *
 * Long-lived tokens last 60 days. When one lapses, publishing fails and the
 * channel quietly stops posting until somebody notices — which is exactly the
 * kind of failure nobody notices for a fortnight. This runs weekly and says so
 * in advance.
 *
 *   node automation/token-check.mjs [--warn-days 21]
 *
 * Exit codes:
 *   0  healthy, or nothing to check yet (no credentials configured)
 *   2  expiring soon
 *   3  already invalid
 *   4  could not tell (network or API trouble) — not treated as failure
 */

const GRAPH = 'https://graph.facebook.com/v21.0';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : fallback;
}

async function getJson(url) {
  const res = await fetch(url);
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { ok: res.ok, status: res.status, json };
}

/* Never print the token: this output goes into a public issue and a CI log.
   Meta's error messages sometimes quote the credential back bare, not only as
   access_token=..., so the value itself is removed as well. */
function redact(s, token) {
  let out = String(s || '').replace(/access_token=[^&\s]+/gi, 'access_token=***');
  if (token && token.length >= 8) out = out.split(token).join('***');
  return out;
}

export async function checkToken(token, { warnDays = 21 } = {}) {
  // debug_token gives the real expiry. It accepts the token itself as the
  // inspecting credential for tokens issued by the same app.
  const dbg = await getJson(`${GRAPH}/debug_token?input_token=${encodeURIComponent(token)}`
    + `&access_token=${encodeURIComponent(token)}`);

  if (dbg.ok && dbg.json?.data) {
    const d = dbg.json.data;
    if (d.is_valid === false)
      return { state: 'invalid', detail: redact(d.error?.message || 'the token is no longer valid', token) };

    // expires_at of 0 means it does not expire — a page token derived from a
    // long-lived user token behaves this way, which is the arrangement worth
    // having.
    if (!d.expires_at)
      return { state: 'ok', neverExpires: true, detail: 'this token does not expire' };

    const expiresAt = d.expires_at * 1000;
    const days = Math.floor((expiresAt - Date.now()) / 86400000);
    if (days < 0)  return { state: 'invalid', days, expiresAt, detail: 'the token has expired' };
    if (days <= warnDays) return { state: 'expiring', days, expiresAt };
    return { state: 'ok', days, expiresAt };
  }

  // debug_token refused. Fall back to asking whether the token works at all,
  // which at least separates "dead" from "cannot tell".
  const me = await getJson(`${GRAPH}/me?fields=id&access_token=${encodeURIComponent(token)}`);
  if (me.ok && me.json?.id)
    return { state: 'unknown', detail: 'the token works, but its expiry could not be read' };
  if (me.status === 400 || me.status === 401)
    return { state: 'invalid', detail: redact(me.json?.error?.message || `HTTP ${me.status}`, token) };

  return { state: 'unknown', detail: redact(me.json?.error?.message || `HTTP ${me.status}`, token) };
}

async function main() {
  const warnDays = Math.max(1, parseInt(arg('warn-days', '21'), 10) || 21);
  const token = process.env.IG_ACCESS_TOKEN;

  if (!token) {
    console.log('state=skipped');
    console.log('No IG_ACCESS_TOKEN set yet — nothing to check.');
    return 0;
  }

  let result;
  try {
    result = await checkToken(token, { warnDays });
  } catch (err) {
    // A network wobble must not raise a false alarm about the token.
    result = { state: 'unknown', detail: redact(err.message, token) };
  }

  console.log(`state=${result.state}`);
  if (result.days != null) console.log(`days=${result.days}`);

  switch (result.state) {
    case 'ok':
      console.log(result.neverExpires
        ? 'The token does not expire. Nothing to do.'
        : `The token is good for another ${result.days} days.`);
      return 0;
    case 'expiring':
      console.log(`The token expires in ${result.days} days — renew it before then.`);
      return 2;
    case 'invalid':
      console.log(`The token is not usable: ${result.detail}`);
      return 3;
    default:
      console.log(`Could not check the token: ${result.detail}`);
      return 4;
  }
}

if (process.argv[1] && process.argv[1].endsWith('token-check.mjs')) {
  main().then(code => process.exit(code));
}
