"""Rally candidates derived from contact sequences, with the evidence behind each one.

Why the old rule was wrong: a rally candidate was any run of *detected* shuttle frames whose gaps were at most one second.
TrackNet loses the shuttle for longer than that during fast exchanges and at the net, so one rally was often split in
two, while two rallies with a continuous shuttle track were merged into one. Contacts, not shuttle gaps, mark the shots
of a rally, so the rule now works on the contacts.

Rule (heuristic, not validated against ground truth):
- counted contacts are sorted by frame;
- a new rally starts when the gap between two consecutive counted contacts is longer than RALLY_CONTACT_GAP_S;
- a rally runs from its first contact minus PRE_ROLL_S to its last contact plus POST_ROLL_S, never overlapping the next rally;
- a rally with a single contact is "uncertain", because one contact cannot show a rally.

A shuttle gap inside a rally does not end it. Two rallies are not merged only because the shuttle stays visible: the
contact gap decides. Human rally boundaries (corrections) replace the derived candidates they overlap.
"""

from __future__ import annotations

from typing import Optional

METHOD = (
    "contact sequence v1 (heuristic): counted contacts split where the gap exceeds 2.5 s; boundaries are the first and "
    "last contact plus or minus 0.5 s; single-contact runs are uncertain. Not validated against ground truth."
)
RALLY_CONTACT_GAP_S = 2.5
PRE_ROLL_S = 0.5
POST_ROLL_S = 0.5
SUPERSEDE_OVERLAP = 0.5  # a derived candidate is superseded when a human boundary covers this share of it


def _detected_frames(shuttle_frames: list) -> set[int]:
    return {int(item["frame"]) for item in shuttle_frames if item.get("visible") and not item.get("refined")}


def derive_rallies(contacts: list, fps: float, shuttle_frames: list, total_frames: Optional[int] = None) -> list[dict]:
    """Rally candidates from counted contacts (dicts with frame, player, id, status). Returns items without ids."""
    if not contacts or not fps:
        return []
    ordered = sorted(contacts, key=lambda item: item["frame"])
    gap_limit = RALLY_CONTACT_GAP_S * fps
    groups: list[list[dict]] = [[ordered[0]]]
    for previous, current in zip(ordered, ordered[1:]):
        if current["frame"] - previous["frame"] > gap_limit:
            groups.append([current])
        else:
            groups[-1].append(current)

    detected = _detected_frames(shuttle_frames)
    pre = round(PRE_ROLL_S * fps)
    post = round(POST_ROLL_S * fps)
    derived: list[dict] = []
    for index, group in enumerate(groups):
        start = max(0, group[0]["frame"] - pre)
        end = group[-1]["frame"] + post
        if total_frames is not None:
            end = min(end, total_frames - 1)
        if index + 1 < len(groups):
            end = min(end, groups[index + 1][0]["frame"] - 1)
        window = max(1, end - start + 1)
        covered = sum(1 for frame in range(start, end + 1) if frame in detected)
        gaps = [(b["frame"] - a["frame"]) / fps for a, b in zip(group, group[1:])]
        players: dict[str, int] = {}
        for contact in group:
            if contact.get("player"):
                players[contact["player"]] = players.get(contact["player"], 0) + 1
        derived.append({
            "source": "contact_sequence",
            "status": "candidate" if len(group) >= 2 else "uncertain",
            "validated": False,
            "start_frame": start,
            "end_frame": end,
            "start_s": round(start / fps, 3),
            "end_s": round(end / fps, 3),
            "duration_s": round((end - start) / fps, 3),
            "contact_ids": [contact["id"] for contact in group],
            "contact_frames": [contact["frame"] for contact in group],
            "evidence": {
                "contacts": len(group),
                "max_gap_s": round(max(gaps), 3) if gaps else None,
                "shuttle_coverage": round(covered / window, 3),
                "players": players,
                "reason": (
                    "one contact only: a single contact does not show a rally" if len(group) < 2
                    else f"{len(group)} contacts with gaps of at most {round(max(gaps), 2)} s"
                ),
            },
        })
    return derived


def merge_with_human_boundaries(derived: list[dict], manual: list[dict], fps: float) -> list[dict]:
    """Human boundaries are confirmed. A derived candidate they cover by more than half is superseded and left out."""
    kept: list[dict] = []
    for candidate in derived:
        span = candidate["end_frame"] - candidate["start_frame"] + 1
        covered_by_human = any(
            max(0, min(candidate["end_frame"], item["end_frame"]) - max(candidate["start_frame"], item["start_frame"]) + 1) / span > SUPERSEDE_OVERLAP
            for item in manual
        )
        if not covered_by_human:
            kept.append(candidate)
    confirmed = [{
        **item,
        "status": "confirmed",
        "validated": True,
        "source": "manual",
        "contact_ids": item.get("contact_ids", []),
        "evidence": {"reason": "a person set this boundary", "contacts": None, "shuttle_coverage": None, "players": {}},
    } for item in manual]
    merged = kept + confirmed
    merged.sort(key=lambda item: item["start_frame"])
    for item in merged:
        item["start_s"] = round(item["start_frame"] / fps, 3)
        item["end_s"] = round(item["end_frame"] / fps, 3)
        item["duration_s"] = round((item["end_frame"] - item["start_frame"]) / fps, 3)
    return merged


def summarise(rallies: list[dict], shots_by_rally: dict[str, list[dict]], identities: tuple) -> dict:
    """Counts and statistics that the studio shows. Candidates and confirmed rallies are never mixed."""
    candidates = [item for item in rallies if item["status"] in ("candidate", "uncertain")]
    confirmed = [item for item in rallies if item["status"] == "confirmed"]
    countable = [item for item in rallies if item["status"] in ("candidate", "confirmed")]
    durations = [item["duration_s"] for item in countable]
    shots_per = [len(shots_by_rally.get(item["id"], [])) for item in countable]
    participation = {identity: 0 for identity in identities}
    for item in countable:
        present = {shot["player"] for shot in shots_by_rally.get(item["id"], []) if shot.get("player")}
        for identity in present:
            if identity in participation:
                participation[identity] += 1
    return {
        "candidates": sum(1 for item in candidates if item["status"] == "candidate"),
        "uncertain": sum(1 for item in candidates if item["status"] == "uncertain"),
        "confirmed": len(confirmed),
        "count": len(rallies),
        "mean_duration_s": round(sum(durations) / len(durations), 2) if durations else None,
        "longest_s": max(durations) if durations else None,
        "shots_per_rally_mean": round(sum(shots_per) / len(shots_per), 2) if shots_per else None,
        "player_participation": participation,
        "method": METHOD,
    }
