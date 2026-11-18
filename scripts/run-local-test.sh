#!/usr/bin/env bash
# End-to-end local test of the SmashLab AI backend running in Docker (Compose project smashlab-ai).
#
# Steps: start the stack, wait for /health, run the four test samples (A to D) through the HTTP API,
# validate every output folder (JSON, H.264, faststart, unsupported-stage flags), exercise the
# error cases, restart the containers and check that finished jobs and new jobs still work.
# Results go to outputs/test-runs/<timestamp>/ (gitignored). Nothing is pushed or deployed.
#
# Usage:
#   scripts/run-local-test.sh            build if needed, then run the full test
#   scripts/run-local-test.sh --no-build use the existing image
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

BUILD_FLAG="--build"
if [[ "${1:-}" == "--no-build" ]]; then
  BUILD_FLAG=""
fi

API="${SMASHLAB_API_URL:-http://localhost:8000}"
# Send the backend token when the backend requires one: set SMASHLAB_API_TOKEN to the same value as on the backend.
AUTH_HEADER=(-H "Authorization: Bearer ${SMASHLAB_API_TOKEN:-none}")
COMPOSE=(docker compose -p smashlab-ai -f docker-compose.yml)
STAMP="$(date +%Y%m%d-%H%M%S)"
RUN_DIR="$REPO_ROOT/outputs/test-runs/$STAMP"
mkdir -p "$RUN_DIR"
LOG="$RUN_DIR/run.log"
SUMMARY="$RUN_DIR/summary.json"
STATS="$RUN_DIR/docker-stats.log"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/smashlab-e2e.XXXXXX")"
PY=(python3 -I)

log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }

http_code() {
  # http_code <curl args...> : prints the HTTP status code only
  curl "${AUTH_HEADER[@]}" -s -o /dev/null -w '%{http_code}' "$@"
}

wait_for_health() {
  local deadline=$((SECONDS + 240))
  until [[ "$(curl "${AUTH_HEADER[@]}" -s -o /dev/null -w '%{http_code}' "$API/health")" == "200" ]]; do
    if (( SECONDS > deadline )); then
      log "health check timed out"
      return 1
    fi
    sleep 3
  done
  curl "${AUTH_HEADER[@]}" -s "$API/health"
}

json_get() {
  # json_get <file> <python expression on variable d>
  "${PY[@]}" -c "import json,sys; d=json.load(open(sys.argv[1])); print($2)" "$1"
}

start_stats_sampler() {
  (
    while true; do
      echo "$(date +%H:%M:%S) $(docker stats --no-stream --format '{{.Name}} cpu={{.CPUPerc}} mem={{.MemUsage}}' smashlab-ai-api 2>/dev/null || echo 'docker stats unavailable')" >> "$STATS"
      sleep 5
    done
  ) &
  STATS_PID=$!
}

stop_stats_sampler() {
  if [[ -n "${STATS_PID:-}" ]]; then
    kill "$STATS_PID" 2>/dev/null || true
    wait "$STATS_PID" 2>/dev/null || true
  fi
}

cleanup() {
  stop_stats_sampler
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

log "== Start stack (compose project smashlab-ai) $BUILD_FLAG"
"${COMPOSE[@]}" up -d $BUILD_FLAG 2>&1 | tee -a "$LOG"
HEALTH="$(wait_for_health)"
echo "$HEALTH" > "$RUN_DIR/health-before.json"
log "health: $HEALTH"
auth_probe="$(http_code "$API/api/v1/samples")"
if [[ "$auth_probe" == "401" ]]; then
  log "authentication failed: export SMASHLAB_API_TOKEN with the same local value used by Docker, then run this script again"
  exit 1
fi
if [[ "$auth_probe" != "200" ]]; then
  log "sample API preflight returned HTTP $auth_probe"
  exit 1
fi
start_stats_sampler

declare -a RESULT_ROWS=()

run_job() {
  # run_job <mode sample|upload> <sample id> <expect court 0|1>
  local mode="$1" sample="$2" expect_court="$3"
  local created job_id status_json state started elapsed label="$1:$2"
  created="$RUN_DIR/$mode-$sample-created.json"
  log "== Job $label"
  if [[ "$mode" == "sample" ]]; then
    if ! curl "${AUTH_HEADER[@]}" -s -f -X POST "$API/api/v1/analyses" -F "sample_id=$sample" -o "$created"; then
      log "could not create $label (check the API token and backend log)"
      return 1
    fi
  else
    if ! curl "${AUTH_HEADER[@]}" -s -f -X POST "$API/api/v1/analyses" -F "file=@data/samples/$sample.mp4;type=video/mp4" -o "$created"; then
      log "could not create $label (check the API token and backend log)"
      return 1
    fi
  fi
  if [[ ! -s "$created" ]]; then
    log "job creation returned an empty response for $label"
    return 1
  fi
  job_id="$(json_get "$created" 'd["job_id"]')"
  log "job $job_id queued"
  started=$SECONDS
  while true; do
    status_json="$RUN_DIR/$sample-status.json"
    curl "${AUTH_HEADER[@]}" -s -f "$API/api/v1/analyses/$job_id" -o "$status_json"
    state="$(json_get "$status_json" 'd["status"]')"
    if [[ "$state" == "completed" || "$state" == "failed" ]]; then
      break
    fi
    if (( SECONDS - started > 2400 )); then
      state="timeout-in-test"
      break
    fi
    sleep 10
  done
  elapsed=$((SECONDS - started))
  log "job $job_id finished with state=$state after ${elapsed}s"
  if [[ "$state" != "completed" ]]; then
    RESULT_ROWS+=("{\"mode\":\"$mode\",\"sample\":\"$sample\",\"job_id\":\"$job_id\",\"state\":\"$state\",\"elapsed_s\":$elapsed}")
    return 1
  fi
  local folder="$RUN_DIR/$mode-$sample-$job_id"
  mkdir -p "$folder"
  for name in results.json analysis.json analysis_report.json player_tracks.json identity_events.json rallies.json shots.json shuttle_trajectory.json metrics.json inference_report.json annotated.mp4 court_coordinates.json; do
    local code
    code="$(curl "${AUTH_HEADER[@]}" -s -o "$folder/$name" -w '%{http_code}' "$API/api/v1/analyses/$job_id/artifacts/$name")"
    if [[ "$code" != "200" && "$name" != "court_coordinates.json" ]]; then
      log "artifact $name returned HTTP $code"
    fi
    if [[ "$code" != "200" ]]; then rm -f "$folder/$name"; fi
  done
  curl "${AUTH_HEADER[@]}" -s -f "$API/api/v1/analyses/$job_id/results" -o "$folder/results-endpoint.json"
  curl "${AUTH_HEADER[@]}" -s -f "$API/api/v1/analyses/$job_id/match" -o "$folder/match.json"
  mkdir -p "$folder/derived"
  curl "${AUTH_HEADER[@]}" -s -f "$API/api/v1/analyses/$job_id/shot-trajectory" -o "$folder/derived/shot_trajectory_summary.json"
  curl "${AUTH_HEADER[@]}" -s -f "$API/api/v1/analyses/$job_id/shot-trajectory/records" -o "$folder/derived/shot_trajectory_records.json"
  curl "${AUTH_HEADER[@]}" -s -f "$API/api/v1/analyses/$job_id/shot-trajectory/export.jsonl" -o "$folder/derived/shot_trajectory_dataset.jsonl"
  local validate_args=("$folder")
  if [[ "$expect_court" == "1" ]]; then validate_args+=("--expect-court"); fi
  if "${PY[@]}" backend/tools/validate_outputs.py "${validate_args[@]}" > "$folder/validation.json"; then
    log "validation passed for $sample"
    RESULT_ROWS+=("{\"mode\":\"$mode\",\"sample\":\"$sample\",\"job_id\":\"$job_id\",\"state\":\"completed\",\"elapsed_s\":$elapsed,\"validation\":\"passed\"}")
  else
    log "validation FAILED for $sample (see $folder/validation.json)"
    RESULT_ROWS+=("{\"mode\":\"$mode\",\"sample\":\"$sample\",\"job_id\":\"$job_id\",\"state\":\"completed\",\"elapsed_s\":$elapsed,\"validation\":\"failed\"}")
    return 1
  fi
}

FAILED=0
run_job sample sample-a-singles-rally 1 || FAILED=$((FAILED + 1))
run_job sample sample-b-fast-shuttle 1 || FAILED=$((FAILED + 1))
run_job sample sample-c-difficult-multicourt 0 || FAILED=$((FAILED + 1))
run_job upload sample-c-difficult-multicourt 0 || FAILED=$((FAILED + 1))
run_job sample sample-d-demonstration 0 || FAILED=$((FAILED + 1))

log "== Error cases"
ERRORS="$RUN_DIR/error-cases.json"
printf 'not a video at all, just text bytes' > "$SCRATCH/corrupt.mp4"
head -c 4096 /dev/urandom > "$SCRATCH/random.mp4"
printf 'RIFF....AVI ' > "$SCRATCH/clip.avi"
: > "$SCRATCH/empty.mp4"
if [[ -f "data/samples/sample-a-singles-rally.mp4" ]]; then
  head -c 20000 "data/samples/sample-a-singles-rally.mp4" > "$SCRATCH/truncated.mp4"
fi
c_corrupt="$(http_code -X POST "$API/api/v1/analyses" -F "file=@$SCRATCH/corrupt.mp4;type=video/mp4")"
c_random="$(http_code -X POST "$API/api/v1/analyses" -F "file=@$SCRATCH/random.mp4;type=video/mp4")"
c_avi="$(http_code -X POST "$API/api/v1/analyses" -F "file=@$SCRATCH/clip.avi;type=video/x-msvideo")"
c_empty="$(http_code -X POST "$API/api/v1/analyses" -F "file=@$SCRATCH/empty.mp4;type=video/mp4")"
c_none="$(http_code -X POST "$API/api/v1/analyses")"
c_unknown_job="$(http_code "$API/api/v1/analyses/00000000000000000000000000000000")"
c_bad_id="$(http_code "$API/api/v1/analyses/not-a-real-id")"
c_unknown_sample="$(http_code -X POST "$API/api/v1/analyses" -F "sample_id=does-not-exist")"
c_truncated="skipped"
if [[ -f "$SCRATCH/truncated.mp4" ]]; then
  c_truncated="$(http_code -X POST "$API/api/v1/analyses" -F "file=@$SCRATCH/truncated.mp4;type=video/mp4")"
fi
cat > "$ERRORS" <<JSON
{
  "corrupt_text_as_mp4": $c_corrupt,
  "random_bytes_as_mp4": $c_random,
  "avi_container": $c_avi,
  "empty_file": $c_empty,
  "no_source": $c_none,
  "unknown_job_id": $c_unknown_job,
  "malformed_job_id": $c_bad_id,
  "unknown_sample": $c_unknown_sample,
  "truncated_mp4_header_only": "$c_truncated"
}
JSON
cat "$ERRORS" | tee -a "$LOG"

log "== Restart containers and check persistence"
before_jobs="$(curl "${AUTH_HEADER[@]}" -s "$API/health" | "${PY[@]}" -c 'import json,sys; print(json.load(sys.stdin)["jobs"]["completed"])')"
"${COMPOSE[@]}" restart api 2>&1 | tee -a "$LOG"
HEALTH_AFTER="$(wait_for_health)"
echo "$HEALTH_AFTER" > "$RUN_DIR/health-after.json"
after_jobs="$(curl "${AUTH_HEADER[@]}" -s "$API/health" | "${PY[@]}" -c 'import json,sys; print(json.load(sys.stdin)["jobs"]["completed"])')"
log "completed jobs before restart: $before_jobs, after restart: $after_jobs"
RESTART_OK=0
if [[ "$before_jobs" == "$after_jobs" ]]; then RESTART_OK=1; fi
first_id="$("${PY[@]}" -c 'import json,sys; print(json.load(open(sys.argv[1]))["job_id"])' "$RUN_DIR/sample-sample-a-singles-rally-created.json" 2>/dev/null || true)"
if [[ -n "$first_id" ]]; then
  code="$(http_code "$API/api/v1/analyses/$first_id/results")"
  log "results of an earlier job after restart: HTTP $code"
  if [[ "$code" != "200" ]]; then RESTART_OK=0; fi
fi
if [[ "$RESTART_OK" == "1" ]]; then
  run_job sample sample-c-difficult-multicourt 0 || FAILED=$((FAILED + 1))
else
  FAILED=$((FAILED + 1))
fi

stop_stats_sampler
{
  echo "{"
  echo "  \"run\": \"$STAMP\","
  echo "  \"api\": \"$API\","
  echo "  \"samples\": ["
  local_first=1
  for row in "${RESULT_ROWS[@]}"; do
    if [[ "$local_first" == "0" ]]; then echo ","; fi
    printf '    %s' "$row"
    local_first=0
  done
  echo ""
  echo "  ],"
  echo "  \"error_cases\": $(cat "$ERRORS"),"
  echo "  \"restart_persistence_ok\": $([[ $RESTART_OK == 1 ]] && echo true || echo false),"
  echo "  \"failed_items\": $FAILED"
  echo "}"
} > "$SUMMARY"
log "summary written to $SUMMARY"
if [[ "$FAILED" -gt 0 ]]; then
  log "FAILED items: $FAILED"
  exit 1
fi
log "All checks passed."
