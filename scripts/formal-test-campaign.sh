#!/usr/bin/env bash

set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
validation_root="${project_dir}/data/validation"
current_run_file="${validation_root}/formal-test-current"
image_file="${validation_root}/formal-test-image"
monitor_name="pm-small-formal-test-monitor"
base_url="${PM_SMALL_FORMAL_TEST_BASE_URL:-http://127.0.0.1:3000}"
start_confirmation="START-TEST-72H"

usage() {
  cat <<'USAGE'
Usage:
  scripts/formal-test-campaign.sh prepare
  scripts/formal-test-campaign.sh start --confirm START-TEST-72H
  scripts/formal-test-campaign.sh status
  scripts/formal-test-campaign.sh include SEGMENT_ID
  scripts/formal-test-campaign.sh exclude SEGMENT_ID
  scripts/formal-test-campaign.sh stop

prepare only builds the standalone monitor image and keeps TEST PAUSED.
start creates a verified baseline backup, starts one formal TEST campaign, and
records four-hour/configuration-change segments. No segment counts until the
user explicitly runs include for that segment.
USAGE
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command is unavailable: $1" >&2
    exit 2
  fi
}

require_dependencies() {
  require_command curl
  require_command docker
  require_command git
  require_command python3
  require_command sha256sum
}

safe_status_json() {
  curl --fail --silent --show-error \
    --connect-timeout 5 \
    --max-time 20 \
    "${base_url}/api/status?compact=true"
}

require_safe_paused() {
  local status_json
  status_json="$(safe_status_json)"
  printf '%s' "$status_json" | python3 -c '
import json
import sys

status = json.load(sys.stdin)
actual = {
    "executionMode": status.get("executionMode"),
    "liveExecutionEnabled": status.get("liveExecutionEnabled"),
    "strategyMode": (status.get("strategy") or {}).get("mode"),
    "strategyStatus": (status.get("strategy") or {}).get("status"),
}
expected = {
    "executionMode": "TEST",
    "liveExecutionEnabled": False,
    "strategyMode": "TEST",
    "strategyStatus": "PAUSED",
}
if actual != expected:
    print(f"Formal TEST requires safe PAUSED state; got {actual}", file=sys.stderr)
    raise SystemExit(1)
'
  curl --fail --silent --show-error \
    --connect-timeout 5 \
    --max-time 30 \
    "${base_url}/api/test/validation" | python3 -c '
import json
import sys

validation = (json.load(sys.stdin).get("validation") or {})
if validation.get("passed") is not True or validation.get("sqliteIntegrity") != "ok":
    print(f"Formal TEST validation is not healthy: {validation}", file=sys.stderr)
    raise SystemExit(1)
'
}

require_safe_running() {
  local status_json
  status_json="$(safe_status_json)"
  printf '%s' "$status_json" | python3 -c '
import json
import sys

status = json.load(sys.stdin)
strategy = status.get("strategy") or {}
if (
    status.get("executionMode") != "TEST"
    or status.get("liveExecutionEnabled") is not False
    or strategy.get("mode") != "TEST"
    or strategy.get("status") != "RUNNING"
):
    print("Formal TEST did not enter safe RUNNING state", file=sys.stderr)
    raise SystemExit(1)
'
  curl --fail --silent --show-error \
    --connect-timeout 5 \
    --max-time 30 \
    "${base_url}/api/test/validation" | python3 -c '
import json
import sys

validation = (json.load(sys.stdin).get("validation") or {})
if validation.get("passed") is not True or validation.get("sqliteIntegrity") != "ok":
    print("Formal TEST validation failed after start", file=sys.stderr)
    raise SystemExit(1)
'
}

wait_for_safe_paused() {
  local attempt
  for attempt in $(seq 1 30); do
    if require_safe_paused >/dev/null 2>&1; then
      return
    fi
    sleep 2
  done
  echo "Application did not return to safe PAUSED state" >&2
  return 1
}

read_image() {
  if [[ ! -f "$image_file" ]]; then
    echo "Formal TEST monitor image is not prepared; run prepare first" >&2
    exit 1
  fi
  local image
  image="$(<"$image_file")"
  if [[ ! "$image" =~ ^pm-small-formal-test:[0-9a-f]{12}$ ]]; then
    echo "Invalid formal TEST image reference: $image" >&2
    exit 1
  fi
  if ! docker image inspect "$image" >/dev/null 2>&1; then
    echo "Prepared formal TEST image is missing: $image" >&2
    exit 1
  fi
  printf '%s\n' "$image"
}

read_current_run() {
  if [[ ! -f "$current_run_file" ]]; then
    echo "No formal TEST campaign has been created" >&2
    exit 1
  fi
  local run_directory
  run_directory="$(<"$current_run_file")"
  case "$run_directory" in
    "${validation_root}"/formal-test-*) ;;
    *)
      echo "Invalid formal TEST run directory: $run_directory" >&2
      exit 1
      ;;
  esac
  if [[ ! -d "$run_directory" ]]; then
    echo "Formal TEST run directory is missing: $run_directory" >&2
    exit 1
  fi
  printf '%s\n' "$run_directory"
}

run_monitor_cli() {
  local run_directory="$1"
  shift
  local image
  image="$(read_image)"
  docker run --rm \
    --network host \
    --mount "type=bind,src=${run_directory},dst=/app/data/validation/current" \
    "$image" \
    node dist/cli/formal-test-campaign.js \
    "$@" \
    --run-dir /app/data/validation/current
}

prepare_monitor() {
  require_safe_paused
  local commit image temporary
  commit="$(git -C "$project_dir" rev-parse --verify HEAD)"
  image="pm-small-formal-test:${commit:0:12}"
  docker build --target runtime --tag "$image" "$project_dir"
  docker run --rm --entrypoint test "$image" \
    -f /app/dist/cli/formal-test-campaign.js
  mkdir -p "$validation_root"
  temporary="${image_file}.tmp-$$"
  printf '%s\n' "$image" > "$temporary"
  mv "$temporary" "$image_file"
  require_safe_paused
  echo "Prepared $image; application remains TEST + LIVE_DISABLED + PAUSED"
}

create_baseline_backup() {
  local stamp backup_directory bot_restarted database_path backup_database
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup_directory="$(dirname "$project_dir")/pm-small-formal-test-baseline-${stamp}"
  if [[ -e "$backup_directory" ]]; then
    echo "Baseline backup already exists: $backup_directory" >&2
    exit 1
  fi
  bot_restarted=false
  restart_bot_on_exit() {
    if [[ "$bot_restarted" != true ]]; then
      docker compose --project-directory "$project_dir" start bot >/dev/null 2>&1 || true
    fi
  }
  trap restart_bot_on_exit EXIT
  docker compose --project-directory "$project_dir" stop bot >/dev/null
  mkdir "$backup_directory"
  cp -a \
    "${project_dir}/data" \
    "${project_dir}/.env" \
    "${project_dir}/docker-compose.yml" \
    "$backup_directory/"
  database_path="$(sed -n 's/^DATABASE_PATH=//p' "${project_dir}/.env" | tail -n 1)"
  database_path="${database_path:-./data/paper.db}"
  case "$database_path" in
    ./data/*) ;;
    *)
      echo "Formal TEST backup only accepts DATABASE_PATH under ./data: $database_path" >&2
      exit 1
      ;;
  esac
  backup_database="${backup_directory}/${database_path#./}"
  python3 -c '
import sqlite3
import sys

database_path = sys.argv[1]
connection = sqlite3.connect(f"file:{database_path}?mode=ro", uri=True)
try:
    result = connection.execute("PRAGMA integrity_check").fetchone()
finally:
    connection.close()
if result is None or result[0] != "ok":
    print(f"Baseline SQLite integrity_check failed: {result}", file=sys.stderr)
    raise SystemExit(1)
' "$backup_database"
  (
    cd "$backup_directory"
    find . -type f ! -name SHA256SUMS -print0 \
      | sort -z \
      | xargs -0 sha256sum
  ) > "${backup_directory}/SHA256SUMS"
  (
    cd "$backup_directory"
    sha256sum --check SHA256SUMS >/dev/null
  )
  docker compose --project-directory "$project_dir" start bot >/dev/null
  bot_restarted=true
  trap - EXIT
  wait_for_safe_paused
  printf '%s\n' "$backup_directory"
}

start_campaign() {
  if [[ $# -ne 2 || "$1" != "--confirm" || "$2" != "$start_confirmation" ]]; then
    echo "Starting requires: start --confirm ${start_confirmation}" >&2
    exit 2
  fi
  require_safe_paused
  local image existing_running backup_directory stamp run_id run_directory temporary
  local repository_commit bot_container_id bot_image_id
  local previous_run previous_status
  image="$(read_image)"
  if [[ -f "$current_run_file" ]]; then
    previous_run="$(read_current_run)"
    if [[ -f "${previous_run}/campaign.json" ]]; then
      previous_status="$(python3 -c '
import json
import sys
print(json.load(open(sys.argv[1], encoding="utf-8")).get("status", ""))
' "${previous_run}/campaign.json")"
      if [[ "$previous_status" == "RUNNING" || "$previous_status" == "TARGET_REACHED" ]]; then
        echo "Existing formal TEST campaign must be stopped/audited first: ${previous_run} (${previous_status})" >&2
        exit 1
      fi
    fi
  fi
  existing_running="$(
    docker inspect --format '{{.State.Running}}' "$monitor_name" 2>/dev/null || true
  )"
  if [[ "$existing_running" == "true" ]]; then
    echo "Formal TEST monitor is already running: $monitor_name" >&2
    exit 1
  fi
  if [[ -n "$existing_running" ]]; then
    docker rm "$monitor_name" >/dev/null
  fi
  backup_directory="$(create_baseline_backup)"
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  run_id="formal-test-${stamp}"
  run_directory="${validation_root}/${run_id}"
  mkdir -p "$run_directory"
  chmod 700 "$run_directory"
  repository_commit="$(git -C "$project_dir" rev-parse --verify HEAD)"
  bot_container_id="$(
    docker compose --project-directory "$project_dir" ps -q bot
  )"
  bot_image_id="$(docker inspect --format '{{.Image}}' "$bot_container_id")"
  python3 -c '
import json
import sys

context = {
    "version": 1,
    "repositoryCommit": sys.argv[1],
    "monitorImage": sys.argv[2],
    "botContainerId": sys.argv[3],
    "botImageId": sys.argv[4],
    "baselineBackup": sys.argv[5],
}
with open(sys.argv[6], "w", encoding="utf-8") as output:
    json.dump(context, output, ensure_ascii=False, indent=2)
    output.write("\n")
' \
    "$repository_commit" \
    "$image" \
    "$bot_container_id" \
    "$bot_image_id" \
    "$backup_directory" \
    "${run_directory}/server-context.json"
  temporary="${current_run_file}.tmp-$$"
  printf '%s\n' "$run_directory" > "$temporary"
  mv "$temporary" "$current_run_file"
  docker run -d \
    --name "$monitor_name" \
    --restart unless-stopped \
    --init \
    --network host \
    --mount "type=bind,src=${run_directory},dst=/app/data/validation/current" \
    --label "pm-small.formal-test.run=${run_id}" \
    --label "pm-small.formal-test.baseline=${backup_directory}" \
    "$image" \
    node dist/cli/formal-test-campaign.js supervise \
    --base-url "$base_url" \
    --run-dir /app/data/validation/current \
    --target-seconds 259200 \
    --checkpoint-seconds 14400 \
    --max-wall-seconds 432000 \
    --interval-seconds 60 \
    --request-timeout-seconds 15 \
    --max-consecutive-errors 3 \
    --pause-retry-seconds 300 \
    --confirm "$start_confirmation" >/dev/null
  sleep 2
  if [[ "$(docker inspect --format '{{.State.Running}}' "$monitor_name")" != "true" ]]; then
    echo "Formal TEST monitor failed to stay running" >&2
    docker logs "$monitor_name" >&2 || true
    exit 1
  fi
  local campaign_status
  campaign_status=""
  for _attempt in $(seq 1 30); do
    if [[ -f "${run_directory}/campaign.json" ]]; then
      campaign_status="$(python3 -c '
import json
import sys
print(json.load(open(sys.argv[1], encoding="utf-8")).get("status", ""))
' "${run_directory}/campaign.json")"
      break
    fi
    sleep 1
  done
  if [[ "$campaign_status" != "RUNNING" ]]; then
    echo "Formal TEST campaign did not start safely; status=${campaign_status:-missing}" >&2
    docker logs "$monitor_name" >&2 || true
    exit 1
  fi
  if ! require_safe_running; then
    run_monitor_cli "$run_directory" stop >/dev/null 2>&1 || \
      curl --silent --show-error --max-time 20 \
        --request POST "${base_url}/api/test/pause" >/dev/null || true
    echo "Formal TEST startup verification failed; PAUSE was requested" >&2
    exit 1
  fi
  echo "Formal TEST campaign created: $run_id"
  echo "Baseline backup: $backup_directory"
  echo "Use '$0 status' to view evidence; every completed segment remains pending until user decision"
}

show_status() {
  local run_directory
  run_directory="$(read_current_run)"
  run_monitor_cli "$run_directory" status
  printf '\n## 当前应用安全状态\n\n'
  safe_status_json | python3 -c '
import json
import sys

status = json.load(sys.stdin)
strategy = status.get("strategy") or {}
scan = status.get("marketScan") or {}
stream = status.get("marketStream") or {}
execution_mode = status.get("executionMode")
live_enabled = status.get("liveExecutionEnabled")
strategy_status = strategy.get("status")
candidate_count = scan.get("candidateCount")
stream_connected = stream.get("connected")
subscribed_count = stream.get("subscribedTokenCount")
print(f"- 模式：{execution_mode}")
print(f"- LIVE：{live_enabled}")
print(f"- 策略：{strategy_status}")
print(f"- 候选：{candidate_count}")
print(f"- 行情：connected={stream_connected}, subscribed={subscribed_count}")
'
}

decide_segment() {
  local decision="$1"
  local segment_id="$2"
  if [[ ! "$segment_id" =~ ^segment-[0-9]{4}$ ]]; then
    echo "Invalid formal TEST segment id: $segment_id" >&2
    exit 2
  fi
  local run_directory
  run_directory="$(read_current_run)"
  run_monitor_cli "$run_directory" decide \
    --segment-id "$segment_id" \
    --decision "$decision"
}

stop_campaign() {
  local run_directory
  run_directory="$(read_current_run)"
  run_monitor_cli "$run_directory" stop
  if [[ "$(docker inspect --format '{{.State.Running}}' "$monitor_name" 2>/dev/null || true)" == "true" ]]; then
    docker stop --time 20 "$monitor_name" >/dev/null
  fi
  require_safe_paused
  echo "Formal TEST is stopped and confirmed PAUSED; evidence remains in $run_directory"
}

main() {
  require_dependencies
  mkdir -p "$validation_root"
  if [[ $# -lt 1 ]]; then
    usage >&2
    exit 2
  fi
  local command="$1"
  shift
  case "$command" in
    prepare)
      [[ $# -eq 0 ]] || { usage >&2; exit 2; }
      prepare_monitor
      ;;
    start)
      start_campaign "$@"
      ;;
    status)
      [[ $# -eq 0 ]] || { usage >&2; exit 2; }
      show_status
      ;;
    include|exclude)
      [[ $# -eq 1 ]] || { usage >&2; exit 2; }
      decide_segment "$command" "$1"
      ;;
    stop)
      [[ $# -eq 0 ]] || { usage >&2; exit 2; }
      stop_campaign
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
}

main "$@"
