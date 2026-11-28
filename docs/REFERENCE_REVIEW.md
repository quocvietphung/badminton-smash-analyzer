# Reference review: licences and reuse decisions

Reviewed on 15 Nov 2026 with `gh api` (licence field and the LICENSE file). Code was read to understand the approach. No code was copied.

| Repository | Licence (verified) | What was read | Decision |
| --- | --- | --- | --- |
| `HAO-xianmi/badminton_analysis-system` | MIT | README and `src/` layout (`tracker.py`, `analyzer.py`, `calibrate.py`). Approach: YOLOv8 with ByteTrack through Ultralytics, homography calibration, rally distance. | Approach only. The Ultralytics runtime is AGPL-3.0, so it is not used. No code copied. |
| `m11ahmed/Badminton-Tracker` | MIT (LICENSE file) | Module list of `src/badminton_tracker/` (`court.py`, `court_detection.py`, `court_tracking.py`, `players.py`, `player_cache.py`) and `tests/test_court.py`. A TrackNetV3 copy is vendored in `vendor/tracknetv3`. | Approach only. No code copied. The vendored TrackNetV3 licence was not checked, so it is not reused. |
| `amramer/Badminton-VisionAI` | "All rights reserved" (LICENSE.txt: exclusive property, restrictions) | Licence only. | Not used. No code, weights or assets copied. |
| `hironaka-iori/BadmintonPoseAI` | MPL-2.0 (LICENSE). Built on YOLOv8 (Ultralytics, AGPL-3.0). | Licence only. | Not used. |

## What the studio uses

| Component | Source and licence | Use |
| --- | --- | --- |
| Player detection | YOLOX-s ONNX from opencv_zoo, Apache-2.0 | Person boxes (COCO class 0). This is a YOLO-family detector, not an Ultralytics package. |
| Shuttle tracking | TrackNetV3 checkpoints, MIT (qaz812345/TrackNetV3), exported to ONNX | Shuttle heatmaps and InpaintNet refinement. |
| Multi-object tracking | Own implementation of a ByteTrack-style two-stage association with constant-velocity Kalman prediction, described in the ByteTrack paper (Zhang et al., 2022). No ByteTrack code copied. | Temporary track IDs before identity logic. |
| Court geometry | Own implementation of the classical method in `court.py` and a manual four-corner fallback | Homography to the doubles template. |
| Offline pose | MediaPipe Tasks Vision, Apache-2.0 (studio modules kept) | Existing pose modules are kept. Backend pose is not yet implemented. |
| Match analytics | Own implementation in `backend/app/analytics/match.py`: contact candidates from shuttle turns near tracked players, rally boundaries, a speed gate and manual labels. No external code. | The match dashboard. Every output is marked as a candidate or unvalidated. |
| Shot classification | No trained model. The build has only own, narrow court-path rules and manual labels. | A short path ending near the net may be suggested as `net_shot`; long paths remain unknown. Every suggestion is `heuristic_unvalidated`. |

## Reviewed for speed and shot-type methods (15 Nov 2026)

Read from the repositories or papers listed. Code was read to understand the method. No code was copied.

| Source | Licence (verified) | What was read | Decision |
| --- | --- | --- | --- |
| `Va6lue/BST-Badminton-Stroke-type-Transformer` (BST, stroke classification) — **removed from SmashLab** | MIT (LICENSE opened and verified: Copyright 2025 Jing-Yuan Chang) | README: inputs are the shuttle trajectory, player skeleton and court position; output is stroke classes (18 to 35 depending on the dataset). Trained weights and training scripts are linked. | Approach only. Not used: the software licence is clear, but its trained weights depend on labelled datasets with separate terms and the classes have not been validated on SmashLab footage. No code or weights copied. | Decision: not used. Its checkpoint is not in the product, the Docker image, or the studio. The stroke labels come from the trajectory-rules/v1 estimate instead.
| `wywyWang/CoachAI-Projects` (ShuttleSet data, ShuttleNet forecasting) | MIT for the repository (LICENSE file read). The ShuttleSet data has no separate licence; the README asks for a citation (arXiv 2306.04948). | 18 shot classes; forecasting baseline. | Not used now. Confirm the data terms with the authors before any published training on it. |
| Huang, "A Real-Time, Vision-Based System for Badminton Smash Speed Estimation" (arXiv 2509.05334) | Paper CC BY 4.0. No code released. | Speed is pixel displacement times a metres-per-pixel scale, which the user sets from a line at the impact depth. Assumes a flight plane perpendicular to the camera. Reports MAE 66.4 km/h against a radar gun on 20 smashes. | Not used. The method is a 2D estimate from one camera and a manual scale; it is not valid for general shots. The build shows no speed. |

## Reviewed for the contact, shot-type and speed modules (16 Nov 2026)

| Source | Licence (verified) | What was read | Decision |
| --- | --- | --- | --- |
| `Harsh-184/Badminton-shot-tracking` | No licence found (no LICENSE file, no sidebar licence). | `src/main.py` and `src/utils/shuttle_tracker.py`: a contact is flagged when the shuttle candidate is within 25 px of a pose line, its speed is above 2 px per frame over a 5-frame window, and a 0.25 s cooldown has passed. Shuttle tracking uses MOG2 background subtraction. Its speed is pixel displacement, not physical speed. No tests, no evaluation numbers. | Idea only: a proximity gate, a motion gate and a cooldown as temporal filters. No code copied, nothing reused, because the licence is missing. SmashLab's detector is its own and reports image motion only as px/s. |
| `MaxLinCode/BaddieVision` | MIT (Copyright 2026 Max Lin). The README says the TrackNet component keeps its own licence and detector or pose assets keep upstream terms. | Directory and file names, `docs/independent-rally-segmenter.md` and LICENSE (individual source files were not read). The README reports rally segmentation with macro frame F1 0.718 and ROC AUC 0.890 on 126 rallies from a small private dataset, and states these are not a public benchmark. The shot classifier has no reported metrics. | Approach documentation only. No code, weights or metrics are reused. Their numbers are not evidence for SmashLab. Their TrackNet and asset licences must be checked separately before any reuse. |
| Huang et al., "Monocular Badminton Speed Estimation with Air Drag and Court Geometry" (arXiv 2611.00031) | Paper CC BY 4.0. No code released ("will be made publicly available"). No dataset licence; data only on request. | Equations and validation design: pinhole projection, gravity plus quadratic drag, RK4, robust nonlinear least squares, free-ray and net-plane parameterisations, multiple starts and sensitivity checks. 51 selected shots from two private 240 FPS sessions; 8.6% is against a drag-based stereo reference, not radar. | Scientific method only. SmashLab's implementation in `backend/app/physics/` is original and independently tested. No paper code, weights or data are used. The UI says not radar validated and rejects Sample A rather than quoting its exploratory candidate. |
| `jhwang7628/monotrack` (CVPR 2022) | Adobe Research License: noncommercial research restriction. | Monocular trajectory fitting methodology and camera/trajectory ambiguity. | Methodology only. No code, model or asset copied. Not a runtime dependency. |
| `samkang10/badminton-shuttlecock-simulator` | MIT. | README and numerical-verification approach: RK4/Euler checks, zero-drag/free-fall cases, terminal velocity and synthetic trajectories. | Validation ideas only; SmashLab uses its own RK4 and synthetic generator. No source file copied. |
| `Alexanderyk6/FreeTrack` | Commercial-use terms not verified. | Six-point calibration and geometric back-projection approach described by the project. | Methodology only. No code or weights copied. |
| Own: contact detector v2 (`backend/app/analytics/match.py`, `detect_contacts`) | Own implementation. | Turn angle over ±3 detected frames, step thresholds, proximity to tracked player boxes, de-duplication by score, and a rejection reason for every rejected turn. The score is a heuristic blend and is labelled uncalibrated. | Automatic candidates are shown with their evidence and rejection reasons, and marked unvalidated. They are never treated as confirmed contacts. |
| Own: heuristic shot types (`backend/app/analytics/shots.py`, model `heuristic-court-rules-v1`) | Own rules. Not a trained model; no weights. | Court-plane travel of the shuttle over 0.6 s after a contact. A short path ending near the net can be suggested as a net shot. Long travel is left unknown because one camera cannot safely separate clear from smash. | Labelled `heuristic_unvalidated`. Not a classifier, not a model, not measured accuracy. A person's label always overrides it. |
| Own: image-motion HUD (`backend/app/analytics/match.py`) | Own implementation. | Average path length of detected, non-interpolated shuttle points around a contact divided by elapsed time. | Reported only as px/s with frame/time evidence. Automatic candidates may show a value on the timeline; only confirmed contacts enter headline and per-player maxima. Never presented as km/h. |

## Decisions recorded 26 Nov 2026

| Reference | Licence (checked) | Decision |
|---|---|---|
| CourtKeyNet (`Cracked-ANJ/CourtKeyNet` on Hugging Face; code `adithyanraj03/CourtKeyNet`) | MIT: the model-card tag and the repository LICENSE file | Not downloaded. The weights `pretrained/courtkeynet_base.safetensors` (4.98 MB) need PyTorch on the host to export ONNX. Waiting for the owner's approval. |
| MediaPipe Pose Landmarker (`pose_landmarker_lite.task`, 5.8 MB from Google storage) and the `mediapipe` 1.2.3 package | Apache-2.0 for the package (PyPI metadata). The model file's licence is to be confirmed from its model card before any download. | Not downloaded. The package requires `opencv-contrib-python`, which conflicts with the pinned `opencv-python-headless`. Waiting for the owner's approval. |
| Ultralytics YOLO models, used by some reviewed repositories | AGPL-3.0 | Not used. |
| FreeTrack, shuttlesense, PenguinPush/goodminton | No licence file on GitHub | Not used. No code, weights or text copied. |
| BADGE | MIT (per the earlier review) | Not used. The Coach data report is written without a language model (`src/lib/ai/coach-report.ts`). |
| TrackNetV3 and YOLOX-s INT8 copies | Derived locally from the MIT TrackNetV3 and the Apache-2.0 YOLOX-s (opencv_zoo) models already on disk | Written by `backend/tools/quantize_int8.py`; nothing downloaded. FP32 stays the default. INT8 is opt-in and must agree with FP32 (`backend/tools/compare_precision.py`). |

## Reviewed for studio UI (28 Nov 2026, nightly)

| Source | Licence (checked) | What was read | Decision |
|---|---|---|---|
| `yo-WASSUP/Good-Badminton` | Apache-2.0 (README states code and ball weights; RTMPose/YOLOX weights keep upstream Apache-2.0) | README only (page fetch; the repository was not attached to this session). Gradio UI with court correction, overlays, rally numbers, `detections.jsonl`. No timeline view and no tests mentioned. | Approach only. No code copied. Its YOLO weights are not used. |
| `hobtech-0310/bad-match-annotator` | No LICENSE file found | README only. Frame stepping (1 and 5 frames), variable speed, shot list with jump and loop, JSON save/load. | Idea only (keyboard frame stepping). Nothing copied. SmashLab's `transportKeyAction` is its own code. |
