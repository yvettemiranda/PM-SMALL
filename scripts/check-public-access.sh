#!/usr/bin/env bash

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: PM_SMALL_ACCESS_USER=... PM_SMALL_ACCESS_PASSWORD=... $0 https://example.com" >&2
  exit 2
fi

base_url="${1%/}"
if [[ "$base_url" != https://* ]]; then
  echo "Expected an HTTPS base URL, got: $base_url" >&2
  exit 2
fi

: "${PM_SMALL_ACCESS_USER:?Set PM_SMALL_ACCESS_USER before running this check}"
: "${PM_SMALL_ACCESS_PASSWORD:?Set PM_SMALL_ACCESS_PASSWORD before running this check}"

if ! command -v curl >/dev/null 2>&1; then
  echo "Required command is unavailable: curl" >&2
  exit 2
fi

curl_common=(
  --silent
  --show-error
  --connect-timeout 5
  --max-time 12
)
curl_authenticated=(
  "${curl_common[@]}"
  --user "${PM_SMALL_ACCESS_USER}:${PM_SMALL_ACCESS_PASSWORD}"
)

expect_http_code() {
  local expected="$1"
  local label="$2"
  shift 2

  local actual
  actual="$(curl "${curl_common[@]}" --output /dev/null --write-out '%{http_code}' "$@")"
  if [[ "$actual" != "$expected" ]]; then
    echo "FAIL: $label returned HTTP $actual; expected $expected" >&2
    exit 1
  fi
  echo "PASS: $label returned HTTP $actual"
}

# This strict request is the regression signal for the mobile failure. Never add
# --insecure: the delivered URL must have a publicly trusted matching certificate.
expect_http_code "401" "unauthenticated HTTPS" "${base_url}/"

http_url="http://${base_url#https://}"
read -r redirect_code redirect_url < <(
  curl "${curl_common[@]}" \
    --output /dev/null \
    --write-out '%{http_code} %{redirect_url}' \
    "${http_url}/"
)
case "$redirect_code" in
  301|302|307|308) ;;
  *)
    echo "FAIL: HTTP entry returned $redirect_code instead of a redirect" >&2
    exit 1
    ;;
esac
if [[ "$redirect_url" != "${base_url}/" ]]; then
  echo "FAIL: HTTP entry redirects to $redirect_url instead of ${base_url}/" >&2
  exit 1
fi
echo "PASS: HTTP redirects to the HTTPS hostname"

authenticated_code="$(
  curl "${curl_authenticated[@]}" \
    --output /dev/null \
    --write-out '%{http_code}' \
    "${base_url}/"
)"
if [[ "$authenticated_code" != "200" ]]; then
  echo "FAIL: authenticated homepage returned HTTP $authenticated_code; expected 200" >&2
  exit 1
fi
echo "PASS: authenticated homepage returned HTTP 200"

node_bin="${PM_SMALL_NODE_BIN:-node}"
if ! command -v "$node_bin" >/dev/null 2>&1; then
  echo "Required Node.js executable is unavailable: $node_bin" >&2
  exit 2
fi

status_json="$(curl "${curl_authenticated[@]}" "${base_url}/api/status?compact=true")"
printf '%s' "$status_json" | "$node_bin" --input-type=module -e '
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const status = JSON.parse(input);
  const expectedStatus = process.env.PM_SMALL_EXPECTED_STRATEGY_STATUS ?? "PAUSED";
  const failures = [];
  if (status.executionMode !== "PAPER") {
    failures.push(`executionMode=${JSON.stringify(status.executionMode)}`);
  }
  if (status.liveExecutionEnabled !== false) {
    failures.push(`liveExecutionEnabled=${JSON.stringify(status.liveExecutionEnabled)}`);
  }
  if (status.strategy?.status !== expectedStatus) {
    failures.push(`strategy.status=${JSON.stringify(status.strategy?.status)}`);
  }
  if (failures.length > 0) {
    console.error(`FAIL: unsafe or unexpected status: ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log(`PASS: PAPER, LIVE disabled, strategy ${expectedStatus}`);
'

validation_json="$(curl "${curl_authenticated[@]}" "${base_url}/api/paper/validation")"
printf '%s' "$validation_json" | "$node_bin" --input-type=module -e '
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const result = JSON.parse(input);
  if (result.validation?.passed !== true || result.validation?.sqliteIntegrity !== "ok") {
    console.error("FAIL: PAPER validation did not pass with SQLite integrity ok");
    process.exit(1);
  }
  console.log("PASS: PAPER validation passed and SQLite integrity is ok");
'

echo "PASS: public TEST access is ready at ${base_url}/"
