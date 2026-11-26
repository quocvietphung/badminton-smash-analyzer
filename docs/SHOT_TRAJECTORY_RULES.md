# Shot estimate: trajectory-rules/v2

Status: **automatic estimate, unverified.** Labels from this rule set are "Trajectory estimate · unverified". They are not
ground truth, they have not been evaluated against labelled data, and they do not come from a trained model.

v2 keeps every membership, weight, tier and gate of v1. Only the input changed: v1 read the raw shuttle file and dropped
steps above a fixed 5000 px/s; v2 reads the shared **observed-2d/v1** track (see
[SHOT_DASHBOARD_CALCULATIONS.md](SHOT_DASHBOARD_CALCULATIONS.md)), the same track the contact candidates, the dataset,
the speed monitor, the dashboard and the charts use.

## What it reads

For each contact candidate on the Shot timeline, from one analysis only (`outputs/<job-id>/`):

- The observed-2d/v1 track of `shuttle_trajectory.json` (the raw TrackNetV3 / InpaintNet output is read, never written):
  - TrackNet detections ("detected") and InpaintNet fills ("interpolated") are kept apart;
  - points outside the frame, without coordinates or (detections only) below confidence 0.5 are rejected with the reason;
  - tracker jumps (an excursion of up to 3 points that leaves faster than 2.25 frame diagonals per second and returns)
    are rejected with the reason; a fast step without a return is kept but ends the run and is never a speed;
  - durations use the video's presentation timestamps when the file has them, otherwise the frame rate.
- The match document of the same job: contact frames, player identity, and player foot positions on the floor plane
  (metres) when the court calibration is valid. The shuttle is never mapped to floor metres.

## Evidence tiers

The same scorer runs for all three tiers. The tier decides only the available features and the evidence quality.

- `full_trajectory`: at least 6 detections in the 12 frames before the contact and 12 in the 45 frames after.
- `partial_trajectory`: at least 3 detections in total, some features available.
- `contact_fallback`: only the local window (±6 frames). Needs at least two points in the window, a usable local speed and
  a direction. Otherwise the contact is an integrity error (`shot_trajectory_insufficient_data`): the dataset build stops
  and the job is not marked complete. There is no default label.

## Features

Speeds are image pixels per second. A speed step joins two consecutive TrackNet detections of one run at most 2 frames
apart; positions for speeds are averaged over 3 consecutive frames of the same source and run (never across a gap, a
rejected point or a run boundary). Geometry (direction, apex, rise, descent, length, straightness, curvature) uses the
unsmoothed positions. Relative speeds divide by the video's 95th percentile of valid step speeds. Positions are
normalised by the frame size. No km/h is derived.

Speed before and after the contact (median and maximum), speed change ratio, initial velocity, horizontal and vertical
components, initial direction (up, down, level, left, right), apex time, rise and descent (normalised), vertical and
horizontal travel, trajectory length, straightness, curvature (mean heading change per step, radians), observed flight
duration (a run of 4 or more missing frames ends it), detected and interpolated ratios, tracker jumps removed and
implausible steps in the window, missing runs, player-to-net distance and player side (court calibrated only).

## Rules

Each class score is the weighted mean of the memberships of its available features (missing features are left out and
listed). The six scores are then divided by their sum, so they add to one. They are **rule shares**, not calibrated
probabilities. Ties are broken by the fixed class order.

| Class | Main features and direction |
|---|---|
| smash | fast after contact, descending, straight, short flight, early apex, player far from net |
| clear | clear rise, late apex, long flight, slower after contact, player at the back |
| drop | strong deceleration, moderate speed after contact, short descent near the net |
| drive | fast and nearly horizontal, straight, little vertical travel, low curvature |
| net_shot | player near the net, slow, small rise, short flight, short trajectory |
| lift | player in front court, clear rise, late apex, moderate speed, longer flight |

The weights and thresholds are in `backend/app/analytics/trajectory_rules.py` (`RULES`, `CONFIG`) and are part of the
rule version. The sanitizer settings are `observed2d.Config`. Changing either means a new version.

`CONFIG` holds only values the code uses. v1's unused `accept_min_valid_ratio` (0.6) was removed; the evidence quality
thresholds that were written inline are now named: `high_quality_min_valid_ratio` 0.7,
`high_quality_max_interpolated_ratio` 0.2 and `medium_partial_min_valid_ratio` 0.3.

## Review status

`accepted_by_gate` requires all of: contact confirmed by a person, full trajectory, high evidence quality, a margin of
at least 0.08 between the best and second class, and the same label at contact −2, 0 and +2 frames. Anything else is
`needs_review` with the reasons. Most candidates are not confirmed contacts, so most stay `needs_review`.

## Outputs

Per analysis, under `outputs/<job-id>/derived/` only:

- `shot_trajectory_dataset.jsonl` (schema `smashlab.shot-trajectory/v2`): one record per Shot timeline row, with the
  job id, run id, rule and sanitizer versions, shot id and timeline row id, frame, timestamp, player, contact status,
  the best-guess label, the label the timeline shows and its source, tier, quality, review status, all six scores, top 3,
  margin, features, missing features, reasons, warnings, the kept points before and after (with source and run), the
  points the sanitizer rejected in the window (with the reason), the tracking checks, the window counts, the
  detected/interpolated ratios, the image-space speed (px/s, the same value as the timeline row), and court context.
- `shot_trajectory_summary.json`: counts and distributions for that run, the sanitizer summary, the quality gates that
  passed and the duration of every derived stage.
- `estimated_3d.json` and `measured_3d.json`: the two 3D tiers, kept apart from this 2D dataset.
- `sensitivity/sensitivity_summary.json`: smoothing 1/3/5 × confidence 0.3/0.5/0.7 (from `tools/shot_trajectory_sensitivity.py`).

Raw outputs, `analysis.json`, `shots.json`, `model_execution.json` and `corrections.json` are never written by this path.
Before a job is marked complete, the worker checks that every timeline row matches exactly one record on shot id, frame,
timestamp, player, contact status, label, px/s and quality, that every label is one of the six classes, and that no
px/s uses a rejected frame; a failure stops the job with the reason.

## Not evaluated

No human-labelled ground truth covers the six classes for these videos. No accuracy, F1 or confusion matrix on real video
is reported. The synthetic fixtures test the algorithm only and are never shown as video results.
