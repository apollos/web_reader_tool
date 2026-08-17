#!/usr/bin/env bash
# Manual deployment acceptance only. Never call this from the Skill's normal path.
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cli_js="${VWR_CLI_JS:-${project_dir}/dist/cli.js}"
launcher="${project_dir}/skill/verified-web-reader/scripts/verified-browser-read"
test_url="${1:-https://example.com/}"
scratch_dir="$(mktemp -d)"
trap 'rm -rf "$scratch_dir"' EXIT

command -v node >/dev/null
command -v openclaw >/dev/null
test -f "$cli_js"
test -x "$launcher"

if command -v ss >/dev/null; then
  ss -ltn | tail -n +2 | sort >"$scratch_dir/listeners-before.txt"
fi

VWR_CLI_JS="$cli_js" "$launcher" doctor >"$scratch_dir/doctor.json"
node -e '
  const fs=require("fs");
  const report=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  if (!report.ok) { console.error(JSON.stringify(report,null,2)); process.exit(1); }
' "$scratch_dir/doctor.json"

read_input="$(node -e '
  process.stdout.write(JSON.stringify({
    url: process.argv[1],
    fallback_reason: { type: "user_requested", detail: "manual acceptance smoke test" },
    require_complete: true
  }));
' "$test_url")"

VWR_CLI_JS="$cli_js" VWR_READ_INPUT_JSON="$read_input" \
  "$launcher" read --input-env VWR_READ_INPUT_JSON \
  >"$scratch_dir/read.json"

node -e '
  const fs=require("fs");
  const result=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  const allowed=new Set(["browser_verified","browser_partial","login_required","captcha","paywall"]);
  if (!allowed.has(result.status)) { console.error(JSON.stringify(result,null,2)); process.exit(1); }
  if (result.browser_lifecycle.tab_closed !== true) {
    console.error("task tab was not confirmed closed"); process.exit(1);
  }
  console.log(JSON.stringify({status:result.status,content_chars:result.content_chars,browser_lifecycle:result.browser_lifecycle},null,2));
' "$scratch_dir/read.json"

if pgrep -af '[v]erified-browser-read' >/dev/null; then
  echo "verified-browser-read process remains after completion" >&2
  pgrep -af '[v]erified-browser-read' >&2
  exit 1
fi

if command -v ss >/dev/null; then
  ss -ltn | tail -n +2 | sort >"$scratch_dir/listeners-after.txt"
  if ! diff -u "$scratch_dir/listeners-before.txt" "$scratch_dir/listeners-after.txt"; then
    echo "listening TCP sockets changed during acceptance test" >&2
    exit 1
  fi
fi

echo "acceptance smoke test passed"
