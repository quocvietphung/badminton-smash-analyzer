"""Logical player identities (Player 1 to 4) on top of temporary tracker IDs.

Identities come from court position, motion continuity and body appearance (upper-body colour histogram).
Body appearance is not face recognition. The rules are deliberately conservative:

- An identity is never reassigned silently. A doubtful match is marked "uncertain" and nothing is changed.
- A suspected exchange of two identities is logged as "identity_switch_suspected" and both identities become uncertain.
- A lost identity holds its last position and does not extrapolate motion. It is recovered only when a candidate
  lies inside a gate that widens with the time it was lost.
- A manual correction is a forced assignment for one tracker ID. It overrides the automatic decision in its interval.
- Every event is logged with its frame so that the evidence viewer can seek to it.

Confidence values are heuristic association scores. They are not measured model accuracy.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Sequence

import numpy as np

from app.ai.player_detection.bytetrack import hungarian

INFEASIBLE = 1e6


@dataclass(frozen=True)
class Candidate:
    frame: int
    track_id: int
    box: tuple[float, float, float, float]
    score: float
    confirmed: bool
    position: tuple[float, float]
    appearance: Optional[np.ndarray] = None


@dataclass
class IdentityState:
    frame: int
    identity: str
    track_id: Optional[int]
    box: Optional[tuple[float, float, float, float]]
    score: Optional[float]
    confidence: float
    status: str  # matched | recovered | uncertain | lost | manual | not_initialised


@dataclass
class IdentityEvent:
    frame: int
    kind: str
    identity: str
    track_id: Optional[int]
    confidence: Optional[float]
    message: str

    def as_dict(self, fps: float) -> dict:
        return {
            "frame": self.frame,
            "time_s": round(self.frame / fps, 3) if fps else None,
            "kind": self.kind,
            "identity": self.identity,
            "track_id": self.track_id,
            "confidence": None if self.confidence is None else round(self.confidence, 4),
            "message": self.message,
        }


@dataclass
class IdentityConfig:
    players: int = 2
    gate: float = 1.5
    net_y: Optional[float] = None  # net line in position space (metres when calibrated); None without calibration
    accept_cost: float = 1.2
    appearance_weight: float = 0.5
    ambiguity_margin: float = 0.12
    lost_event_after: int = 5
    init_frames: int = 10
    init_timeout_frames: int = 240
    velocity_smoothing: float = 0.5
    # Court positions come from the lower edge of a person box, which jitters between frames. The identity keeps a
    # smoothed position (weight of each new observation) and caps its speed, as a fraction of the gate per frame.
    position_smoothing: float = 0.5
    max_speed_fraction: float = 0.15


@dataclass
class _Identity:
    key: str
    position: np.ndarray
    velocity: np.ndarray
    last_frame: int
    track_id: Optional[int] = None
    misses: int = 0
    appearance: Optional[np.ndarray] = None
    side: Optional[str] = None
    lost_reported: bool = False
    uncertain_reported: bool = False


def appearance_similarity(a: Optional[np.ndarray], b: Optional[np.ndarray]) -> float:
    if a is None or b is None:
        return 0.5
    return float(np.minimum(a, b).sum())


def _identity_keys(players: int) -> list[str]:
    return [f"P{i}" for i in range(1, players + 1)]


class IdentityManager:
    def __init__(self, config: IdentityConfig) -> None:
        if config.players not in (2, 4):
            raise ValueError("players must be 2 (singles) or 4 (doubles)")
        self.config = config
        self.keys = _identity_keys(config.players)
        self.identities: dict[str, _Identity] = {}
        self.events: list[IdentityEvent] = []
        self._init_buffer: dict[int, list[Candidate]] = {}
        self._initialised = False
        self._first_frame: Optional[int] = None
        self._last_identity_for_track: dict[int, str] = {}
        self._last_track_for_identity: dict[str, int] = {}

    # ------------------------------------------------------------------ helpers
    def _side(self, y: float) -> str:
        if self.config.net_y is not None:
            return "near" if y < self.config.net_y else "far"
        return "near" if y >= self._image_reference_y else "far"

    def _log(self, frame: int, kind: str, identity: str, track_id: Optional[int], confidence: Optional[float], message: str) -> None:
        self.events.append(IdentityEvent(frame, kind, identity, track_id, confidence, message))

    def _initialise(self, frame: int) -> None:
        counts: dict[int, int] = {}
        latest: dict[int, Candidate] = {}
        for candidates in self._init_buffer.values():
            for candidate in candidates:
                counts[candidate.track_id] = counts.get(candidate.track_id, 0) + 1
                latest[candidate.track_id] = candidate
        chosen = sorted(counts, key=lambda tid: (-counts[tid], tid))[: self.config.players]
        picked = [latest[tid] for tid in chosen]
        if self.config.net_y is None:
            self._image_reference_y = float(np.median([c.position[1] for c in picked]))
        near = sorted([c for c in picked if self._side(c.position[1]) == "near"], key=lambda c: c.position[0])
        far = sorted([c for c in picked if self._side(c.position[1]) == "far"], key=lambda c: c.position[0])
        if self.config.players == 2:
            ordered = (near[:1] + far[:1])
        else:
            ordered = near[:2] + far[:2]
        for key, candidate in zip(self.keys, ordered):
            identity = _Identity(
                key=key,
                position=np.asarray(candidate.position, dtype=np.float64),
                velocity=np.zeros(2),
                last_frame=frame,
                track_id=candidate.track_id,
                appearance=candidate.appearance,
                side=self._side(candidate.position[1]),
            )
            self.identities[key] = identity
            self._last_identity_for_track[candidate.track_id] = key
            self._last_track_for_identity[key] = candidate.track_id
            self._log(frame, "identity_initialised", key, candidate.track_id, 1.0, f"{key} initialised on track {candidate.track_id}")
        self._initialised = True

    def _state(self, frame: int, key: str, status: str, candidate: Optional[Candidate], confidence: float) -> IdentityState:
        if candidate is None:
            return IdentityState(frame, key, None, None, None, confidence, status)
        return IdentityState(frame, key, candidate.track_id, candidate.box, candidate.score, confidence, status)

    # --------------------------------------------------------------- main step
    def step(self, frame: int, candidates: Sequence[Candidate], forced: Optional[dict[int, str]] = None) -> list[IdentityState]:
        """Assign identities for one frame. ``forced`` maps a tracker ID to an identity (manual corrections)."""
        forced = forced or {}
        confirmed = [c for c in candidates if c.confirmed]
        if self._first_frame is None:
            self._first_frame = frame

        if not self._initialised:
            self._init_buffer[frame] = confirmed
            recent = sorted(self._init_buffer)[-self.config.init_frames :]
            ready = len(recent) == self.config.init_frames and all(
                len({c.track_id for c in self._init_buffer[f]}) >= self.config.players for f in recent
            )
            timed_out = frame - self._first_frame >= self.config.init_timeout_frames and any(self._init_buffer[f] for f in recent)
            if ready or timed_out:
                self._initialise(frame)
            else:
                return [self._state(frame, key, "not_initialised", None, 0.0) for key in self.keys]

        # Predict every identity from its last position and velocity.
        predicted: dict[str, np.ndarray] = {}
        for key, identity in self.identities.items():
            steps = max(1, frame - identity.last_frame)
            predicted[key] = identity.position + identity.velocity * steps

        states: dict[str, IdentityState] = {}
        taken_tracks: set[int] = set()
        assigned_now: dict[str, Candidate] = {}

        # 1. Manual corrections are forced assignments.
        by_track = {c.track_id: c for c in confirmed}
        for track_id, key in forced.items():
            candidate = by_track.get(track_id)
            if candidate is None or key not in self.keys:
                continue
            identity = self.identities.get(key)
            if identity is None:
                identity = _Identity(key, np.asarray(candidate.position), np.zeros(2), frame, appearance=candidate.appearance)
                self.identities[key] = identity
            self._commit(frame, key, candidate, confidence=1.0, status="manual", recovered=False)
            assigned_now[key] = candidate
            taken_tracks.add(track_id)
            states[key] = self._state(frame, key, "manual", candidate, 1.0)

        # 2. Hungarian matching for the remaining identities, gated by distance and appearance.
        free_keys = [k for k in self.keys if k in self.identities and k not in assigned_now and k not in forced.values()]
        free_candidates = [c for c in confirmed if c.track_id not in taken_tracks]
        if free_keys and free_candidates:
            cost = np.full((len(free_keys), len(free_candidates)), INFEASIBLE)
            for i, key in enumerate(free_keys):
                identity = self.identities[key]
                gate = self.config.gate * min(3.0, 1.0 + 0.2 * identity.misses)
                for j, candidate in enumerate(free_candidates):
                    distance = float(np.linalg.norm(predicted[key] - np.asarray(candidate.position)))
                    if distance > gate:
                        continue
                    similarity = appearance_similarity(identity.appearance, candidate.appearance)
                    cost[i, j] = distance / gate + self.config.appearance_weight * (1.0 - similarity)
            # A candidate claimed by two identities with almost equal costs is ambiguous: neither identity is
            # assigned to it silently, and both are marked uncertain.
            ambiguous_keys: set[str] = set()
            for j in range(len(free_candidates)):
                column = cost[:, j]
                feasible = np.sort(column[column < INFEASIBLE])
                if len(feasible) >= 2 and feasible[0] <= self.config.accept_cost and feasible[1] - feasible[0] < self.config.ambiguity_margin:
                    for i in np.where((column < INFEASIBLE) & (column <= feasible[1]))[0]:
                        ambiguous_keys.add(free_keys[int(i)])
            for key in sorted(ambiguous_keys):
                identity = self.identities[key]
                states[key] = self._state(frame, key, "uncertain", None, 0.3)
                if not identity.uncertain_reported:
                    self._log(frame, "identity_uncertain", key, None, 0.3, f"{key}: candidates compete with almost equal scores")
                    identity.uncertain_reported = True
            pairs = hungarian(cost)
            for i, j in pairs:
                best = cost[i, j]
                if best >= INFEASIBLE or best > self.config.accept_cost:
                    continue
                key = free_keys[i]
                if key in ambiguous_keys:
                    continue
                candidate = free_candidates[j]
                others = np.sort(cost[i][cost[i] < INFEASIBLE])
                second = float(others[1]) if len(others) > 1 else None
                if second is not None and second - best < self.config.ambiguity_margin:
                    identity = self.identities[key]
                    states[key] = self._state(frame, key, "uncertain", None, 0.3)
                    if not identity.uncertain_reported:
                        self._log(frame, "identity_uncertain", key, None, 0.3, f"{key}: two candidates score almost equally")
                        identity.uncertain_reported = True
                    continue
                previous_owner = self._last_identity_for_track.get(candidate.track_id)
                if previous_owner not in (None, key) and self.identities[previous_owner].track_id == candidate.track_id:
                    self._log(frame, "identity_switch_suspected", key, candidate.track_id, 0.3,
                              f"track {candidate.track_id} belongs to {previous_owner}; no reassignment made")
                    states[key] = self._state(frame, key, "uncertain", None, 0.3)
                    states[previous_owner] = self._state(frame, previous_owner, "uncertain", None, 0.3)
                    self.identities[key].uncertain_reported = self.identities[previous_owner].uncertain_reported = True
                    continue
                identity = self.identities[key]
                recovered = identity.misses > 0
                confidence = float(np.clip(0.5 + 0.5 * (1.0 - best / self.config.accept_cost), 0.0, 1.0))
                if recovered:
                    confidence *= 0.7
                    if identity.lost_reported:
                        self._log(frame, "identity_recovered", key, candidate.track_id, round(confidence, 4),
                                  f"{key} recovered on track {candidate.track_id} after {identity.misses} frames")
                        identity.lost_reported = False
                self._commit(frame, key, candidate, confidence=confidence, status="recovered" if recovered else "matched", recovered=recovered)
                assigned_now[key] = candidate
                taken_tracks.add(candidate.track_id)
                states[key] = self._state(frame, key, "recovered" if recovered else "matched", candidate, confidence)

        # 3. Identities without a match: keep the last position, count misses, log the loss once.
        for key in self.keys:
            if key not in self.identities or key in states:
                continue
            identity = self.identities[key]
            identity.misses += 1
            # A lost identity holds its last position and stops moving; its motion is never extrapolated.
            identity.velocity = np.zeros(2)
            if identity.misses >= self.config.lost_event_after and not identity.lost_reported:
                identity.lost_reported = True
                self._log(frame, "identity_lost", key, identity.track_id, 0.0, f"{key} not matched for {identity.misses} frames")
            states[key] = self._state(frame, key, "lost", None, 0.0)

        for key in self.keys:
            if key not in states:
                states[key] = self._state(frame, key, "not_initialised", None, 0.0)
        return [states[key] for key in self.keys]

    def _commit(self, frame: int, key: str, candidate: Candidate, confidence: float, status: str, recovered: bool) -> None:
        identity = self.identities[key]
        steps = max(1, frame - identity.last_frame)
        observed = np.asarray(candidate.position, dtype=np.float64)
        new_position = identity.position + self.config.position_smoothing * (observed - identity.position)
        observed_velocity = (new_position - identity.position) / steps
        limit = self.config.max_speed_fraction * self.config.gate
        speed = float(np.linalg.norm(observed_velocity))
        if speed > limit:
            observed_velocity = observed_velocity * (limit / speed)
        smoothing = self.config.velocity_smoothing
        identity.velocity = smoothing * identity.velocity + (1 - smoothing) * observed_velocity
        identity.position = new_position
        identity.last_frame = frame
        identity.misses = 0
        identity.lost_reported = False
        identity.uncertain_reported = False if status != "uncertain" else identity.uncertain_reported
        if candidate.appearance is not None:
            if identity.appearance is None:
                identity.appearance = candidate.appearance
            else:
                blended = 0.8 * identity.appearance + 0.2 * candidate.appearance
                identity.appearance = blended / max(blended.sum(), 1e-9)
        if identity.track_id is not None and identity.track_id != candidate.track_id:
            self._last_identity_for_track.pop(identity.track_id, None)
        identity.track_id = candidate.track_id
        self._last_identity_for_track[candidate.track_id] = key
        self._last_track_for_identity[key] = candidate.track_id
        if self.config.net_y is not None:
            side = self._side(float(new_position[1]))
            if identity.side is not None and side != identity.side:
                self._log(frame, "side_change", key, candidate.track_id, confidence,
                          f"{key} crossed the net from the {identity.side} to the {side} half")
            identity.side = side
        del recovered  # recovery is reported by the caller; kept as a parameter for readability
