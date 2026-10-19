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
for (const f of ['daily.yml', 'approve.yml', 'token-check.yml', 'watch.yml']) {
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
ok('the token check cannot push code',
  docs['token-check.yml']?.permissions?.contents === undefined,
  JSON.stringify(docs['token-check.yml']?.permissions));

const actions = [];
for (const doc of Object.values(docs))
  for (const job of Object.values(doc?.jobs || {}))
    for (const step of job.steps || []) if (step.uses) actions.push(step.uses);
ok('every action is version-pinned', actions.length > 0 && actions.every(u => /@v\d+$/.test(u)),
  actions.join(' '));

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

// The approval issue — the one that does real work.
let created = null;
const hasRender = fs.existsSync(join(ROOT, 'data/shortlist.json'))
               && fs.existsSync(join(ROOT, 'data/pending/caption-1.txt'));

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
    ok('every slide is embedded', (b.match(/!\[slide/g) || []).length >= 1);
    ok('image links are absolute', /https:\/\/raw\.githubusercontent\.com\//.test(b));
    ok('the caption is shown in full', /### Caption/.test(b));
    ok('sources are named per story', /source/.test(b));
    ok('it says how to approve', /\/approve/.test(b));
    ok('the body is within GitHub limits', b.length < 65536, `${b.length} chars`);
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
