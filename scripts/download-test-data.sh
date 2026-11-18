#!/usr/bin/env bash
# Download, verify and prepare the local test data and model files for the SmashLab AI backend.
#
# Sources are public and need no login (Wikimedia Commons, opencv_zoo on GitHub, the TrackNetV3
# repository's Google Drive checkpoint link). Nothing is uploaded. Every file is checked against a
# recorded SHA-256. The TrackNetV2 SharePoint dataset and Kaggle are NOT downloaded (see manifest).
#
# Usage:
#   scripts/download-test-data.sh                 download missing files, verify, trim samples, write manifests
#   scripts/download-test-data.sh --verify-only   check existing files and checksums only (no network)
#   scripts/download-test-data.sh --export        also export TrackNetV3 ONNX (needs backend/.venv-dev with torch)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

MODE="download"
EXPORT=0
for arg in "$@"; do
  case "$arg" in
    --verify-only) MODE="verify" ;;
    --export) EXPORT=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

USER_AGENT="SmashLab-local-pipeline/0.1"
FAILURES=0

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

check_file() {
  # check_file <path> <expected sha256> <label>
  local path="$1" expected="$2" label="$3"
  if [[ ! -f "$path" ]]; then
    echo "MISSING  $label  ($path)"
    FAILURES=$((FAILURES + 1))
    return 1
  fi
  local actual
  actual="$(sha256_of "$path")"
  if [[ "$actual" == "$expected" ]]; then
    echo "OK       $label"
    return 0
  fi
  echo "MISMATCH $label  expected $expected got $actual"
  FAILURES=$((FAILURES + 1))
  return 1
}

fetch() {
  # fetch <url> <destination> : download when the destination is missing, using a temporary name first
  local url="$1" dest="$2"
  mkdir -p "$(dirname "$dest")"
  local tmp="${dest}.part"
  curl -fL --retry 3 --retry-delay 5 -A "$USER_AGENT" -o "$tmp" "$url"
  mv "$tmp" "$dest"
}

echo "== Models"
YOLOX_SHA="c5c2d13e59ae883e6af3b45daea64af4833a4951c92d116ec270d9ddbe998063"
YOLOX_FILE="models/yolox/object_detection_yolox_2022nov.onnx"
if [[ "$MODE" == "download" && ! -f "$YOLOX_FILE" ]]; then
  fetch "https://github.com/opencv/opencv_zoo/raw/main/models/object_detection_yolox/object_detection_yolox_2022nov.onnx" "$YOLOX_FILE"
  fetch "https://raw.githubusercontent.com/opencv/opencv_zoo/main/models/object_detection_yolox/LICENSE" "models/yolox/LICENSE-opencv_zoo-Apache-2.0.txt"
fi
check_file "$YOLOX_FILE" "$YOLOX_SHA" "YOLOX-s ONNX (Apache-2.0, opencv_zoo)" || true

CKPT_SHA="8de68d34ea2457e368e22947f1309143d60a6a7f9ddccd31cd526d4c4571bcc4"
CKPT_ZIP="models/tracknetv3/download/TrackNetV3_ckpts.zip"
# Google Drive asks for confirmation for files above its virus-scan size limit; the confirm token below is the one shown on the public page.
CKPT_URL="https://drive.usercontent.google.com/download?id=1CfzE87a0f6LhBp0kniSl1-89zaLCZ8cA&export=download&confirm=t&uuid=f01e9520-fbf6-430b-b815-ffb0918c42bf"
if [[ "$MODE" == "download" && ! -f "$CKPT_ZIP" ]]; then
  fetch "$CKPT_URL" "$CKPT_ZIP"
fi
check_file "$CKPT_ZIP" "$CKPT_SHA" "TrackNetV3 checkpoint archive (MIT, qaz812345/TrackNetV3)" || true
if [[ -f "$CKPT_ZIP" && ! -f models/tracknetv3/TrackNet_best.pt ]]; then
  unzip -o -q "$CKPT_ZIP" -d models/tracknetv3/download
  cp models/tracknetv3/download/ckpts/TrackNet_best.pt models/tracknetv3/TrackNet_best.pt
  cp models/tracknetv3/download/ckpts/InpaintNet_best.pt models/tracknetv3/InpaintNet_best.pt
fi

if [[ "$EXPORT" == "1" ]]; then
  echo "== TrackNetV3 ONNX export (host only, PyTorch)"
  if [[ ! -x backend/.venv-dev/bin/python ]]; then
    echo "backend/.venv-dev is missing. Create it with:"
    echo "  python3.12 -m venv backend/.venv-dev && backend/.venv-dev/bin/python -m pip install -r backend/requirements-export.txt"
    exit 2
  fi
  SRC_DIR="$(mktemp -d "${TMPDIR:-/tmp}/smashlab-tracknetv3.XXXXXX")"
  fetch "https://github.com/qaz812345/TrackNetV3/archive/refs/heads/master.tar.gz" "$SRC_DIR/src.tar.gz"
  tar -xzf "$SRC_DIR/src.tar.gz" -C "$SRC_DIR"
  backend/.venv-dev/bin/python -I backend/tools/export_tracknetv3.py \
    --src "$SRC_DIR/TrackNetV3-master" \
    --ckpt models/tracknetv3/TrackNet_best.pt \
    --inpaint-ckpt models/tracknetv3/InpaintNet_best.pt \
    --out-dir models/tracknetv3 > /dev/null
  rm -rf "$SRC_DIR"
fi
check_file "models/tracknetv3/tracknetv3_tracknet.onnx" "282d06a846ba94bfe7f5c51436f5b67c5de7230324b7d715ba6727b20e9feb31" "TrackNet ONNX (exported from the checkpoint)" || true
check_file "models/tracknetv3/tracknetv3_inpaintnet.onnx" "4d765485e51146c0e29f384156602165e69293f269cfa84a7a6add30dd443df8" "InpaintNet ONNX (exported from the checkpoint)" || true

echo "== Raw clips (Wikimedia Commons, CC BY 3.0 / CC BY-SA 4.0 / public domain)"
RAW_DIR="data/raw/commons"
WANG="$RAW_DIR/Wang_Zhiyi_China_Open_2025_final.webm"
EURO="$RAW_DIR/EuroGames_2023_Bern_competition.webm"
DEMO="$RAW_DIR/Demonstratie_badminton_public_domain.webm"
if [[ "$MODE" == "download" ]]; then
  [[ -f "$WANG" ]] || fetch "https://upload.wikimedia.org/wikipedia/commons/2/2f/Wang_Zhiyi_triumph_in_all-Chinese_China_Open_finals_I_China_Open_2025.webm" "$WANG"
  [[ -f "$EURO" ]] || fetch "https://upload.wikimedia.org/wikipedia/commons/4/40/Badmington_Competition_EuroGames_2_2023_in_Wankdork%2C_Bern.webm" "$EURO"
  [[ -f "$DEMO" ]] || fetch "https://upload.wikimedia.org/wikipedia/commons/5/5f/Demonstratie_badminton.webm" "$DEMO"
fi
check_file "$WANG" "2500471d4852a4a73e0f4eb25ad28171b3c54967f58e1cc7620af16b46ccbb52" "China Open 2025 final (CC BY 3.0)" || true
check_file "$EURO" "4e5dab1eb80d83cdea16b2150034d4b3268ad3bc8273f32a0de44477b8cc0029" "EuroGames 2023 Bern (CC BY-SA 4.0)" || true
check_file "$DEMO" "86e7733cfbe160160eeb5d8a7bea2a8370f2c1698d8852404557c652c53070af" "Demonstratie badminton (public domain)" || true

echo "== Trimmed 15 s samples (H.264, no audio; frame rate as listed in the manifest)"
if [[ "$MODE" == "download" ]] && command -v ffmpeg >/dev/null 2>&1; then
  mkdir -p data/samples
  ffmpeg -v error -y -ss 150 -i "$WANG" -t 15 -vf fps=30 -an -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -movflags +faststart data/samples/sample-a-singles-rally.mp4
  ffmpeg -v error -y -ss 395 -i "$WANG" -t 15 -vf fps=30 -an -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -movflags +faststart data/samples/sample-b-fast-shuttle.mp4
  ffmpeg -v error -y -ss 40 -i "$EURO" -t 15 -vf fps=30 -an -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -movflags +faststart data/samples/sample-c-difficult-multicourt.mp4
  ffmpeg -v error -y -ss 50 -i "$DEMO" -t 15 -an -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -movflags +faststart data/samples/sample-d-demonstration.mp4
fi
for sample in sample-a-singles-rally sample-b-fast-shuttle sample-c-difficult-multicourt sample-d-demonstration; do
  if [[ -f "data/samples/$sample.mp4" ]]; then
    echo "OK       sample $sample.mp4"
  else
    echo "MISSING  sample $sample.mp4"
    FAILURES=$((FAILURES + 1))
  fi
done

if [[ "$MODE" == "download" ]]; then
  echo "== Manifests"
  python3 -I backend/tools/build_manifest.py
fi

if [[ "$FAILURES" -gt 0 ]]; then
  echo "$FAILURES item(s) missing or failed verification."
  exit 1
fi
echo "All listed files are present and verified."
