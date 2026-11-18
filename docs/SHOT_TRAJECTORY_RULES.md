# Shot estimate: trajectory-rules/v1

Status: **automatic estimate, unverified.** Labels from this rule set are "Trajectory estimate · unverified". They are not
ground truth, not validated statistics, and not a trained model.

## What it reads

For each contact candidate on the Shot timeline, from one analysis only (`outputs/<job-id>/`):

- `shuttle_trajectory.json`: the raw TrackNetV3 / InpaintNet output. Read only.
- The match document of the same job: contact frames, player identity, and player foot positions on the floor plane
  (metres) when the court calibration is valid. The shuttle is never mapped to floor metres.

## Evidence tiers

The same scorer runs for all three tiers. The tier decides only the available features and the evidence quality.

- `full_trajectory`: at least 6 measured points in the 12 frames before the contact and 12 in the 45 frames after.
- `partial_trajectory`: at least 3 measured points in total, some features available.
- `contact_fallback`: only the local window (±6 frames). Needs at least two points in the window and a usable local speed
  and direction. Otherwise the contact is an integrity error (`shot_trajectory_insufficient_data`): the dataset build stops
  and the job is not marked complete. There is no default label.

Measured points are visible, not refined and above the confidence threshold (0.5). Interpolated points (InpaintNet) are
counted apart.

## Features

Speeds are image pixels per second. Relative speeds divide by the video's 95th percentile of measured speeds.
Positions are normalised by the frame size. No km/h is derived.

Speed before and after the contact (median and maximum), speed change ratio, initial velocity, horizontal and vertical
components, initial direction (up, down, level, left, right), apex time, rise and descent (normalised), vertical and
horizontal travel, trajectory length, straightness, curvature (mean heading change per step, radians), observed flight
duration, valid and interpolated ratios, missing runs, player-to-net distance and player side (court calibrated only).

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
rule version. Changing them means a new rule version.

## Review status

`accepted_by_gate` requires all of: contact confirmed by a person, full trajectory, high evidence quality, a margin of
at least 0.08 between the best and second class, and the same label at contact −2, 0 and +2 frames. Anything else is
`needs_review` with the reasons. Most candidates are not confirmed contacts, so most stay `needs_review`.

## Outputs

Per analysis, under `outputs/<job-id>/derived/` only:

- `shot_trajectory_dataset.jsonl`: one record per Shot timeline row, with the job id, run id, rule version, frame, time,
  player, the best-guess label, tier, quality, review status, scores, top 3, features, missing features, reasons,
  trajectory points before and after, and court context.
- `shot_trajectory_summary.json`: counts and distributions for that run.
- `sensitivity/sensitivity_summary.json`: smoothing 1/3/5 × confidence 0.3/0.5/0.7 (from `tools/shot_trajectory_sensitivity.py`).

Raw outputs, `analysis.json`, `shots.json`, `model_execution.json` and `corrections.json` are never written by this path.

## Not evaluated

No human-labelled ground truth covers the six classes for these videos. No accuracy, F1 or confusion matrix on real video
is reported. The synthetic fixtures test the algorithm only and are never shown as video results.
