#!/usr/bin/env node
/* One way in.
 *
 * Until now a day existed only as a sequence of workflow steps, and the
 * decisions in the middle of it — how the approval issue reads, what
 * `/approve top reel` posts — lived inside YAML where they could not be run
 * on a laptop. So they were always first executed in production.
 *
 *   node automation/dv.mjs offer --sha <sha> [--out work/issue.json]
 *   node automation/dv.mjs supersede --open <path> --number <n> [--out work/supersede.json]
 *   node automation/dv.mjs plan  --comment-file <path> [--sha <sha>] [--out work/plan.json]
 *   node automation/dv.mjs record --issue <n> [--plan work/plan.json]
 *   node automation/dv.mjs prune [--keep 10]
 *   node automation/dv.mjs day                 what today's edition would offer
 *
 * `offer` and `plan` do the deciding and write JSON; the workflows just hand
 * that JSON to the GitHub API. A workflow may contain checkout, node, one
 * command and a push — see docs/ARCHITECTURE.md.
 *
 * `day` is the one that was missing: it reads whatever has been rendered and
 * prints exactly what would be posted and what the owner would be warned
 * about, without GitHub and without Instagram.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readJson } from './lib/store.mjs';
import { load, validate, posts, prune, KEEP_EDITIONS } from './lib/edition.mjs';
import { approvalIssue, warningsFor, superseded } from './lib/offer.mjs';
import { plan } from './lib/plan.mjs';
import { record } from './lib/ledger.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : fallback;
}

/* The repository, from the environment GitHub provides or from the remote. */
function repoSlug() {
  const env = process.env.GITHUB_REPOSITORY;
  if (env?.includes('/')) { const [o, r] = env.split('/'); return { owner: o, repo: r }; }
  return { owner: arg('owner', 'arunvarkey'), repo: arg('repo', 'dailyvolex') };
}

async function loadEdition() {
  const edition = await load(ROOT, arg('edition'));
  const wrong = validate(edition);
  // Refuse to offer a malformed edition rather than open an issue that
  // promises something the publisher cannot post.
  if (wrong.length) throw new Error(`this edition is not fit to offer:\n  ${wrong.join('\n  ')}`);
  return edition;
}

async function write(path, data) {
  if (!path) { console.log(JSON.stringify(data, null, 2)); return; }
  await mkdir(dirname(join(ROOT, path)), { recursive: true });
  await writeFile(join(ROOT, path), JSON.stringify(data, null, 2) + '\n', 'utf8');
  console.log(`written to ${path}`);
}

const read = p => {
  try { return p ? readFileSync(join(ROOT, p), 'utf8') : ''; } catch { return ''; }
};

async function cmdOffer() {
  const edition = await loadEdition();
  const sha = arg('sha', process.env.GITHUB_SHA);
  if (!sha) throw new Error('--sha is required: the issue has to pin the commit it is showing');
  const issue = approvalIssue(edition, {
    ...repoSlug(), sha, read,
    // The GitHub issue a correction was asked for on, so the draft can point
    // back at it. Only a correction has one.
    requestedBy: arg('requested-by', null),
  });
  if (issue.body.length >= 65536)
    throw new Error(`the issue body is ${issue.body.length} characters; GitHub takes 65536`);
  await write(arg('out'), issue);
}

/* Which older offers this one replaces. The workflow lists the open issues
   and closes what this names; which ones are stale is decided here. */
async function cmdSupersede() {
  const edition = await loadEdition();
  const open = await readJson(join(ROOT, arg('open', 'work/open-issues.json')), []);
  const n = arg('number', null);
  const close = superseded(edition, Array.isArray(open) ? open : [], {
    number: n == null ? null : Number(n),
  });
  console.log(close.length
    ? `superseding ${close.map(c => `#${c.number} (${c.edition})`).join(', ')}`
    : 'nothing older is still open');
  await write(arg('out'), { close });
}

async function cmdPlan() {
  const edition = await loadEdition();
  // From a file, never from argv. The comment is written by a person in a
  // GitHub comment and has no business passing through a shell.
  const file = arg('comment-file');
  const comment = file ? await readFile(file, 'utf8') : arg('comment', '/approve');
  const sha = arg('sha', process.env.GITHUB_SHA);
  const decided = plan(edition, comment, {
    ...repoSlug(), sha,
    exists: f => existsSync(join(ROOT, f)),
  });
  if (decided.error) { console.error(`refusing to publish: ${decided.error}`); process.exit(2); }
  console.log(`posting: ${decided.labels}`);
  await write(arg('out'), decided);
}

async function cmdDay() {
  const edition = await loadEdition();
  console.log(`edition ${edition.id} (${edition.kind}), built ${edition.builtAt}\n`);
  for (const s of edition.sections) {
    console.log(`── ${s.label} (${s.id}) ──`);
    for (const st of s.stories)
      console.log(`  ${(st.tier || '?').padEnd(12)} ${st.display || st.headline}`
        + `\n  ${''.padEnd(12)} ${st.source} · ${st.corroboration} newsroom(s)`
        + `${st.photo ? ' · photo' : ' · ' + (st.backdrop || 'backdrop')}`
        + `${st.stat ? ` · stat ${st.stat.stat}` : ''}`);
    for (const p of s.posts)
      console.log(`  → ${p.kind.padEnd(8)} ${p.files.length} file(s)`
        + `${p.kind === 'reel' ? ` · ${p.seconds}s` : ''}`
        + `${p.alts ? ' · described' : ' · NO DESCRIPTIONS'}`);
    console.log('');
  }

  const warnings = warningsFor(edition);
  if (warnings.length) {
    console.log('⚠️  what the owner would be warned about:');
    for (const w of warnings) console.log(`  - ${w}`);
    console.log('');
  }

  console.log('what each approval would post:');
  for (const words of ['/approve', '/approve all', '/approve top reel', '/approve all reel']) {
    const d = plan(edition, words, { exists: f => existsSync(join(ROOT, f)) });
    console.log(`  ${words.padEnd(18)} ${d.error ? 'refused — ' + d.error : d.labels}`);
  }
  console.log(`\n${posts(edition).length} post(s) offered. Nothing has been published.`);
}

/* What an approval actually published, written into the permanent record.
   Runs after publish.mjs, from the approval workflow only. */
async function cmdRecord() {
  const edition = await loadEdition();
  const planFile = arg('plan', 'work/plan.json');
  const decided = JSON.parse(await readFile(join(ROOT, planFile), 'utf8'));
  // What publish.mjs got back from Instagram. Missing on a dry run, and a
  // post that failed leaves nothing — the record must not invent an id.
  const receipts = await readJson(join(ROOT, arg('published', 'work/published.json')), []);

  const path = join(ROOT, arg('ledger', 'data/ledger.json'));
  const before = await readJson(path, { posted: [] });
  const after = record(before, {
    edition, plan: decided,
    published: Array.isArray(receipts) ? receipts : [],
    issue: arg('issue', null),
  });
  await writeFile(path, JSON.stringify(after, null, 2) + '\n', 'utf8');
  const added = after.posted.length - (before.posted?.length || 0);
  console.log(`recorded ${added} stor${added === 1 ? 'y' : 'ies'} in ${arg('ledger', 'data/ledger.json')}`);
}

/* Keep the working tree from carrying every edition ever built. The history
   keeps them regardless — an approved post has to stay fetchable from the
   commit it was pinned to — but a fresh checkout has no use for three months
   of slides. */
async function cmdPrune() {
  const keep = Math.max(1, parseInt(arg('keep', String(KEEP_EDITIONS)), 10) || KEEP_EDITIONS);
  const gone = await prune(ROOT, keep);
  console.log(gone.length ? `removed ${gone.length}: ${gone.join(', ')}` : `nothing to remove (keeping ${keep})`);
}

const COMMANDS = { offer: cmdOffer, supersede: cmdSupersede, plan: cmdPlan,
                   record: cmdRecord, prune: cmdPrune, day: cmdDay };

async function main() {
  const name = process.argv[2];
  const cmd = COMMANDS[name];
  if (!cmd) {
    console.error(`usage: dv.mjs <${Object.keys(COMMANDS).join('|')}> [options]`);
    process.exit(1);
  }
  await cmd();
}

main().catch(err => { console.error(`${process.argv[2] || 'dv'} failed: ${err.message}`); process.exit(1); });
