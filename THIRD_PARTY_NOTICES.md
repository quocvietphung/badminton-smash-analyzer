# Third-party notices

SmashLab is released under the MIT License (see [LICENSE](LICENSE)). It uses the components below. Each keeps its own
licence. Model files and sample videos are **not** stored in this repository. The download script fetches them from their
public sources and checks their SHA-256 before use.

## Code that was ported

`backend/app/ai/shuttle_tracking/tracknet.py` and `backend/app/ai/shuttle_tracking/inpaint.py` re-implement the
inference path of TrackNetV3 and use constants and steps from its reference code.

> MIT License, Copyright (c) 2024 qaz812345, https://github.com/qaz812345/TrackNetV3
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
> documentation files (the "Software"), to deal in the Software without restriction ... THE SOFTWARE IS PROVIDED "AS IS",
> WITHOUT WARRANTY OF ANY KIND ... (full text: https://raw.githubusercontent.com/qaz812345/TrackNetV3/master/LICENSE)

## Models (downloaded, not included)

| Model | Source | Licence | Used for |
|---|---|---|---|
| TrackNetV3 TrackNet and InpaintNet checkpoints, exported to ONNX | https://github.com/qaz812345/TrackNetV3 | MIT | Shuttle detection and refinement |
| YOLOX-s (`object_detection_yolox_2022nov.onnx`) | https://github.com/opencv/opencv_zoo | Apache-2.0 | Person detection |

Models and checkpoints are not redistributed by this project. Check the upstream licence before any commercial use.

## Libraries (runtime)

| Library | Licence |
|---|---|
| Next.js, React, React DOM | MIT |
| AI SDK (`ai`, `@ai-sdk/react`, `@ai-sdk/azure`) | Apache-2.0 |
| MediaPipe Tasks Vision (`@mediapipe/tasks-vision`) | Apache-2.0 |
| FastAPI, Uvicorn | MIT |
| ONNX Runtime | MIT |
| OpenCV (headless) | Apache-2.0 |
| NumPy | BSD-3-Clause |
| Pillow | MIT-CMU (HPND) |
| imageio-ffmpeg | BSD-2-Clause, but the bundled ffmpeg is built with libx264 (GPL-2.0). See note below. |

The full list of direct dependencies is in `package.json`, `package-lock.json` and `backend/requirements*.txt`.

## Note on the video encoder

The backend container writes the annotated MP4 with the static ffmpeg binary from `imageio-ffmpeg`, which includes the
libx264 encoder (GPL-2.0). This repository does not ship that binary, and the Dockerfile fetches it at build time. Anyone
who redistributes a built container image must comply with the GPL for that binary.

## Sample videos (downloaded, not included)

The four test clips are downloaded from Wikimedia Commons by `scripts/download-test-data.sh`. They are trimmed for
testing and are not redistributed here.

| Sample | Licence | Required attribution |
|---|---|---|
| A · Singles rally, clear broadcast view | CC BY 3.0 | Wikimedia Commons: "Wang Zhiyi triumph in all-Chinese China Open finals I China Open 2025" |
| B · Rally with fast shuttle exchanges | CC BY 3.0 | Wikimedia Commons: same source as A |
| C · Hard case: multi-court hall | CC BY-SA 4.0 | Wikimedia Commons: "Badmington Competition EuroGames 2 2023 in Wankdork, Bern". Any redistributed derivative must also be CC BY-SA 4.0. |
| D · Archive demonstration | Public domain | Polygoon Hollands Nieuws archive footage, public domain per Commons |

The records are in `data/manifest.json` after the download script runs.

## Research references

The approaches in `docs/REFERENCE_REVIEW.md` were read for ideas only. No code from those repositories is included.
