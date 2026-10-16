/* A minimal Chrome DevTools Protocol client.
 *
 * Dependency-free on purpose: the alternative is installing Playwright or
 * Puppeteer on every scheduled run, which costs minutes of CI time and pulls
 * a browser download. Every CI runner already has Chrome.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

async function firstExisting(paths) {
  const { access } = await import('node:fs/promises');
  for (const p of paths) {
    try { await access(p); return p; } catch { /* keep looking */ }
  }
  return null;
}

const wait = ms => new Promise(r => setTimeout(r, ms));

export async function launchChrome({ port = 9222 } = {}) {
  const bin = await firstExisting(CHROME_CANDIDATES);
  if (!bin) throw new Error('no Chrome found — set CHROME_PATH');

  const profile = await mkdtemp(join(tmpdir(), 'dv-chrome-'));
  const child = spawn(bin, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-sandbox',
    '--disable-dev-shm-usage',       // small /dev/shm on CI crashes tabs
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    'about:blank',
  ], { stdio: 'ignore' });

  // Wait for the debugging endpoint rather than guessing at a sleep.
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return { child, port, profile };
    } catch { /* not up yet */ }
    await wait(200);
  }
  child.kill();
  await rm(profile, { recursive: true, force: true });
  throw new Error('Chrome did not start');
}

export async function closeChrome(chrome) {
  if (!chrome) return;
  try { chrome.child.kill(); } catch {}

  // Wait for it to actually exit: Chrome keeps writing to its profile while
  // shutting down, and deleting underneath it fails with ENOTEMPTY — which
  // used to abort a run that had already rendered everything successfully.
  await new Promise(resolve => {
    if (chrome.child.exitCode !== null) return resolve();
    const done = () => resolve();
    chrome.child.once('exit', done);
    setTimeout(() => { try { chrome.child.kill('SIGKILL'); } catch {} done(); }, 5000);
  });

  // Tidy-up is best effort — a temp directory left behind is not a failure.
  for (let i = 0; i < 3; i++) {
    try { await rm(chrome.profile, { recursive: true, force: true }); return; }
    catch { await wait(300); }
  }
}

export async function openPage(port, url) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = list.find(t => t.type === 'page');
  if (!target) throw new Error('no page target');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const errors = [];

  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown')
      errors.push((m.params.exceptionDetails.exception?.description || '').split('\n')[0]);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('could not attach to the page'));
  });

  const send = (method, params = {}) => new Promise(resolve => {
    const i = ++id;
    pending.set(i, resolve);
    ws.send(JSON.stringify({ id: i, method, params }));
  });

  await send('Runtime.enable');
  await send('Page.enable');

  const evaluate = async (expression, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
    if (r.result?.exceptionDetails)
      throw new Error((r.result.exceptionDetails.exception?.description || 'evaluate failed').split('\n')[0]);
    return r.result?.result?.value;
  };

  await send('Page.navigate', { url });

  return { send, evaluate, errors, close: () => ws.close() };
}
