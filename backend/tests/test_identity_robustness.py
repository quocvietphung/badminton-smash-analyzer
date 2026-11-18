"""Identity robustness: jittery court positions and lost identities that must not extrapolate their motion."""

import numpy as np

from app.ai.player_detection.identity import Candidate, IdentityConfig, IdentityManager


def cand(frame, track_id, x, y):
    return Candidate(
        frame=frame,
        track_id=track_id,
        box=(x - 0.3, y - 1.0, x + 0.3, y + 1.0),
        score=0.9,
        confirmed=True,
        position=(x, y),
        appearance=None,
    )


def singles(**overrides):
    # The gate matches the calibrated configuration in derive.py.
    values = dict(players=2, gate=2.0, net_y=6.7, init_frames=5)
    values.update(overrides)
    return IdentityConfig(**values)


def test_jittery_court_positions_do_not_break_the_identity():
    # Foot points alternate by 0.8 m either side of the true position (1.6 m between frames). That is the
    # envelope the gate is set for; larger alternation is reported as a limitation, not hidden by tuning.
    manager = IdentityManager(singles())
    states = []
    for frame in range(60):
        jitter = 0.8 if frame % 2 else -0.8
        states.append(manager.step(frame, [cand(frame, 1, 3.0, 2.0 + jitter), cand(frame, 2, 3.0, 11.0)]))
    p1 = [frame_states[0] for frame_states in states[15:]]
    assert all(s.track_id == 1 and s.status in ("matched", "recovered") for s in p1)
    assert not any(e.kind == "identity_lost" for e in manager.events)


def test_a_lost_identity_holds_its_last_position_instead_of_extrapolating():
    manager = IdentityManager(singles(lost_event_after=3))
    for frame in range(20):
        manager.step(frame, [cand(frame, 1, 3.0 + 0.1 * frame, 2.0), cand(frame, 2, 3.0, 11.0)])
    held = manager.identities["P1"].position.copy()
    for frame in range(20, 40):
        states = manager.step(frame, [cand(frame, 2, 3.0, 11.0)])
    assert states[0].status == "lost"
    assert np.allclose(manager.identities["P1"].position, held)
    assert np.allclose(manager.identities["P1"].velocity, 0.0)
