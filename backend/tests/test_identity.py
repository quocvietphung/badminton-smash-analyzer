
from app.ai.player_detection.identity import Candidate, IdentityConfig, IdentityManager


def cand(frame, track_id, x, y, confirmed=True, appearance=None):
    return Candidate(
        frame=frame,
        track_id=track_id,
        box=(x - 0.3, y - 1.0, x + 0.3, y + 1.0),
        score=0.9,
        confirmed=confirmed,
        position=(x, y),
        appearance=appearance,
    )


def run(manager, frames_candidates, forced_by_frame=None):
    out = []
    for frame, candidates in frames_candidates:
        forced = (forced_by_frame or {}).get(frame)
        out.append(manager.step(frame, candidates, forced))
    return out


def singles_config(**overrides):
    values = dict(players=2, gate=1.5, net_y=6.7, init_frames=5)
    values.update(overrides)
    return IdentityConfig(**values)


def test_two_steady_players_keep_their_identities_and_produce_no_events():
    manager = IdentityManager(singles_config())
    scenario = []
    for frame in range(40):
        scenario.append((frame, [cand(frame, 1, 3.0 + 0.01 * frame, 2.0), cand(frame, 2, 3.0, 11.0)]))
    states = run(manager, scenario)
    final = states[-1]
    assert [s.identity for s in final] == ["P1", "P2"]
    assert final[0].track_id == 1 and final[1].track_id == 2
    assert all(s.status in ("matched", "not_initialised") for frame_states in states for s in frame_states)
    kinds = {event.kind for event in manager.events}
    assert kinds == {"identity_initialised"}


def test_a_new_tracker_id_for_the_same_player_keeps_the_identity():
    manager = IdentityManager(singles_config())
    scenario = []
    for frame in range(40):
        tid = 1 if frame < 20 else 5
        scenario.append((frame, [cand(frame, tid, 3.0, 2.0 + 0.01 * frame), cand(frame, 2, 3.0, 11.0)]))
    states = run(manager, scenario)
    p1_late = states[-1][0]
    assert p1_late.identity == "P1" and p1_late.track_id == 5
    assert p1_late.status in ("matched", "recovered")
    assert not any(e.kind == "identity_switch_suspected" for e in manager.events)


def test_an_occluded_player_is_marked_lost_then_recovered_without_a_swap():
    manager = IdentityManager(singles_config(lost_event_after=3))
    scenario = []
    for frame in range(50):
        far = [] if 20 <= frame < 30 else [cand(frame, 2, 3.0, 11.0)]
        scenario.append((frame, [cand(frame, 1, 3.0, 2.0)] + far))
    states = run(manager, scenario)
    lost = [s for frame_states in states[20:30] for s in frame_states if s.identity == "P2" and s.status == "lost"]
    assert len(lost) == 10
    recovered = states[30][1]
    assert recovered.identity == "P2" and recovered.track_id == 2 and recovered.status == "recovered"
    kinds = [e.kind for e in manager.events]
    assert "identity_lost" in kinds and "identity_recovered" in kinds
    assert not any(e.kind == "identity_switch_suspected" for e in manager.events)


def test_an_ambiguous_match_is_marked_uncertain_and_never_reassigned_silently():
    manager = IdentityManager(singles_config(ambiguity_margin=0.2))
    scenario = []
    for frame in range(30):
        if frame < 15:
            candidates = [cand(frame, 1, 3.0, 2.0), cand(frame, 2, 3.0, 11.0)]
        else:
            # Two near-identical candidates in the near half: the identity must not pick one silently.
            candidates = [cand(frame, 1, 3.0, 2.5), cand(frame, 3, 3.0, 2.5), cand(frame, 2, 3.0, 11.0)]
        scenario.append((frame, candidates))
    states = run(manager, scenario)
    p1_frames = [frame_states[0] for frame_states in states[15:]]
    silent_switch = [s for s in p1_frames if s.status in ("matched", "recovered") and s.track_id == 3]
    assert silent_switch == []
    assert any(e.kind == "identity_uncertain" for e in manager.events)


def test_a_manual_correction_forces_the_identity_for_its_interval():
    manager = IdentityManager(singles_config())
    scenario = []
    for frame in range(40):
        scenario.append((frame, [cand(frame, 1, 3.0, 2.0), cand(frame, 2, 3.0, 11.0)]))
    forced = {frame: {2: "P1"} for frame in range(20, 30)}
    states = run(manager, scenario, forced)
    corrected = states[25]
    assert corrected[0].identity == "P1" and corrected[0].track_id == 2 and corrected[0].status == "manual"
    assert corrected[0].confidence == 1.0
    after = states[35]
    # Interval over: both identities predict the same far-side position, so the automatic rules must not
    # pick one silently. The identity is uncertain until a human correction resolves it.
    assert after[0].track_id != 1
    assert after[0].status == "uncertain" or after[0].track_id == 2


def test_doubles_initialises_four_identities_by_side_and_court_x():
    manager = IdentityManager(IdentityConfig(players=4, gate=1.5, net_y=6.7, init_frames=5))
    positions = {
        1: (1.5, 2.0), 2: (4.6, 2.0), 3: (1.5, 11.0), 4: (4.6, 11.0),
    }
    scenario = [(frame, [cand(frame, tid, x, y) for tid, (x, y) in positions.items()]) for frame in range(12)]
    states = run(manager, scenario)
    final = {s.identity: s.track_id for s in states[-1]}
    assert final == {"P1": 1, "P2": 2, "P3": 3, "P4": 4}
