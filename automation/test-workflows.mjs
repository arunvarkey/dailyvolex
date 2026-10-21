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
  return /downloadImage\(url, join\(WORK_PHOTOS/.test(r)
    && /path: `work\/photos\//.test(r)
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
ok('a card with no photograph sets its headline larger and higher', (() => {
  const html = fs.readFileSync(join(ROOT, 'index.html'), 'utf8');
  const bare = /const bare\s*=\s*!S\.bgImage\s*&&\s*!S\.videoLoaded/.test(html);
  const lift = /const lift\s*=\s*bare/.test(html);
  const size = /let hlSz=bare\?/.test(html) && /const MAXL=bare\?/.test(html);
  return bare && lift && size;
})());
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

ok('the app offers an approve link rather than a credential', (() => {
  const html = fs.readFileSync(join(ROOT, 'index.html'), 'utf8');
  return /issues\/new/.test(html) && /encodeURIComponent\('\/approve /.test(html)
    && !/IG_ACCESS_TOKEN/.test(html);
})(), 'a static page cannot hold a secret and must not look as though it does');

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
