#!/usr/bin/env bash
#
# The acceptance checklist. One command, same locally and in CI.
#
#   ./check.sh                build, artifact guarantees, model, browser
#
# Every phase must be able to fail. A phase that skips when its tool is missing
# is a phase that silently stops checking, so missing tools are failures here.
set -uo pipefail
cd "$(dirname "$0")"

FAILED=0
fail() { echo "FAIL: $1" >&2; FAILED=1; }
report() { echo; echo "== $1 =="; }

NODE=${NODE:-$(command -v node || true)}
if [[ -z $NODE ]]; then
  fail "node not found; run inside the pinned shell: nix develop --command ./check.sh"
fi

# ---- build ------------------------------------------------------------------
report "build"
if [[ -n $NODE ]]; then
  "$NODE" tools/build.mjs || fail "build"
fi

# ---- artifact guarantees ----------------------------------------------------
# These are the promises the page makes about itself. They are checked on the
# built file rather than asserted in prose, because a plausible artifact with a
# hole in it is the failure mode this repo cares about.
report "artifact guarantees"
ARTIFACT=index.html
if [[ ! -s $ARTIFACT ]]; then
  fail "no artifact to check"
else
  # No sibling files, no network: only in-page fragments and inline data: URIs.
  if grep -qE '<(script|link|img|source|iframe)[^>]+(src|href)="[^#d]' "$ARTIFACT"; then
    fail "artifact references an external file"
    grep -oE '<(script|link|img|source|iframe)[^>]+(src|href)="[^"]*"' "$ARTIFACT" | head -3 >&2
  else
    echo "  ok   no external file references"
  fi

  # Web storage would throw inside a sandboxed opaque-origin iframe, which is how
  # this page is served. Checked as source text because the artifact must not ask.
  if grep -qE 'localStorage|sessionStorage|indexedDB|document\.cookie' "$ARTIFACT"; then
    fail "artifact references web storage"
  else
    echo "  ok   no web storage use"
  fi

  # A bundle that leaked an ES-module keyword would throw at load in the artifact
  # while working fine as separate modules.
  if grep -nE '^(import|export) ' "$ARTIFACT" | head -3 | grep -q .; then
    fail "ES module syntax survived into the bundled artifact"
  else
    echo "  ok   no module syntax in the bundle"
  fi
fi

# ---- model ------------------------------------------------------------------
report "model"
if [[ -n $NODE ]]; then
  "$NODE" tests/model.test.mjs || fail "model checks"
fi

# ---- browser ----------------------------------------------------------------
report "browser"
if [[ -z ${PLAYWRIGHT_ENTRY:-} || -z ${PLAYWRIGHT_BROWSERS_PATH:-} ]]; then
  fail "PLAYWRIGHT_ENTRY and PLAYWRIGHT_BROWSERS_PATH must be set; run inside the pinned shell"
elif [[ -n $NODE ]]; then
  "$NODE" tests/browser.test.mjs || fail "browser checks"
fi

echo
if [[ $FAILED -eq 0 ]]; then
  echo "ALL CHECKS PASSED"
else
  echo "checks failed"
  exit 1
fi
