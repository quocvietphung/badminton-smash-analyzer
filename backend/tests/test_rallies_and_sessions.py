"""Rally candidates from contact sequences, transferred annotations, and sessions with latest-successful semantics.

Fixtures are synthetic and their expected values are stated in advance. They test the rules, not the accuracy of any
rally on a real video. No rally count from a video is claimed by these tests.
"""

from dataclasses import dataclass
from typing import Optional

import pytest

from app.analytics import rallies as R
from app.analytics.match import reconcile_session_corrections
from app.services import match_document
from app.services import sessions as S

FPS = 30.0


def contact(cid, frame, player="P1"):
    return {"id": cid, "frame": frame, "player": player, "status": "candidate"}


def visible(frames):
    return [{"frame": f, "visible": True, "refined": False} for f in frames]


# --- rallies -------------------------------------------------------------------------------------------------

def test_contacts_with_short_gaps_form_one_rally_with_roll_in_and_roll_out():
    cs = [contact("a", 30), contact("b", 60), contact("c", 90)]  # 1 s gaps
    out = R.derive_rallies(cs, FPS, visible(range(0, 200)))
    assert len(out) == 1
    assert out[0]["start_frame"] == 15 and out[0]["end_frame"] == 105  # 0.5 s before and after
    assert out[0]["status"] == "candidate" and out[0]["contact_ids"] == ["a", "b", "c"]
    assert out[0]["evidence"]["max_gap_s"] == 1.0


def test_a_long_contact_gap_starts_a_new_rally_and_rallies_never_overlap():
    cs = [contact("a", 30), contact("b", 60), contact("c", 300), contact("d", 330)]  # 8 s gap
    out = R.derive_rallies(cs, FPS, visible(range(0, 400)))
    assert [item["contact_ids"] for item in out] == [["a", "b"], ["c", "d"]]
    assert out[0]["end_frame"] < out[1]["start_frame"]


def test_a_brief_shuttle_gap_inside_a_rally_does_not_end_it():
    # The shuttle is not detected for three seconds, but the contacts are 1.5 s apart: one rally.
    detected = [f for f in range(0, 200) if not (60 <= f <= 150)]
    cs = [contact("a", 30), contact("b", 80), contact("c", 130), contact("d", 180)]
    out = R.derive_rallies(cs, FPS, visible(detected))
    assert len(out) == 1
    assert out[0]["evidence"]["shuttle_coverage"] < 1.0  # the gap is visible in the evidence, not hidden


def test_a_single_contact_is_uncertain_not_a_rally():
    out = R.derive_rallies([contact("a", 100)], FPS, visible(range(0, 300)))
    assert out[0]["status"] == "uncertain" and "one contact" in out[0]["evidence"]["reason"]


def test_a_human_boundary_confirms_and_supersedes_the_candidates_it_covers():
    cs = [contact("a", 30), contact("b", 60), contact("c", 300), contact("d", 330)]
    derived = R.derive_rallies(cs, FPS, visible(range(0, 400)))
    manual = [{"start_frame": 0, "end_frame": 120}]
    merged = R.merge_with_human_boundaries(derived, manual, FPS)
    statuses = [item["status"] for item in merged]
    assert statuses == ["confirmed", "candidate"]  # the first candidate is superseded by the human boundary
    assert merged[0]["validated"] is True and merged[0]["source"] == "manual"


def test_summary_separates_candidates_from_confirmed_and_counts_shots_per_rally():
    items = [
        {"id": "r1", "status": "candidate", "duration_s": 6.0, "start_frame": 0, "end_frame": 180},
        {"id": "r2", "status": "candidate", "duration_s": 8.0, "start_frame": 200, "end_frame": 440},
        {"id": "r3", "status": "confirmed", "duration_s": 4.0, "start_frame": 500, "end_frame": 620},
        {"id": "r4", "status": "uncertain", "duration_s": 1.0, "start_frame": 700, "end_frame": 730},
    ]
    shots = {"r1": [{"player": "P1"}, {"player": "P2"}], "r2": [{"player": "P2"}, {"player": "P2"}, {"player": "P2"}],
             "r3": [{"player": "P1"}]}
    summary = R.summarise(items, shots, ("P1", "P2"))
    assert summary["candidates"] == 2 and summary["confirmed"] == 1 and summary["uncertain"] == 1
    assert summary["count"] == 4
    assert summary["mean_duration_s"] == pytest.approx(6.0)  # (6 + 8 + 4) / 3, the uncertain one is excluded
    assert summary["longest_s"] == 8.0
    assert summary["shots_per_rally_mean"] == pytest.approx((2 + 3 + 1) / 3, abs=0.01)
    assert summary["player_participation"] == {"P1": 2, "P2": 2}


# --- transferred annotations ---------------------------------------------------------------------------------

def test_an_annotation_transfers_to_the_candidate_within_half_a_second_with_the_same_player():
    cands = [{"id": "c1", "frame": 357, "player": "P2"}]
    moved, unmatched = reconcile_session_corrections(
        [{"type": "shot_label", "frame": 350, "shot_type": "clear", "player": None, "id": "x", "source_job_id": "old"}], cands, FPS)
    assert unmatched == [] and moved[0]["frame"] == 357 and moved[0]["original_frame"] == 350


def test_an_annotation_outside_the_tolerance_is_kept_for_review_not_dropped():
    moved, unmatched = reconcile_session_corrections(
        [{"type": "contact_review", "frame": 52, "decision": "confirmed", "id": "y", "source_job_id": "old"}],
        [{"id": "c1", "frame": 200, "player": "P1"}], FPS)
    assert moved == [] and len(unmatched) == 1 and "no candidate within" in unmatched[0]["reason"]


def test_a_player_specific_annotation_is_not_moved_onto_another_player():
    moved, unmatched = reconcile_session_corrections(
        [{"type": "shot_label", "frame": 100, "shot_type": "smash", "player": "P1", "id": "z", "source_job_id": "old"}],
        [{"id": "c1", "frame": 100, "player": "P2"}], FPS)
    assert moved == [] and "player differs" in unmatched[0]["reason"]


def test_identity_and_mode_annotations_stay_with_their_own_analysis():
    moved, unmatched = reconcile_session_corrections(
        [{"type": "mode", "id": "m", "source_job_id": "old"}, {"type": "identity", "id": "i", "source_job_id": "old"}],
        [{"id": "c1", "frame": 100, "player": "P1"}], FPS)
    assert moved == [] and len(unmatched) == 2
    assert all("belongs to its own analysis" in item["reason"] for item in unmatched)


# --- sessions ------------------------------------------------------------------------------------------------

@dataclass
class Job:
    id: str
    status: str
    source_kind: str
    source_detail: Optional[str]
    source_name: str
    output_dir: str
    created_at: float
    finished_at: Optional[float] = None


def sample(jid, status, created, finished=None, sample_id="sample-a-singles-rally"):
    return Job(jid, status, "sample", sample_id, "A · Singles", "/nonexistent", created, finished)


def test_two_runs_of_one_sample_are_one_session_whose_active_result_is_the_latest_success():
    jobs = [sample("old", "completed", 1, 2), sample("new", "completed", 3, 4)]
    [session] = S.group_sessions(jobs)
    assert session.session_id == "sample:sample-a-singles-rally"
    assert session.active_job.id == "new"


def test_a_failed_rerun_never_replaces_the_active_result():
    jobs = [sample("good", "completed", 1, 2), sample("bad", "failed", 3, 4)]
    [session] = S.group_sessions(jobs)
    assert session.active_job.id == "good" and session.failed_since_success == 1


def test_a_running_rerun_is_shown_but_the_active_result_stays():
    jobs = [sample("good", "completed", 1, 2), sample("now", "running", 3)]
    [session] = S.group_sessions(jobs)
    assert session.active_job.id == "good" and session.running_job.id == "now"
    assert S.running_job_for(jobs, "sample:sample-a-singles-rally").id == "now"


def test_a_running_rerun_builds_its_dataset_with_the_corrections_it_will_receive(tmp_path):
    old_dir = tmp_path / "old"
    new_dir = tmp_path / "new"
    old_dir.mkdir()
    new_dir.mkdir()
    (old_dir / "corrections.json").write_text(
        '{"schema":"smashlab.corrections/v1","entries":['
        '{"id":"reject-1","type":"contact_review","frame":90,"decision":"rejected"}]}'
    )
    old = Job("old", "completed", "sample", "sample-b-fast-shuttle", "B", str(old_dir), 1, 2)
    rerun = Job("new", "running", "sample", "sample-b-fast-shuttle", "B", str(new_dir), 3)

    class Store:
        def list_jobs(self, _limit):
            return [rerun, old]

    # Ordinary reads keep the previous completed run active until the rerun succeeds.
    assert match_document.session_corrections(Store(), rerun) is None
    # Dataset generation happens before mark_completed, but must already use the correction visible after completion.
    transferred = match_document.session_corrections(Store(), rerun, include_pending=True)
    assert transferred == [{
        "id": "reject-1", "type": "contact_review", "frame": 90,
        "decision": "rejected", "source_job_id": "old",
    }]


def test_each_sample_is_its_own_session():
    jobs = [sample("a", "completed", 1, 2, "sample-a-singles-rally"), sample("b", "completed", 3, 4, "sample-b-fast-shuttle"),
            sample("c", "completed", 5, 6, "sample-c-difficult-multicourt"), sample("d", "completed", 7, 8, "sample-d-demonstration")]
    sessions = S.group_sessions(jobs)
    assert sorted(s.session_id for s in sessions) == [
        "sample:sample-a-singles-rally", "sample:sample-b-fast-shuttle",
        "sample:sample-c-difficult-multicourt", "sample:sample-d-demonstration"]


def test_uploads_are_one_session_per_content_hash(tmp_path):
    digest = "ab" * 32
    for name in ("u1", "u2"):
        (tmp_path / name / "input").mkdir(parents=True)
        (tmp_path / name / "input" / "sha256.txt").write_text(digest + "\n")
    (tmp_path / "u3" / "input").mkdir(parents=True)
    (tmp_path / "u3" / "input" / "sha256.txt").write_text("cd" * 32)

    def upload(jid, created):
        return Job(jid, "completed", "upload", "12 bytes", "clip.mp4", str(tmp_path / jid), created, created + 1)

    sessions = S.group_sessions([upload("u1", 1), upload("u2", 2), upload("u3", 3)])
    assert len(sessions) == 2
    assert {s.session_id for s in sessions} == {f"video:{digest}", f"video:{'cd' * 32}"}


def test_an_upload_without_a_recorded_hash_is_not_merged_with_others():
    a = Job("x", "completed", "upload", "1 bytes", "a.mp4", "/nonexistent-x", 1, 2)
    b = Job("y", "completed", "upload", "1 bytes", "a.mp4", "/nonexistent-y", 2, 3)
    assert {s.session_id for s in S.group_sessions([a, b])} == {"job:x", "job:y"}


def test_a_sample_and_an_upload_with_the_same_content_are_one_session(tmp_path):
    digest = "ef" * 32
    (tmp_path / "s").mkdir()
    (tmp_path / "s" / "input").mkdir()
    (tmp_path / "s" / "input" / "sha256.txt").write_text(digest)
    (tmp_path / "u").mkdir()
    (tmp_path / "u" / "input").mkdir()
    (tmp_path / "u" / "input" / "sha256.txt").write_text(digest)
    sample_job = Job("s", "completed", "sample", "sample-c-difficult-multicourt", "C · Hard case", str(tmp_path / "s"), 1, 2)
    upload_job = Job("u", "completed", "upload", "1 bytes", "sample-c-difficult-multicourt.mp4", str(tmp_path / "u"), 3, 4)
    [session] = S.group_sessions([sample_job, upload_job])
    assert session.session_id == f"video:{digest}"
    assert session.source_kind == "sample" and session.source_name == "C · Hard case"
    assert session.active_job.id == "u"  # the newest successful run is the active one, whichever kind it was


def test_a_hidden_job_is_marked_and_can_be_shown_again(tmp_path):
    (tmp_path / "h" / "input").mkdir(parents=True)
    job = Job("h", "completed", "upload", "3 bytes", "upload-test-3s.mp4", str(tmp_path / "h"), 1, 2)
    assert not S.is_hidden(job)
    (tmp_path / "h" / "hidden.json").write_text('{"reason": "test"}')
    assert S.is_hidden(job)
    (tmp_path / "h" / "hidden.json").unlink()
    assert not S.is_hidden(job)


def test_the_evaluation_counts_only_the_active_result_of_each_sample():
    jobs = [sample("a1", "completed", 1, 2, "sample-a-singles-rally"), sample("a2", "completed", 3, 4, "sample-a-singles-rally"),
            sample("b1", "completed", 5, 6, "sample-b-fast-shuttle"), sample("x", "failed", 7, None, "sample-b-fast-shuttle")]
    upload = Job("u", "completed", "upload", "1 bytes", "clip.mp4", "/nonexistent-u", 9, 10)
    active = {job.id for job in S.active_sample_jobs(jobs + [upload])}
    assert active == {"a2", "b1"}
