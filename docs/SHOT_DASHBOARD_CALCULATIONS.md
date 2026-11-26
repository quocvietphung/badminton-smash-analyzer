# Shot and dashboard calculations (current build)

Shot labels and contact candidates are unvalidated on real match footage. See [SHOT_TRAJECTORY_RULES.md](SHOT_TRAJECTORY_RULES.md)
for the six-class rule engine and [EXPERIMENTAL_3D_SPEED.md](EXPERIMENTAL_3D_SPEED.md) for the 3D tiers and synthetic tests.

## 1. Three tiers, kept apart

| Tier | What it is | Where | Units |
|---|---|---|---|
| Observed 2D | TrackNetV3 detections and InpaintNet fills after the shared sanitizer | match document, `derived/shot_trajectory_dataset.jsonl` | image pixels, px/s |
| Estimated 3D — monocular experimental | one-camera flight fit with gravity and drag; "available" only when every gate passes | `shot.estimated_3d`, `derived/estimated_3d.json` | metres, km/h (only when available) |
| Measured 3D — stereo | triangulation from two synchronised, calibrated cameras | `shot.measured_3d`, `derived/measured_3d.json` | NOT RUN without stereo input |

No 2D number is ever converted to m/s or km/h. km/h exists only inside an available Estimated 3D result (or a future
Measured 3D result), never from px/s.

## 2. The shared Observed 2D track (`backend/app/analytics/observed2d.py`, observed-2d/v1)

One function, `sanitize()`, builds the track every 2D consumer uses: contact candidates, trajectory-rules, the dataset,
the speed monitor, the dashboard summary, the trajectory charts, the shuttle trail drawn into the annotated video and
the pipeline's rally candidates. The raw file is only read.

| Step | Rule |
|---|---|
| Invalid points | visible without coordinates → rejected `missing_coordinates`; outside the frame → `outside_frame`; TrackNet confidence below 0.5 → `low_confidence` (InpaintNet fills have no detection confidence and are kept as fills) |
| Detected vs interpolated | TrackNet detection = `detected`; InpaintNet fill (`refined`) = `interpolated`. Only detected-to-detected steps are speeds |
| Tracker jumps | a step faster than 2.25 frame diagonals per second (about 4960 px/s at 1080p, 2480 px/s at 540p) whose track returns within 3 points: the excursion points are rejected `tracker_jump` with the entry step, the return frame and the limit |
| Implausible step | the same speed without a return: the point is kept, the step is recorded and ends the run; it is never a speed |
| Short gaps | a run continues across at most 3 missing frames; a speed step spans at most 2 frames |
| Controlled smoothing | for speeds only: centred 3-frame mean of consecutive points of the same source and run; never across a gap, a rejected point or a run end |
| Time | presentation timestamps of the video when the file has them, else frame / fps; every point keeps its frame and timestamp |

Image-space speed of a contact: the total length of the valid steps between TrackNet detections within ±3 frames,
divided by their total duration; at least 4 detections and 2 valid steps, otherwise unavailable with the reason.

Tracking checks (computed on the backend, shown in the panel): a constant x or y for 8+ frames while the other axis moves
at least 0.0136 diagonal (about 30 px at 1080p), a repeated position (named TrackNet, InpaintNet or mixed), a removed
tracker jump, and an implausible step. Each check states how many points are TrackNet and how many InpaintNet.

## 3. Before and after

| Number | Before (v1 build) | Now |
|---|---|---|
| Contact candidates | turns of the raw shuttle file | turns of the sanitized track; a removed tracker jump can never become a contact |
| Shot speed (px/s) | path ÷ elapsed over raw detections within ±3 frames, no jump cap | valid steps only (§2); 101→102 and 103→104 excursions of sample A are removed (4649 px/s before, 133 px/s now) |
| Rule speeds | raw steps, fixed 5000 px/s cap, steps with InpaintNet points included | valid detected steps of the sanitized track, limit normalised by the frame diagonal |
| Top / Avg speed per player | max / mean over all shots, candidates included | backend `official_speed`: confirmed contacts only; candidates reported apart |
| Speed records, Avg speed | all shots | official: confirmed contacts only; the candidate count is shown apart and never mixed in |
| Most frequent shot | manual label else estimate, shown as a statistic without a label | the most frequent `best_guess_label`, labelled "Trajectory estimate · unverified" |
| Contact positions | shuttle image coordinates drawn on a court box labelled "court metres" | calibrated: the hitting player's foot in floor metres; uncalibrated: the shuttle's image position in an image-shaped box |
| Player distance | dashboard: 12 m/s, no smoothing, 15 Hz samples; backend: 8 m/s with 7-frame smoothing | one backend formula for the number and the chart: 7-frame smoothing, steps of at most 3 frames, 8 m/s on the floor (or 0.5 frame diagonals per second in image pixels); the chart is rounded to the summary's precision (0.01), so its last value is the summary value |
| Evaluation panel, shots | "Unsupported in this build" (raw pipeline status) | "Trajectory estimates · unverified", with "not evaluated (no ground truth)" |
| Avg time between contacts | all consecutive shots, rally gaps included | consecutive shots inside the same rally candidate only |
| Tracking warnings | computed in the browser from the raw file, sources not named | computed on the backend from the sanitized track, TrackNet and InpaintNet named apart |
| Annotated video trail | the last 8 visible raw points, removed jumps included | the last 8 points the sanitized track kept; a rejected point is not drawn as the shuttle; the trail restarts where the track's run breaks |
| Evidence viewer trail | raw visible points of the last 60 frames | the annotated-video trail rebuilt from the backend's `observed_2d` points (same rule) |
| Video Analysis shuttle chart | raw detections and InpaintNet fills, jumps joined into the line; raw step 95th percentile shown | the sanitized track (TrackNet solid, InpaintNet dashed, removed points as crosses); kept and removed counts shown apart from the raw coverage; the raw step percentile is no longer shown |
| Rally candidates (`rallies.json`) | runs of raw TrackNet detections, times frame / fps | runs of the TrackNet detections the sanitized track kept, times from the track's timestamps |
| Physical speed | `physical_speed` (gated) | `estimated_3d` with the spec schema and a sensitivity range; `measured_3d` NOT RUN |

## 4. Contacts, shots and labels (`backend/app/analytics/match.py`)

- Contact candidates: a turn of at least 75 degrees over ±3 sanitized points (each side at least 6 px), a tracked player
  within 0.6 box heights, de-duplicated within 0.3 s; score is a heuristic, not a probability.
- A person can confirm, reject or add a contact; earlier corrections of the same video move to a new analysis only when a
  candidate lies within 0.5 s and the player agrees.
- Every timeline row gets exactly one six-class `best_guess_label` from trajectory-rules/v2. A person's six-class label
  wins and is marked as a person's label. A person's "unknown" or a legacy label (serve, push, defensive block) is kept as
  a note; the row keeps its six-class estimate.

## 5. The dashboard (backend `dashboard` block, displayed by `src/lib/match/dashboard-view.ts`)

The studio computes nothing. It copies:

- per player: contacts, confirmed contacts, official max and mean image-space speed (confirmed only), distance with its
  unit and basis, most frequent estimate (labelled unverified);
- speed panel: official count, mean and max, candidate count and mean (apart), rally mean duration, shot interval within
  rallies;
- distance chart: the cumulative series of the same distance formula; its last value equals the summary distance;
- contact positions: feet in floor metres (calibrated) or shuttle image positions (uncalibrated).

## 6. Quality gates before a job completes

The worker checks, and stops the job with the reason when one fails: one dataset record per timeline row; equal shot id,
timeline id, frame, timestamp, player, contact status, label, px/s and quality; six-class labels only; timestamps equal the
video timestamps; no px/s uses a rejected frame; the official speed summary equals the confirmed rows. The same checks run
again in `backend/tools/validate_outputs.py` during `scripts/run-local-test.sh`.

## 7. Not calculated

No km/h from pixels. No shuttle height from one camera without an independent 3D calibration. No racket-contact
measurement. No accuracy, precision or F1 (no ground truth). No rally winner. No face recognition: identities are
logical, P1 to P4.

## 8. Where the code is

- `backend/app/analytics/observed2d.py`: the sanitizer, speeds, tracking checks.
- `backend/app/analytics/trajectory_rules.py`: trajectory-rules/v2.
- `backend/app/analytics/match.py`: contacts, shots, speeds, distances, summary, dashboard block.
- `backend/app/services/shot_dataset.py`: the v2 dataset.
- `backend/app/services/match_document.py`: one track per job, the 3D files, the quality gates.
- `backend/app/physics/speed3d.py`, `camera.py`, `trajectory.py`: Estimated 3D.
- `backend/app/physics/stereo.py`: Measured 3D (interface and algorithms; synthetic tests only).
- `src/lib/match/dashboard-view.ts`, `src/lib/match/shot-trajectory.ts`, `src/lib/match/observed-path.ts`: display only.
- `backend/app/pipeline/derive.py`, `runner.py`: the annotated-video trail and the rally candidates read the same track.
- Tests: `backend/tests/test_observed2d.py`, `test_dashboard_parity.py`, `test_speed3d.py`, `test_stereo.py`,
  `test_trajectory_rules.py`, `test_match_analytics.py`, `test_derive.py`; `tests/match-dashboard.test.ts`,
  `tests/shot-trajectory.test.ts`.
