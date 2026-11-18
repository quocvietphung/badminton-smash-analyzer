import json

from tools.golden_trajectory import digest, main


def sample_trajectory() -> dict:
    return {
        "frames": [
            {"frame": 0, "time_s": 0.0, "x": 10, "y": 20, "visible": True, "confidence": 0.7746, "refined": False},
            {"frame": 1, "time_s": 0.033, "x": None, "y": None, "visible": False, "confidence": 0.0, "refined": False},
            {"frame": 2, "time_s": 0.066, "x": 14, "y": 22, "visible": True, "confidence": 0.5, "refined": True},
        ]
    }


def test_digest_is_stable_and_changes_when_the_output_changes():
    trajectory = sample_trajectory()
    assert digest(trajectory) == digest(json.loads(json.dumps(trajectory)))
    changed = sample_trajectory()
    changed["frames"][0]["x"] = 11
    assert digest(changed) != digest(trajectory)


def test_check_reports_a_match_and_a_mismatch(tmp_path):
    job = tmp_path / "job"
    job.mkdir()
    (job / "shuttle_trajectory.json").write_text(json.dumps(sample_trajectory()), encoding="utf-8")
    golden = tmp_path / "golden.json"
    assert main(["golden.py", "write", str(job), str(golden), "synthetic-clip"]) == 0
    assert main(["golden.py", "check", str(job), str(golden)]) == 0
    changed = sample_trajectory()
    changed["frames"][0]["x"] = 11
    (job / "shuttle_trajectory.json").write_text(json.dumps(changed), encoding="utf-8")
    assert main(["golden.py", "check", str(job), str(golden)]) == 1
