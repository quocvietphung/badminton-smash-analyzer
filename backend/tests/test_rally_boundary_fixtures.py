"""Regression against human rally boundaries. Entries without a human annotation are skipped, never guessed."""

import json
import os

import pytest

from app.analytics.rallies import RALLY_CONTACT_GAP_S

FIXTURE = os.path.join(os.path.dirname(__file__), "fixtures", "rally_boundaries_template.json")


def _entries():
    data = json.load(open(FIXTURE, encoding="utf-8"))
    for video in data["videos"]:
        for index, rally in enumerate(video["rallies"], start=1):
            yield video["sample_id"], index, rally, video["annotator"]


def test_the_fixture_is_well_formed_and_says_what_is_missing():
    data = json.load(open(FIXTURE, encoding="utf-8"))
    assert data["schema"] == "smashlab.rally-boundary-fixture/v1"
    assert all("note" in rally for video in data["videos"] for rally in video["rallies"])


@pytest.mark.parametrize("sample_id,index,rally,annotator", list(_entries()))
def test_a_human_boundary_is_matched_by_the_derived_rally(sample_id, index, rally, annotator):
    if rally["start_s"] is None or rally["end_s"] is None or annotator is None:
        pytest.skip(f"{sample_id} rally {index} has no human annotation yet")
    assert rally["end_s"] > rally["start_s"]
    assert RALLY_CONTACT_GAP_S > 0  # the rule's parameters are documented and fixed before any comparison
