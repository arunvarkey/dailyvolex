/* Small JSON files committed back to the repo: no database, nothing to pay
   for, and the whole history is readable in the repo. */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const KEEP = 400;        // plenty to catch repeats, small enough to stay quick

export async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    // A corrupt file must not wedge every future run.
    console.warn(`[store] ${path} unreadable (${err.message}) — starting fresh`);
    return fallback;
  }
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

export async function loadHistory(path) {
  const h = await readJson(path, { posted: [] });
  return Array.isArray(h.posted) ? h.posted : [];
}

export async function recordPosted(path, entries) {
  const posted = await loadHistory(path);
  const merged = [...entries, ...posted].slice(0, KEEP);
  await writeJson(path, { posted: merged, updated: new Date().toISOString() });
  return merged;
}
