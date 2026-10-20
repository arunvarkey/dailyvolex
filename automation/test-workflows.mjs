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
ok('publishing triggers only on an issue comment',
  JSON.stringify(Object.keys(on(a) || {})) === '["issue_comment"]');
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
ok('a correction still goes through the approval gate',
  JSON.stringify(corr).includes('awaiting-approval'));
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
ok('CI looks for graphics where sections actually write them', (() => {
  const t = fs.readFileSync(join(ROOT, '.github/workflows/test.yml'), 'utf8');
  return /find data\/pending/.test(t) && !/for f in data\/pending\/slide-\*\.png/.test(t);
})());
ok('CI fails when nothing was rendered at all', (() => {
  const t = fs.readFileSync(join(ROOT, '.github/workflows/test.yml'), 'utf8');
  return /no graphics were rendered at all/.test(t);
})(), 'an empty loop used to pass silently');

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


/* Drives approve.yml's planning step and captures what it decided. */
let planOut = null, planFailed = null;
async function runPlan(comment) {
  planOut = null; planFailed = null;
  const core = {
    info() {}, warning() {}, notice() {},
    setFailed(m) { planFailed = m; },
    setOutput(k, v) { if (k === 'plan') planOut = JSON.parse(v); },
  };
  const step = Object.values(docs['approve.yml'].jobs)
    .flatMap(j => j.steps || [])
    .find(s => s.name === 'Work out which sections were approved');
  if (!step?.with?.script) throw new Error('no planning step in approve.yml');
  process.env.SHA = 'testsha';
  const fn = new Function('github', 'context', 'core', 'require', 'process',
    `return (async () => { ${step.with.script} })()`);
  try {
    await fn({}, { ...context, payload: { comment: { body: comment } } }, core, require, process);
  } catch (e) { planFailed = e.message; }
  return planFailed ? null : planOut;
}

// The approval issue — the one that does real work.
let created = null;
const hasRender = fs.existsSync(join(ROOT, 'data/shortlist.json'))
               && (fs.existsSync(join(ROOT, 'data/pending/caption-1.txt'))
                || fs.existsSync(join(ROOT, 'data/pending/caption-top.txt')));

if (!hasRender) {
  console.log('SKIP  no rendered shortlist — run shortlist/render/caption first');
} else {
  const cwd = process.cwd();
  process.chdir(ROOT);
  try {
    await runScript(docs['daily.yml'], 'Ask for approval', {
      github: { rest: { issues: { create: async x => { created = x; return { data: { number: 1 } }; } } } },
      context, env: { GITHUB_SHA: 'testsha' },
    });
    ok('the approval script runs without throwing', true);
  } catch (e) {
    ok('the approval script runs without throwing', false, e.message);
  } finally { process.chdir(cwd); }

  if (created) {
    const b = created.body;
    ok('the issue is labelled for approval', created.labels?.includes('awaiting-approval'));
    // Every slide of every section has to be visible in the issue: the owner
    // is approving what they can see, and a slide that is not shown is a
    // slide nobody checked.
    const sl = JSON.parse(fs.readFileSync(join(ROOT, 'data/shortlist.json'), 'utf8'));
    const out = sl.output || sl.stories || [];
    const totalSlides = out.reduce(
      (n, e) => n + (e.images || [e.image]).filter(Boolean).length, 0);
    ok('every slide of every section is embedded',
      (b.match(/!\[[^\]]*slide [0-9]+\]/g) || []).length === totalSlides,
      `${(b.match(/!\[[^\]]*slide [0-9]+\]/g) || []).length} of ${totalSlides}`);
    ok('image links are absolute', /https:\/\/raw\.githubusercontent\.com\//.test(b));
    ok('every section shows its caption',
      (b.match(/\*\*Caption\*\*/g) || []).length === out.length,
      `${(b.match(/\*\*Caption\*\*/g) || []).length} of ${out.length}`);
    ok('corroboration is stated per story in newsrooms, not bylines',
      /independent newsroom/.test(b));
    ok('each section says the words that post it',
      out.every(e => b.includes(`/approve ${e.section || 'post'}`)),
      out.map(e => e.section).join(','));
    ok('it says a bare approval posts only the top section',
      /bare `\/approve` posts Top stories only/i.test(b));
    ok('the body is within GitHub limits', b.length < 65536, `${b.length} chars`);

    /* ── What /approve actually publishes ───────────────────────
       This step decides which posts go to the account. A bug here does not
       fail loudly; it posts the wrong thing under the channel's name. */
    ok('naming sections posts exactly those', await (async () => {
      // Whichever sections this fixture day actually produced — which
      // sections survive now depends on the importance hierarchy, so naming
      // one by hand makes the test a hostage to the fixtures.
      const names = out.map(e => e.section).filter(Boolean).slice(0, 2);
      if (names.length < 2) return true;
      const r = await runPlan(`/approve ${names.join(' ')}`);
      return r && r.map(p => p.section).join(',') === names.join(',');
    })());
    ok('a bare approval posts only the top section', await (async () => {
      const r = await runPlan('/approve');
      return r && r.length === 1 && r[0].section === 'top';
    })());
    ok('/approve all posts every section', await (async () => {
      const r = await runPlan('/approve all');
      return r && r.length === out.length;
    })());
    ok('an unknown section name is refused, not guessed', await (async () => {
      const r = await runPlan('/approve sport');
      return r === null;
    })(), 'must fail rather than post something else');
    ok('each planned post carries its own caption file', await (async () => {
      const r = await runPlan('/approve all');
      return r && r.every(p => p.caption.includes(p.section))
        && new Set(r.map(p => p.caption)).size === r.length;
    })());
    ok('planned image urls are pinned to the approved commit', await (async () => {
      const r = await runPlan('/approve top');
      return r && r[0].urls.split(',').every(u => u.includes('/testsha/'));
    })());
  }
}

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
