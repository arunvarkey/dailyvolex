#!/usr/bin/env node
/* Is the image API actually reachable from here, and how fast?
 *
 * Eight of thirteen stories came back "timed out" at twenty seconds. The
 * search code already tells a 429 and an HTTP error apart from a hang, so
 * these are genuine hangs — but guessing why cost a twenty-minute render
 * cycle each time, and I guessed wrong once already (the timeout was not the
 * cause). This answers it in under a minute.
 *
 *   node automation/probe-images.mjs
 */

const API = 'https://api.openverse.org/v1/images/';
const QUERIES = ['india', 'Marco Rubio', 'Jaishankar', 'King Charles',
                 'Google Cloud', 'Afghanistan', 'Fighter Jets', 'Mumbai'];

async function one(q, timeoutMs = 25000) {
  const url = `${API}?q=${encodeURIComponent(q)}`
    + '&license=cc0,pdm,by&license_type=commercial,modification'
    + '&size=large&orientation=landscape&page_size=12&mature=false';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'user-agent': 'DailyVolex/1.0 (+https://github.com/arunvarkey/dailyvolex)' },
    });
    const ms = Date.now() - t0;
    let count = null;
    try { count = (await res.json())?.results?.length ?? null; } catch {}
    // Rate-limit headers, if Openverse is sending any. A key raises these
    // limits a long way, so it matters whether we are near them.
    const rl = ['x-ratelimit-remaining', 'x-ratelimit-limit', 'retry-after']
      .map(h => res.headers.get(h) ? `${h}=${res.headers.get(h)}` : null)
      .filter(Boolean).join(' ');
    return { q, ms, status: res.status, count, rl };
  } catch (err) {
    return { q, ms: Date.now() - t0, status: err?.name === 'AbortError' ? 'HUNG' : 'ERROR',
             detail: String(err?.message || err) };
  } finally { clearTimeout(timer); }
}

const show = r => console.log(
  `  ${String(r.status).padEnd(6)} ${String(r.ms + 'ms').padStart(8)}  `
  + `${r.count != null ? String(r.count).padStart(2) + ' results' : '          '}  `
  + `"${r.q}"${r.rl ? '   ' + r.rl : ''}${r.detail ? '   ' + r.detail : ''}`);

console.log('one at a time:');
const serial = [];
for (const q of QUERIES.slice(0, 4)) { const r = await one(q); serial.push(r); show(r); }

console.log('\nfour at once (what the renderer now does):');
const parallel = await Promise.all(QUERIES.slice(4).map(q => one(q)));
for (const r of parallel) show(r);

/* Also emit the findings as workflow annotations. The run log lives in blob
   storage that the API client here cannot follow, and a diagnostic nobody
   can read is not a diagnostic. */
const notice = m => console.log(`::notice::${m}`);
for (const r of [...serial, ...parallel])
  notice(`${r.status} ${r.ms}ms ${r.count != null ? r.count + ' results' : ''}`
    + ` "${r.q}"${r.rl ? ' ' + r.rl : ''}${r.detail ? ' ' + r.detail : ''}`);

const all = [...serial, ...parallel];
const ok = all.filter(r => r.status === 200);
const hung = all.filter(r => r.status === 'HUNG');
console.log(`\n${ok.length}/${all.length} answered, ${hung.length} hung`);
if (ok.length) {
  const times = ok.map(r => r.ms).sort((a, b) => a - b);
  console.log(`answered in ${times[0]}ms to ${times[times.length - 1]}ms`
    + `, median ${times[Math.floor(times.length / 2)]}ms`);
}
if (all.some(r => r.status === 429)) console.log('RATE LIMITED — an API key would raise this.');
if (hung.length > all.length / 2)
  console.log('Most requests hang. This is the host, not our timeout.');

notice(`SUMMARY ${ok.length}/${all.length} answered, ${hung.length} hung`
  + (ok.length ? `, median ${ok.map(r => r.ms).sort((a, b) => a - b)[Math.floor(ok.length / 2)]}ms` : '')
  + (all.some(r => r.status === 429) ? ' — RATE LIMITED' : ''));
