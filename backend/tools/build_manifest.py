"""Write data/manifest.json (sources and licences) and data/samples/manifest.json (API sample catalogue).

Run from the repository root:  python3 -I backend/tools/build_manifest.py
Reads files that already exist under data/. Downloads are done by scripts/download-test-data.sh.
Probes each media file with ffprobe and records size and SHA-256 so the manifest can be checked later.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
from datetime import datetime, timezone

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DATA = os.path.join(REPO, "data")

RAW_SOURCES = [
    {
        "id": "commons-china-open-2025-singles-final",
        "name": "China Open 2025 singles final, all-Chinese final (Wikimedia Commons)",
        "source_url": "https://commons.wikimedia.org/wiki/File:Wang_Zhiyi_triumph_in_all-Chinese_China_Open_finals_I_China_Open_2025.webm",
        "download_url": "https://upload.wikimedia.org/wikipedia/commons/2/2f/Wang_Zhiyi_triumph_in_all-Chinese_China_Open_finals_I_China_Open_2025.webm",
        "licence": "CC BY 3.0",
        "attribution": "Wikimedia Commons file 'Wang Zhiyi triumph in all-Chinese China Open finals I China Open 2025' (CC BY 3.0). Trimmed by SmashLab; not redistributed.",
        "raw_file": "raw/commons/Wang_Zhiyi_China_Open_2025_final.webm",
        "ground_truth": [],
        "used_for": ["sample-a-singles-rally", "sample-b-fast-shuttle"],
    },
    {
        "id": "commons-eurogames-2023-bern",
        "name": "EuroGames 2023 badminton competition, Bern (Wikimedia Commons)",
        "source_url": "https://commons.wikimedia.org/wiki/File:Badmington_Competition_EuroGames_2_2023_in_Wankdork,_Bern.webm",
        "download_url": "https://upload.wikimedia.org/wikipedia/commons/4/40/Badmington_Competition_EuroGames_2_2023_in_Wankdork%2C_Bern.webm",
        "licence": "CC BY-SA 4.0",
        "attribution": "Wikimedia Commons 'Badmington Competition EuroGames 2 2023 in Wankdork, Bern' (CC BY-SA 4.0). Trimmed derivative stays local; share-alike applies if redistributed.",
        "raw_file": "raw/commons/EuroGames_2023_Bern_competition.webm",
        "ground_truth": [],
        "used_for": ["sample-c-difficult-multicourt"],
    },
    {
        "id": "commons-demonstratie-badminton",
        "name": "Demonstratie badminton, archive footage (Wikimedia Commons)",
        "source_url": "https://commons.wikimedia.org/wiki/File:Demonstratie_badminton.webm",
        "download_url": "https://upload.wikimedia.org/wikipedia/commons/5/5f/Demonstratie_badminton.webm",
        "licence": "Public domain (per Commons file page)",
        "attribution": "Polygoon Hollands Nieuws archive footage, public domain per Commons.",
        "raw_file": "raw/commons/Demonstratie_badminton_public_domain.webm",
        "ground_truth": [],
        "used_for": ["sample-d-demonstration"],
        "note": "Sample D is trimmed from this file. The raw archive stays local and is not redistributed.",
    },
]

BLOCKED_SOURCES = [
    {
        "id": "tracknet-shuttlecock-trajectory-dataset",
        "name": "Shuttlecock Trajectory Dataset (TrackNet / TrackNetV2 badminton videos with ball labels)",
        "source_url": "https://hackmd.io/@TUIK/rJkRW54cU",
        "download_url": "SharePoint link listed on the page (redirects to a sign-in viewer for TrackNetV2.zip)",
        "licence": "not stated on the source page",
        "ground_truth": ["per-rally ball_trajectory CSV: Frame, Visibility, X, Y"],
        "status": "not downloaded",
        "blocker": "No anonymous direct download. The link redirects to a sign-in viewer and the archive is expected to be multi-GB. Access was not bypassed and no licence was stated, so no shuttle ground truth is available for this build.",
    },
    {
        "id": "kaggle-badminton",
        "name": "Kaggle badminton datasets",
        "status": "not used",
        "blocker": "No Kaggle credentials are configured on this machine; credentials were not requested or entered.",
    },
]

MODEL_SOURCES = [
    {
        "id": "tracknetv3",
        "name": "TrackNetV3 TrackNet and InpaintNet checkpoints (ONNX export)",
        "source_url": "https://github.com/qaz812345/TrackNetV3",
        "licence": "MIT (repository LICENSE covers code and pretrained checkpoints)",
        "checkpoint_archive": "TrackNetV3_ckpts.zip (Google Drive, public, 131.6 MB)",
        "export_report": "models/tracknetv3/tracknetv3_export.json",
    },
    {
        "id": "yolox-s",
        "name": "YOLOX-s object_detection_yolox_2022nov.onnx (opencv_zoo)",
        "source_url": "https://github.com/opencv/opencv_zoo/tree/main/models/object_detection_yolox",
        "licence": "Apache-2.0 (opencv_zoo model folder LICENSE; YOLOX by Megvii, Apache-2.0)",
        "file": "models/yolox/object_detection_yolox_2022nov.onnx",
    },
]

SAMPLES = [
    {
        "id": "sample-a-singles-rally",
        "title": "A · Singles rally, clear broadcast view",
        "scenario": "singles rally with a clear, stable camera view",
        "source": "commons-china-open-2025-singles-final",
        "source_start_s": 150,
        "file": "samples/sample-a-singles-rally.mp4",
        "ground_truth": [],
    },
    {
        "id": "sample-b-fast-shuttle",
        "title": "B · Rally with fast shuttle exchanges",
        "scenario": "rally with smashes and fast shuttle movement",
        "source": "commons-china-open-2025-singles-final",
        "source_start_s": 395,
        "file": "samples/sample-b-fast-shuttle.mp4",
        "ground_truth": [],
    },
    {
        "id": "sample-c-difficult-multicourt",
        "title": "C · Hard case: multi-court hall, small players",
        "scenario": "several courts in view, small players and shuttle, low resolution",
        "source": "commons-eurogames-2023-bern",
        "source_start_s": 40,
        "file": "samples/sample-c-difficult-multicourt.mp4",
        "ground_truth": [],
    },
    {
        "id": "sample-d-demonstration",
        "title": "D · Archive demonstration, black-and-white wide view",
        "scenario": "archive demonstration footage, black-and-white, wide camera with several players on court",
        "source": "commons-demonstratie-badminton",
        "source_start_s": 50,
        "file": "samples/sample-d-demonstration.mp4",
        "ground_truth": [],
        "reencoded": "H.264 yuv420p, 25 fps (native source rate), faststart, no audio",
    },
]


def sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def probe(path: str) -> dict:
    command = [
        "ffprobe",
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=codec_name,width,height,avg_frame_rate,nb_frames",
        "-show_entries",
        "format=duration",
        "-of",
        "json",
        path,
    ]
    out = subprocess.run(command, check=True, capture_output=True, text=True).stdout
    data = json.loads(out)
    stream = data["streams"][0]
    num, den = stream["avg_frame_rate"].split("/")
    fps = float(num) / float(den) if float(den) else 0.0
    return {
        "codec": stream.get("codec_name"),
        "width": int(stream["width"]),
        "height": int(stream["height"]),
        "fps": round(fps, 3),
        "frames": int(stream["nb_frames"]) if str(stream.get("nb_frames", "")).isdigit() else None,
        "duration_s": round(float(data["format"]["duration"]), 3),
    }


def main() -> int:
    generated = datetime.now(timezone.utc).isoformat()
    raw = []
    for source in RAW_SOURCES:
        path = os.path.join(DATA, source["raw_file"])
        entry = dict(source)
        if os.path.isfile(path):
            entry.update(probe(path))
            entry["bytes"] = os.path.getsize(path)
            entry["sha256"] = sha256_file(path)
            entry["status"] = "downloaded"
        else:
            entry["status"] = "missing"
        raw.append(entry)

    samples_api = []
    for sample in SAMPLES:
        path = os.path.join(DATA, sample["file"])
        source = next(s for s in RAW_SOURCES if s["id"] == sample["source"])
        entry = {
            "id": sample["id"],
            "title": sample["title"],
            "scenario": sample["scenario"],
            "file": sample["file"],
            "source_id": sample["source"],
            "source_url": source["source_url"],
            "source_start_s": sample["source_start_s"],
            "licence": source["licence"],
            "attribution": source["attribution"],
            "ground_truth": sample["ground_truth"],
            "trim": {
                "start_s": sample["source_start_s"],
                "duration_s": 15,
                "reencoded": sample.get("reencoded", "H.264 yuv420p, 30 fps, faststart, no audio"),
            },
        }
        if os.path.isfile(path):
            info = probe(path)
            entry.update({"width": info["width"], "height": info["height"], "fps": info["fps"], "duration_s": info["duration_s"], "codec": info["codec"], "frames": info["frames"]})
            entry["bytes"] = os.path.getsize(path)
            entry["sha256"] = sha256_file(path)
        samples_api.append(entry)

    dataset_manifest = {
        "schema": "smashlab.local-ai.dataset-manifest/v1",
        "generated_at": generated,
        "generated_by": "backend/tools/build_manifest.py",
        "ground_truth_available": False,
        "ground_truth_note": "No labelled shuttle or rally ground truth is available for the samples in this build. Shuttle precision, recall and coordinate error are therefore not reported.",
        "raw_sources": raw,
        "blocked_sources": BLOCKED_SOURCES,
        "models": MODEL_SOURCES,
        "samples": samples_api,
    }
    os.makedirs(os.path.join(DATA, "samples"), exist_ok=True)
    with open(os.path.join(DATA, "manifest.json"), "w", encoding="utf-8") as handle:
        json.dump(dataset_manifest, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
    api_manifest = {"schema": "smashlab.local-ai.manifest/v1", "generated_at": generated, "samples": samples_api}
    with open(os.path.join(DATA, "samples", "manifest.json"), "w", encoding="utf-8") as handle:
        json.dump(api_manifest, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
    print(f"wrote {os.path.join(DATA, 'manifest.json')} and {os.path.join(DATA, 'samples', 'manifest.json')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
