"""Product taxonomy: six strokes plus Unknown. Legacy labels stay in the record but are never a stroke type."""

import pytest

from app.analytics import match as M
from app.services import corrections as C


def test_product_taxonomy_is_six_strokes_plus_unknown():
    assert M.SHOT_TYPES == ("smash", "clear", "drop", "drive", "net_shot", "lift", "unknown")
    for legacy in ("serve", "push", "defensive_block"):
        assert legacy not in M.SHOT_TYPES
        assert legacy in M.LEGACY_SHOT_TYPES


def test_new_shot_label_corrections_reject_legacy_labels_but_accept_the_six():
    base = {"type": "shot_label", "frame": 10}
    for legacy in ("serve", "push", "defensive_block"):
        with pytest.raises(C.CorrectionError):
            C.validate({**base, "shot_type": legacy}, frames_total=100, width=1920, height=1080, players=2)
    for kind in ("smash", "clear", "drop", "drive", "net_shot", "lift", "unknown"):
        C.validate({**base, "shot_type": kind}, frames_total=100, width=1920, height=1080, players=2)
