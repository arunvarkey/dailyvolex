#!/usr/bin/env node
/* Tests for the workflows themselves.
 *
 * The scripts inside a workflow only ever run on GitHub, which means they are
 * usually first executed in production — and a throw there fails the job after
 * it has already done all the work. These parse the workflow files, run their
 * embedded scripts against the real data with the GitHub API stubbed, and
 * check the safety conditions that keep publishing gated.
 *
 * Requires a rendered shortlist:
 *   node automation/shortlist.mjs --fixtures && node automation/render.mjs --carousel
 *   node automation/caption.mjs --index 0
 *   node automation/test-workflows.mjs
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const fs = require('node:fs');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let yaml;
try { yaml = require('js-yaml'); }
catch {
  console.log('SKIP  js-yaml is not installed — `npm i -D js-yaml` to run these');
  process.exit(0);
}

let passed = 0, failed = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`PASS  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}${detail ? `  [${detail}]` : ''}`); }
};

const load = f => yaml.load(fs.readFileSync(join(ROOT, '.github/workflows', f), 'utf8'));
const docs = {};
for (const f of ['daily.yml', 'approve.yml', 'token-check.yml', 'watch.yml', 'correct.yml']) {
  try { docs[f] = load(f); ok(`${f} parses`, true); }
  catch (e) { ok(`${f} parses`, false, e.message); }
}
// YAML 1.1 reads a bare `on:` as boolean true, so accept either.
const on = d => d?.on ?? d?.[true];

/* ── Nothing can publish except an approved comment ───────────── */

const a = docs['approve.yml'];
const cond = a?.jobs?.publish?.if || '';
/* The property that matters is not how many triggers there are, it is that
   none of them can fire without a person: no schedule, no push, no dispatch.
   Approving from the app added a second trigger, and a test pinned to the
   exact list would have read as a safety failure when nothing unsafe had
   changed. */
ok('publishing can only be triggered by a person', (() => {
  const triggers = Object.keys(on(a) || {});
  const machine = ['schedule', 'push', 'workflow_dispatch', 'repository_dispatch',
                   'workflow_run', 'pull_request', 'pull_request_target'];
  return triggers.length > 0 && !triggers.some(t => machine.includes(t));
})(), JSON.stringify(Object.keys(on(a) || {})));
ok('publishing requires the repository owner',
  /comment\.user\.login == github\.repository_owner/.test(cond));
ok('publishing requires the word /approve',
  /startsWith\(github\.event\.comment\.body, '\/approve'\)/.test(cond));
ok('publishing requires the approval label', /awaiting-approval/.test(cond));
ok('publishing requires an open issue', /issue\.state == 'open'/.test(cond));

const secretSteps = (a?.jobs?.publish?.steps || [])
  .filter(s => JSON.stringify(s.env || {}).includes('IG_'));
ok('exactly one step is given the Instagram secrets', secretSteps.length === 1, `${secretSteps.length}`);
ok('the daily job is never given the Instagram secrets',
  !JSON.stringify(docs['daily.yml']).includes('IG_'));
/* The watch runs every fifteen minutes. If it could reach the account
   directly, a bad rule would post ninety-six times a day. */
ok('the breaking watch is never given the Instagram secrets',
  !JSON.stringify(docs['watch.yml']).includes('IG_'));
ok('the breaking watch only renders and opens an issue',
  !JSON.stringify(docs['watch.yml']).includes('publish.mjs'));
ok('the breaking watch backs off while an approval is open',
  JSON.stringify(docs['watch.yml']).includes('awaiting-approval')
  && (docs['watch.yml']?.jobs?.watch?.steps || [])
       .some(st => /busy == 'no'/.test(st.if || '')));
ok('the watch and the daily run cannot write data at the same time',
  docs['watch.yml']?.concurrency?.group === docs['daily.yml']?.concurrency?.group,
  `${docs['watch.yml']?.concurrency?.group} vs ${docs['daily.yml']?.concurrency?.group}`);
/* ── Corrections ──────────────────────────────────────────────── */
const corr = docs['correct.yml'];
const corrIf = corr?.jobs?.correct?.if || '';
ok('a correction can only be raised by the repository owner',
  /comment\.user\.login == github\.repository_owner/.test(corrIf));
ok('a correction needs the word /correct',
  /startsWith\(github\.event\.comment\.body, '\/correct'\)/.test(corrIf));
/* The correction workflow renders and opens an issue. It must not be able to
   reach the account directly, or "/correct" becomes a way to post anything. */
ok('raising a correction cannot post to Instagram',
  !JSON.stringify(corr).includes('IG_') && !JSON.stringify(corr).includes('publish.mjs'));
/* The label is what approve.yml gates on, and it is now set by
   lib/offer.mjs rather than written into this file — so what this checks is
   that the correction goes out as an issue built by that module, and that
   test.mjs proves the module always labels it. */
ok('a correction still goes through the approval gate', (() => {
  const steps = Object.values(corr?.jobs || {}).flatMap(j => j.steps || []);
  return steps.some(st => /dv\.mjs offer/.test(st.run || ''))
    && steps.some(st => /issues\.create/.test(st.with?.script || ''));
})(), 'and lib/offer.mjs labels every approval issue — see test.mjs');
ok('the correction text never passes through a shell', (() => {
  const steps = Object.values(corr?.jobs || {}).flatMap(j => j.steps || []);
  const shellSteps = steps.filter(st => typeof st.run === 'string');
  // No step may interpolate the comment body, and the build step reads a file.
  return !shellSteps.some(st => /github\.event\.comment\.body/.test(st.run))
    && shellSteps.some(st => /--text-file/.test(st.run));
})());
ok('a correction shares the data lock with the daily run',
  corr?.concurrency?.group === docs['daily.yml']?.concurrency?.group);

/* ── Publishing the run's output ──────────────────────────────── */
/* The daily run takes about twenty minutes and the watch fires every
   fifteen, so one of them will eventually push from a base that is no longer
   the tip. A rejected push at the last step throws away the whole run. */
ok('every workflow publishes through the retrying push helper', (() => {
  const runs = Object.values(docs)
    .flatMap(d => Object.values(d?.jobs || {}))
    .flatMap(j => j.steps || [])
    .map(st => st.run).filter(r => typeof r === 'string');
  const pushes = runs.filter(r => /git push/.test(r));
  // No workflow may call git push directly any more.
  return pushes.length === 0 && runs.some(r => /push-data\.sh/.test(r));
})(), 'a bare `git push` loses the run when main moved underneath it');

ok('the push helper never force-pushes', (() => {
  const sh = fs.readFileSync(join(ROOT, 'automation/push-data.sh'), 'utf8');
  return !/--force|-f\b|\+HEAD/.test(sh);
})());

/* A soft reset keeps the index — a whole tree from the stale base — so
   committing it deletes whatever landed upstream. A test of that scenario
   caught it wiping another run's file while still showing that run's commit
   as a parent. */
ok('the push helper re-parents without discarding upstream work', (() => {
  const sh = fs.readFileSync(join(ROOT, 'automation/push-data.sh'), 'utf8');
  return /git reset -q --mixed origin\/main/.test(sh) && !/reset[^\n]*--soft/.test(sh);
})(), 'must be --mixed, never --soft');

/* ── File contracts between the scripts and the workflows ─────── */
/* Captions moved from caption-1.txt to caption-<section>.txt when sections
   landed, and the breaking watch kept reading the old name — so it crashed
   on every story it actually found, which is every time it mattered. */
ok('no workflow reads a caption by the old numbered name alone', (() => {
  const scripts = Object.entries(docs).flatMap(([file, d]) =>
    Object.values(d?.jobs || {}).flatMap(j => (j.steps || [])
      .map(st => [file, st.with?.script || st.run || ''])));
  return scripts.every(([file, body]) =>
    !/caption-1\.txt/.test(body) || /caption-\$\{[^}]*section/.test(body));
})(), 'a sectioned post has no caption-1.txt');

/* Sections moved the slides into data/pending/<section>/, which left the
   CI size check globbing a path that no longer matches anything. */
ok('CI looks for graphics where the edition actually writes them', (() => {
  const t = fs.readFileSync(join(ROOT, '.github/workflows/test.yml'), 'utf8');
  return /find data\/editions/.test(t) && !/data\/pending/.test(t);
})());
ok('CI fails when nothing was rendered at all', (() => {
  const t = fs.readFileSync(join(ROOT, '.github/workflows/test.yml'), 'utf8');
  return /no graphics were rendered at all/.test(t);
})(), 'an empty loop used to pass silently');

/* ── Work is never committed ──────────────────────────────────── */
/* Source photographs are an input to the renderer. They are downloaded at up
   to 1600 pixels, baked into a slide within seconds, and never published —
   and they were being written under data/, which is what gets pushed. The
   repository was carrying about 290 MB of throwaway JPEGs after a handful of
   days, which is the free hosting this channel depends on running out. */
ok('work is git-ignored', (() => {
  const gi = fs.readFileSync(join(ROOT, '.gitignore'), 'utf8');
  return /^work\/$/m.test(gi);
})(), 'without this the next run commits every source photograph again');

ok('no source photograph is written where it would be committed', (() => {
  const r = fs.readFileSync(join(ROOT, 'automation/render.mjs'), 'utf8');
  // The download destination and the path recorded on the story must both be
  // under work/, and neither may name data/pending.
  // Holding a candidate while a bigger one is looked for added a second
  // write, so this checks every destination, not just the download's.
  return /const dest = join\(WORK_PHOTOS/.test(r)
    && /downloadImage\(url, dest\)/.test(r)
    && /path: `work\/photos\//.test(r)
    && !/renameSync\([^)]*data\//.test(r)
    && !/photo-\$\{index\}[^\n]*data\/pending/.test(r);
})());

ok('the 1600-pixel rendition is downloaded, not the master', (() => {
  const r = fs.readFileSync(join(ROOT, 'automation/render.mjs'), 'utf8');
  return /\[cand\.smallerUrl, cand\.url\]/.test(r);
})(), 'an 18 MB JPEG for 1080 pixels of card');

ok('the architecture is written down', (() => {
  const a = fs.readFileSync(join(ROOT, 'docs/ARCHITECTURE.md'), 'utf8');
  // The invariants are the reason the channel is worth running; a doc that
  // has lost them is not the contract any more.
  // Whitespace-tolerant: a doc is wrapped prose and a phrase can straddle a
  // line break, which is how this test first failed on a doc that said it.
  const flat = a.replace(/\s+/g, ' ');
  return /Nothing posts without the owner/.test(flat)
    && /only ever removes/.test(flat)
    && /Corrections are posted, never deleted/.test(flat);
})());

/* ── A day with no news is not a failure ─────────────────────────
   The editorial rules refuse most of what the feeds carry, and on a thin day
   they can refuse all of it. That used to write an edition with no sections,
   exit 0, and leave the render to die on it one second later — so the run
   looked like a crash and opened a failure issue, which is the opposite of
   what happened. */
ok('an empty day stops the run without failing it', (() => {
  const steps = docs['daily.yml']?.jobs?.build?.steps || [];
  const pick = steps.find(st => /shortlist\.mjs/.test(st.run || ''));
  const gated = steps.filter(st => /steps\.pick\.outputs\.empty != 'yes'/.test(st.if || ''));
  // Everything between picking the stories and opening the issue.
  return pick?.id === 'pick' && gated.length >= 6;
})());
ok('the reporter still runs on an empty day', (() => {
  const step = (docs['daily.yml']?.jobs?.build?.steps || [])
    .find(st => st.uses === './.github/actions/report-run');
  return /always\(\)/.test(step?.if || '');
})(), 'it closes the issue from the day it really did break');

/* ── Editions, not a shared folder ────────────────────────────── */
/* Every run used to rewrite data/pending. The watch fires every fifteen
   minutes, so an approval from an hour ago pointed at files that had since
   been replaced, and the only thing between that and the account was a
   commit hash parsed out of an issue body. */
ok('nothing writes to the old shared folder any more', (() => {
  const all = Object.values(docs).map(d => JSON.stringify(d)).join(' ');
  return !/data\/pending/.test(all);
})());

ok('an approval pins the edition as well as the commit', (() => {
  const steps = docs['approve.yml']?.jobs?.publish?.steps || [];
  const pin = steps.find(st => /data\\\\\.githubusercontent|raw\\\\\./.test(st.with?.script || '')
    || /setOutput\('edition'/.test(st.with?.script || ''));
  const plan = steps.find(st => /dv\.mjs plan/.test(st.run || ''));
  return /setOutput\('edition'/.test(pin?.with?.script || '')
    && /--edition/.test(plan?.run || '');
})(), 'approving an hour-old issue must not publish whatever is newest');

ok('the working tree is kept to the last few editions', (() => {
  const steps = docs['daily.yml']?.jobs?.build?.steps || [];
  return steps.some(st => /dv\.mjs prune/.test(st.run || ''));
})(), 'the history keeps them; a fresh checkout has no use for them');

ok('the ledger is what gets committed, not the receipts', (() => {
  const all = Object.values(docs).map(d => JSON.stringify(d)).join(' ');
  return /data\/ledger\.json/.test(all) && !/data\/posted\.json/.test(all);
})());

/* ── Failure notification ─────────────────────────────────────── */
/* The 09:03 run died at its last step and nothing said so. Unattended
   automation that fails quietly is not automation. */
const REPORTED = ['daily.yml', 'watch.yml', 'correct.yml'];
ok('every unattended workflow reports how its run went', REPORTED.every(f => {
  const steps = Object.values(docs[f]?.jobs || {}).flatMap(j => j.steps || []);
  return steps.some(st => st.uses === './.github/actions/report-run');
}), REPORTED.filter(f => !JSON.stringify(docs[f]).includes('report-run')).join(','));

ok('the report runs even when the job failed', REPORTED.every(f => {
  const step = Object.values(docs[f]?.jobs || {}).flatMap(j => j.steps || [])
    .find(st => st.uses === './.github/actions/report-run');
  return /always\(\)/.test(step?.if || '');
}), 'if: failure() alone would never close a recovered issue');

ok('reporting can name the step that failed', REPORTED.every(f =>
  (docs[f]?.permissions || {})['actions'] === 'read'),
  'an explicit permissions block denies everything it does not list');

const reporter = fs.readFileSync(join(ROOT, '.github/actions/report-run/action.yml'), 'utf8');

/* GitHub templates an action manifest's descriptions as well as its steps,
   and a manifest has no `job` context. Writing the caller's usage into a
   description as an example broke the action at load time — and because the
   reporter runs on always(), it marked a wholly successful run as failed. */
ok('an action manifest has no expressions in its descriptions', (() => {
  const doc = yaml.load(reporter);
  const descs = [doc.description, ...Object.values(doc.inputs || {}).map(i => i.description)];
  return descs.filter(Boolean).every(d => !/\$\{\{/.test(d));
})(), 'the manifest fails to load, whatever the expression is');

ok('the reporter cannot fail the run it reports on', REPORTED.every(f => {
  const step = Object.values(docs[f]?.jobs || {}).flatMap(j => j.steps || [])
    .find(st => st.uses === './.github/actions/report-run');
  return step?.['continue-on-error'] === true;
}), 'a typo in it marked a successful run as failed');
/* The watch fires ninety-six times a day. If the feeds go down, ninety-six
   issues — or ninety-six comments on one issue — is not a notification. */
ok('a workflow failing all day leaves one issue, not a hundred',
  /issues\.update/.test(reporter) && /existing/.test(reporter));
ok('recovery closes the issue it opened',
  /state: 'closed'/.test(reporter) && /Recovered/.test(reporter),
  'being told it broke is only half of what is needed to trust it');
ok('one issue per workflow, not one per repository',
  /i\.title === title/.test(reporter) && /context\.workflow/.test(reporter));

ok('the token check cannot push code',
  docs['token-check.yml']?.permissions?.contents === undefined,
  JSON.stringify(docs['token-check.yml']?.permissions));

const actions = [];
for (const doc of Object.values(docs))
  for (const job of Object.values(doc?.jobs || {}))
    for (const step of job.steps || []) if (step.uses) actions.push(step.uses);
/* A third-party action has to name a version or it drifts under us. A local
   one (./.github/actions/...) lives in this repo at this commit, so it is
   already pinned by definition. */
const thirdParty = actions.filter(u => !u.startsWith('./'));
ok('every third-party action is version-pinned',
  thirdParty.length > 0 && thirdParty.every(u => /@v\d+$/.test(u)),
  thirdParty.join(' '));
ok('local actions are referenced by path, not by a version that cannot exist',
  actions.filter(u => u.startsWith('./')).every(u => !u.includes('@')));

/* ── The embedded scripts actually run ────────────────────────── */

function runScript(doc, stepName, { github, context, env = {} }) {
  const step = Object.values(doc.jobs)
    .flatMap(j => j.steps || [])
    .find(s => s.name === stepName);
  if (!step?.with?.script) throw new Error(`no script step named "${stepName}"`);
  Object.assign(process.env, env);
  const fn = new Function('github', 'context', 'core', 'require', 'process',
    `return (async () => { ${step.with.script} })()`);
  return fn(github, context, { info() {}, warning() {} }, require, process);
}

const context = { repo: { owner: 'arunvarkey', repo: 'dailyvolex' }, issue: { number: 7 },
                  serverUrl: 'https://github.com', runId: 1 };


/* ── No workflow decides anything ─────────────────────────────────
   The decisions — how the approval issue reads, what `/approve top reel`
   posts — are modules now, with tests of their own in test.mjs, run against
   the functions themselves rather than against JavaScript pulled out of a
   YAML string. A workflow may contain checkout, node, one command and a
   push. These tests exist so that logic cannot creep back into YAML, where
   it can only ever be first executed in production. */

const allSteps = Object.entries(docs).flatMap(([file, d]) =>
  Object.values(d?.jobs || {}).flatMap(j => (j.steps || []).map(st => [file, st])));
const scriptBodies = allSteps.map(([file, st]) => [file, st.with?.script || '']);

ok('no workflow works out what /approve means',
  scriptBodies.every(([, b]) => !/\/approve/i.test(b) && !/setOutput\('plan'/.test(b)),
  scriptBodies.filter(([, b]) => /\/approve/i.test(b)).map(([f]) => f).join(','));

ok('no workflow builds the approval issue body',
  scriptBodies.every(([, b]) => !/raw\.githubusercontent/.test(b)),
  scriptBodies.filter(([, b]) => /raw\.githubusercontent/.test(b)).map(([f]) => f).join(','));

ok('the approval issue comes from a module', (() => {
  const steps = docs['daily.yml']?.jobs?.build?.steps || [];
  return steps.some(st => /dv\.mjs offer/.test(st.run || ''))
    && steps.some(st => /issue\.json/.test(st.with?.script || ''));
})());

/* Withdrawing a stale offer is a decision — which ones, and what to say —
   so it belongs in a module like every other one. The workflow may read the
   list and carry the answer out. */
ok('no workflow decides which offers are stale', (() => {
  // Not a ban on the word "edition" — approve.yml has to read one out of the
  // issue to pin the commit. The rule is that the step which closes an issue
  // does not work out WHICH, and does not write what gets said on it: both
  // come out of the file the module wrote.
  const steps = docs['daily.yml']?.jobs?.build?.steps || [];
  const closer = steps.find(st => /supersede\.json/.test(st.with?.script || ''));
  const body = closer?.with?.script || '';
  return /body:\s*old\.comment/.test(body)
    && !/kindOfEdition|data\/editions/.test(body);
})(), 'the withdrawal goes on somebody’s issue — a workflow must not compose it');

ok('a new offer withdraws the older ones', (() => {
  const steps = docs['daily.yml']?.jobs?.build?.steps || [];
  return steps.some(st => /dv\.mjs supersede/.test(st.run || ''))
    && steps.some(st => /supersede\.json/.test(st.with?.script || ''))
    && steps.some(st => /listForRepo/.test(st.with?.script || ''));
})(), 'three runs in one evening left three live invitations to post');

ok('tidying up yesterday cannot fail today', (() => {
  const steps = docs['daily.yml']?.jobs?.build?.steps || [];
  const closer = steps.find(st => /supersede\.json/.test(st.with?.script || ''));
  return closer?.['continue-on-error'] === true;
})(), 'today’s offer is open and correct whatever happens to the old ones');

ok('the open offers are read before the new one joins them', (() => {
  const steps = docs['daily.yml']?.jobs?.build?.steps || [];
  const ask = steps.find(st => /issue\.json/.test(st.with?.script || ''));
  const body = ask?.with?.script || '';
  return body.indexOf('listForRepo') > 0
    && body.indexOf('listForRepo') < body.indexOf('issues.create');
})(), 'listing afterwards finds the new issue and closes it immediately');

/* A section used to be one post, so an approval was the whole issue. With a
   post per story, closing it on a partial approval made the rest
   unreachable: a comment can only approve an issue that is still open. */
ok('an issue that still offers something stays open', (() => {
  const steps = docs['approve.yml']?.jobs?.publish?.steps || [];
  const say = steps.find(st => /issues\.update/.test(st.with?.script || ''));
  const body = say?.with?.script || '';
  return /remaining/.test(body) && /work\/plan\.json/.test(body);
})(), 'approving one story must not withdraw the other six');

ok('what is left to approve is decided by the planner', (() => {
  const steps = docs['approve.yml']?.jobs?.publish?.steps || [];
  // The workflow may read `remaining`; it may not work out what it is.
  return steps.every(st => !/carousels|allPosts|kind === /.test(st.with?.script || ''));
})());

ok('publishing is driven by the plan the module wrote', (() => {
  const steps = docs['approve.yml']?.jobs?.publish?.steps || [];
  return steps.some(st => /dv\.mjs plan/.test(st.run || ''))
    && steps.some(st => /publish\.mjs --plan work\/plan\.json/.test(st.run || ''));
})());

ok('the approval words never pass through a shell', (() => {
  const steps = docs['approve.yml']?.jobs?.publish?.steps || [];
  // github-script writes them to a file; the planner reads that file. True
  // of an issue title as well as a comment body now.
  return !steps.some(st => /github\.event\.(comment\.body|issue\.title)/.test(st.run || ''))
    && steps.some(st => /--comment-file/.test(st.run || ''));
})());

/* ── Approving from the app ───────────────────────────────────────
   A page served from GitHub Pages holds no credential and must not pretend
   to. It hands GitHub a prefilled issue and the owner taps Submit; the gate
   is the same one, and authorship is what enforces it. */
ok('an issue the owner opens can approve', (() => {
  const on = Object.keys(a?.on ?? a?.[true] ?? {});
  return on.includes('issues') && on.includes('issue_comment');
})());
ok('only the owner can approve, by either route', (() => {
  const c = a?.jobs?.publish?.if || '';
  return /github\.event\.comment\.user\.login == github\.repository_owner/.test(c)
    && /github\.event\.issue\.user\.login == github\.repository_owner/.test(c);
})(), 'authorship IS the gate when there is no approval issue to label');
ok('a comment still needs an open, labelled approval issue', (() => {
  const c = a?.jobs?.publish?.if || '';
  return /awaiting-approval/.test(c) && /issue\.state == 'open'/.test(c);
})());
ok('an approval from the app still pins the commit it was offered at', (() => {
  const steps = a?.jobs?.publish?.steps || [];
  return steps.some(st => /git log -1 --format=%H -- "data\/editions/.test(st.run || ''))
    && (steps[0]?.with || {})['fetch-depth'] === 0;
})(), 'a re-run can rebuild the same edition id with different stories');
ok('the app sends the edition, and a hand-written approval without one is refused', (() => {
  const pin = (a?.jobs?.publish?.steps || []).find(st => /setOutput\('edition'/.test(st.with?.script || ''));
  return /names no edition/.test(pin?.with?.script || '');
})());
/* ── A card with no photograph behind it ─────────────────────────
   The headline block is anchored to the bottom because in 9:16 the foot of a
   Reel is covered by Instagram's own caption and audio row. That is right
   over a photograph, which fills everything above it, and wrong over a
   gradient: the first reel came out as a headline in the bottom third of a
   frame that was otherwise empty.

   A source check, not a pixel one — it proves the branch exists and that a
   photo card still takes the original numbers. What it looks like was
   checked by rendering it at both ratios and looking. */
/* The type scale used to be six numbers spread through the drawing code,
   each changed on its own when a card looked wrong, and they had drifted into
   five lines of 108px caps filling a 4:5 frame edge to edge. It is one table
   now, so these read it out and check the claims rather than the spelling of
   the code that used to hold them. */
function headlineScale() {
  const html = fs.readFileSync(join(ROOT, 'index.html'), 'utf8');
  const m = html.match(/const HEADLINE = \{[\s\S]*?\n\};/);
  if (!m) return null;
  try { return new Function(`${m[0]} return HEADLINE;`)(); } catch { return null; }
}
const SCALE = headlineScale();

ok('the type scale is in one table, not scattered through the drawing',
  SCALE && SCALE.bare && SCALE.photo && SCALE.gutter,
  'six numbers in six places is how it drifted into a wall of type');

ok('a card with no photograph sets its headline larger and higher', (() => {
  const html = fs.readFileSync(join(ROOT, 'index.html'), 'utf8');
  const bare = /const bare\s*=\s*!S\.bgImage\s*&&\s*!S\.videoLoaded/.test(html);
  const lift = /const lift\s*=\s*bare/.test(html);
  if (!bare || !lift || !SCALE) return false;
  // Larger and allowed more lines than the same card with a picture on it.
  return ['4:5', '9:16'].every(r =>
    SCALE.bare[r].size > SCALE.photo[r].size && SCALE.bare[r].max >= SCALE.photo[r].max);
})());

ok('a headline does not fill the frame edge to edge', (() => {
  if (!SCALE) return false;
  // 4 lines of 96px at 1.03 is 395px of a 1350px card — a third of it, which
  // leaves the picture, the kicker and the attribution somewhere to be.
  const h = SCALE.bare['4:5'];
  return h.size * h.leading * h.max < 1350 * 0.45;
})(), 'five lines of 108px read as shouting, not as a newsroom');

ok('the leading is tight enough to read as one block', (() => SCALE
  && [SCALE.bare['4:5'], SCALE.bare['9:16'], SCALE.photo['4:5'], SCALE.photo['9:16']]
     .every(h => h.leading <= 1.06))(),
  'loose leading turns a stack of large type into several separate lines');

ok('a headline is never dropped, only shrunk then visibly cut', (() => {
  const html = fs.readFileSync(join(ROOT, 'index.html'), 'utf8');
  return /while\(hlLines\.length>MAXL&&hlSz>MINSZ\)/.test(html) && /\+'…'/.test(html);
})());

ok('the backdrop’s rule sits on the headline’s own gutter', (() => {
  const html = fs.readFileSync(join(ROOT, 'index.html'), 'utf8');
  return /const mx = HEADLINE\.gutter\[S\.ratio\]/.test(html);
})(), 'two bars on a margin of their own read as a rendering fault');

ok('case is applied when the card is drawn, not on the way in', (() => {
  const html = fs.readFileSync(join(ROOT, 'index.html'), 'utf8');
  return /set\('headline', v => S\.breaking\.headline = v\.slice\(0,160\)\);/.test(html)
    && /d\.headline\.toUpperCase\(\)/.test(html);
})(), '"NDTV" does not survive being uppercased and then lowercased again');

ok('a headline is set in sentence case, as a newspaper sets one', (() => {
  const html = fs.readFileSync(join(ROOT, 'index.html'), 'utf8');
  // The default, and the switch back, both have to be there: caps at the size
  // a headline is set reads as shouting, but the old way must stay renderable.
  return /textCase: 'sentence'/.test(html)
    && /v === 'upper' \? 'upper' : 'sentence'/.test(html);
})());

ok('the outlet’s own capitalisation reaches the card', (() => {
  const html = fs.readFileSync(join(ROOT, 'index.html'), 'utf8');
  // Nothing may uppercase or lowercase a headline on its way through the app.
  return !/breaking\.headline = [^\n]*\.toUpperCase\(\)/.test(html)
    && !/breaking\.headline = [^\n]*\.toLowerCase\(\)/.test(html);
})(), 'sentence case is only honest if "BJP" and "NDTV" survive it');
ok('a card WITH a photograph keeps the numbers it had', (() => {
  const html = fs.readFileSync(join(ROOT, 'index.html'), 'utf8');
  // The photo branch of each ternary has to be the original value, or this
  // "fix" quietly restyled every card in every carousel.
  return /\?\s*\(S\.ratio==='9:16'\s*\?\s*0\.26\s*:\s*0\.16\)\s*:\s*\(S\.ratio==='9:16'\s*\?\s*0\.20\s*:\s*0\.12\)/.test(
           html.replace(/\s+/g, ' ').replace(/ \?/g, '?').replace(/\? /g, '?'))
    || /0\.20 : 0\.12/.test(html);
})(), 'the photo card was correct and must not move');

/* The closing card. Its rows share the band evenly and stop at 80% of the
   height, where Instagram's caption and audio row begin — that part was
   right and is not a gap to close. What was wrong is that its body text was
   sized for a 4:5 card and read as a smaller, weaker frame beside story
   cards carrying a 132px headline. */
ok('the closing card sizes its text per ratio', (() => {
  const html = fs.readFileSync(join(ROOT, 'index.html'), 'utf8');
  return /const bodyCap=S\.ratio==='9:16' \? 54 : 38/.test(html)
    && /Math\.min\(bodyCap,/.test(html);
})());
ok('the band still stops clear of Instagram’s caption UI', (() => {
  const html = fs.readFileSync(join(ROOT, 'index.html'), 'utf8');
  // 0.20 of the height reserved at the foot of a 9:16 frame. Measured on a
  // rendered card: content ends at 75%, the reserved band starts at 80%.
  return /'9:16':\s*\{\s*top:0\.10,\s*bottom:0\.20/.test(html)
    && /bottom:\s*Math\.min\(H\*\(1-z\.bottom\)/.test(html);
})(), 'filling that space would put text under the caption');

/* The photo credit. Caught on a live run: it was drawn right after the
   background, and the Breaking layout then painted a scrim over the bottom
   half ending at 96% black, so the credit rendered at about 3% white. The
   pictures are the outlets' own and the credit is what names them, so an
   unreadable one is no attribution at all. */
/* The strip along the foot of every card used to say "DAILYVOLEX ··· TODAY'S
   NEWS", which tells you what you are already looking at. It is the only
   furniture on every card, and most posts are a single card with no other
   invitation to follow anywhere on the image. */
ok('every card carries the invitation to follow', (() => {
  const r = fs.readFileSync(join(ROOT, 'automation/render.mjs'), 'utf8');
  const reel = fs.readFileSync(join(ROOT, 'automation/reel.mjs'), 'utf8');
  const wants = /FOLLOW @DAILYVOLEX/;
  return wants.test(r) && wants.test(reel)
    && !/TODAY’S NEWS/.test(r) && !/TODAY’S NEWS/.test(reel);
})(), 'the one place on the image that is always free was saying nothing');

ok('the photo credit is drawn over the layout, not under its scrim', (() => {
  const html = fs.readFileSync(join(ROOT, 'index.html'), 'utf8');
  const scene = html.slice(html.indexOf('function drawScene('));
  const body = scene.slice(0, scene.indexOf('\n}'));
  const credit = body.indexOf('drawPhotoCredit(theme)');
  const layout = body.indexOf("case 'breaking':");
  return credit > 0 && layout > 0 && credit > layout;
})(), 'a credit nobody can read is not a credit');

ok('the app offers an approve link rather than a credential', (() => {
  const html = fs.readFileSync(join(ROOT, 'index.html'), 'utf8');
  return /issues\/new/.test(html) && /encodeURIComponent\('\/approve /.test(html)
    && !/IG_ACCESS_TOKEN/.test(html);
})(), 'a static page cannot hold a secret and must not look as though it does');

ok('every third-party action used by the reel is pinned too', (() => {
  const steps = docs['daily.yml']?.jobs?.build?.steps || [];
  return steps.filter(st => st.uses && !st.uses.startsWith('./'))
    .every(st => /@v\d+$/.test(st.uses));
})());
ok('the voice model is cached rather than fetched every run', (() => {
  const steps = docs['daily.yml']?.jobs?.build?.steps || [];
  return steps.some(st => /actions\/cache@/.test(st.uses || '') && /piper/.test(JSON.stringify(st.with || {})));
})(), 'it is 63 MB and it does not change');
ok('a reel still speaks when the neural voice cannot be fetched', (() => {
  const step = (docs['daily.yml']?.jobs?.build?.steps || [])
    .find(st => /reel\.mjs/.test(st.run || ''));
  // piper when the model arrived, espeak-ng when it did not.
  return /--voice piper/.test(step?.run || '') && /--voice espeak/.test(step?.run || '');
})());
ok('a reel is built where it cannot cost the run', (() => {
  const step = (docs['daily.yml']?.jobs?.build?.steps || [])
    .find(st => /reel\.mjs/.test(st.run || ''));
  // A day with no reel is a day with a carousel, which is the post that
  // matters, so an ffmpeg problem must not fail the run.
  return step?.['continue-on-error'] === true;
})());

ok('publishing has time for Meta to transcode a reel',
  (docs['approve.yml']?.jobs?.publish?.['timeout-minutes'] || 0) >= 20,
  `${docs['approve.yml']?.jobs?.publish?.['timeout-minutes']} minutes`);

ok('the whole day can be run without GitHub or Instagram', (() => {
  const pkg = JSON.parse(fs.readFileSync(join(ROOT, 'package.json'), 'utf8'));
  return /dv\.mjs day/.test(pkg.scripts?.day || '');
})(), 'npm run day is the thing that never existed');

// The token reminder — must stay silent when there is nothing wrong.
for (const [state, shouldOpen] of [['ok', false], ['skipped', false], ['unknown', false],
                                   ['expiring', true], ['invalid', true]]) {
  let opened = false, closed = false;
  try {
    await runScript(docs['token-check.yml'], 'Open or update the reminder', {
      github: { rest: { issues: {
        listForRepo: async () => ({ data: [] }),
        create: async () => { opened = true; return { data: { number: 2 } }; },
        update: async () => { closed = true; },
        createComment: async () => {},
      } } },
      context, env: { STATE: state, MESSAGE: 'test message' },
    });
    ok(`token state "${state}" ${shouldOpen ? 'opens' : 'does not open'} an issue`,
      opened === shouldOpen, `opened=${opened}`);
  } catch (e) {
    ok(`token state "${state}" handled`, false, e.message);
  }
  void closed;
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
