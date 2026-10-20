#!/usr/bin/env bash
# Commit generated data and push, surviving a main that moved underneath us.
#
# The daily run takes around twenty minutes now that it renders a post per
# section, and the breaking watch fires every fifteen. Both finish by pushing
# to main, so sooner or later one of them is pushing from a base that is no
# longer the tip — and a rejected push at the last step throws away the whole
# run's work. That happened on the first sectioned run with ownership in it.
#
# Rebasing would mean merging binary PNGs. Instead the staged tree is simply
# re-parented onto the new tip: these files are this run's own product, not
# something another commit could have meaningfully edited, so ours winning
# wholesale is the right answer and there is nothing to conflict.
#
#   automation/push-data.sh "Shortlist for 2026-10-20" [path ...]

set -uo pipefail

MSG="${1:?a commit message is required}"
shift
PATHS=("$@")
[ ${#PATHS[@]} -eq 0 ] && PATHS=("data/")

git config user.name  "dailyvolex-bot"
git config user.email "noreply@github.com"

stage_and_commit() {
  git add -- "${PATHS[@]}"
  if git diff --cached --quiet; then
    return 1          # nothing to say
  fi
  git commit -q -m "$MSG"
  return 0
}

if ! stage_and_commit; then
  echo "nothing changed — not pushing"
  exit 0
fi

for attempt in 1 2 3 4 5; do
  if git push -q origin HEAD:main; then
    echo "pushed on attempt $attempt"
    exit 0
  fi
  echo "push rejected (attempt $attempt) — re-parenting onto the current main"
  if ! git fetch -q origin main; then
    echo "could not fetch origin/main" >&2
    sleep $((attempt * 3))
    continue
  fi
  # --mixed, NOT --soft. A soft reset keeps the index, and the index is a
  # whole tree taken from the stale base — so committing it deletes anything
  # that landed upstream meanwhile. A test of exactly this scenario caught it
  # wiping another run's file while the history still showed that run's commit
  # as a parent, which is the worst shape a bug like this can take.
  #
  # --mixed puts the index back to the new tip and leaves the working tree
  # alone, so re-staging only our own paths adds our output to the current
  # main instead of replacing it.
  git reset -q --mixed origin/main
  if ! stage_and_commit; then
    echo "another run already published the same data — nothing left to push"
    exit 0
  fi
  sleep $((attempt * 3))
done

echo "could not push after 5 attempts — the run's output was not published" >&2
exit 1
