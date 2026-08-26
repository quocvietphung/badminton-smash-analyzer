import unittest

from rally import CourtPoint, analyze_trajectory, summarize_rally


class RallyAnalysisTests(unittest.TestCase):
    def test_classifies_near_player_long_cross_court_stroke(self) -> None:
        result = analyze_trajectory(
            hitter="A",
            start=CourtPoint(0.18, 0.82),
            end=CourtPoint(0.82, 0.08),
            source_confidence=0.9,
            wrist_speed=0.82,
            arm_angular_speed=150,
            contact_height=72,
            body_extension=68,
            wrist_above_shoulder=True,
        )

        self.assertEqual(result.length_type, "long")
        self.assertEqual(result.direction_type, "cross")
        self.assertEqual(result.stroke_type, "clear")
        self.assertGreater(result.court_distance_m, 9)

    def test_classifies_far_player_short_straight_stroke(self) -> None:
        result = analyze_trajectory(
            hitter="B",
            start=CourtPoint(0.72, 0.18),
            end=CourtPoint(0.68, 0.58),
            source_confidence=0.8,
            wrist_speed=0.63,
            arm_angular_speed=115,
            contact_height=70,
            body_extension=58,
            wrist_above_shoulder=True,
        )

        self.assertEqual(result.length_type, "short")
        self.assertEqual(result.direction_type, "straight")
        self.assertEqual(result.stroke_type, "drop_shot")

    def test_classifies_fast_overhead_midcourt_as_probable_smash(self) -> None:
        result = analyze_trajectory(
            hitter="A",
            start=CourtPoint(0.22, 0.84),
            end=CourtPoint(0.72, 0.2),
            source_confidence=0.9,
            wrist_speed=1.75,
            arm_angular_speed=480,
            contact_height=78,
            body_extension=82,
            wrist_above_shoulder=True,
        )

        self.assertEqual(result.stroke_type, "smash")
        self.assertEqual(result.classification_status, "probable")
        self.assertIsNotNone(result.estimated_shuttle_speed_kmh)

    def test_classifies_lower_flat_contact_as_drive(self) -> None:
        result = analyze_trajectory(
            hitter="B",
            start=CourtPoint(0.55, 0.32),
            end=CourtPoint(0.48, 0.72),
            source_confidence=0.84,
            wrist_speed=1.02,
            arm_angular_speed=170,
            contact_height=44,
            body_extension=46,
            wrist_above_shoulder=False,
        )

        self.assertEqual(result.stroke_type, "drive")
        self.assertIsNone(result.estimated_shuttle_speed_kmh)

    def test_slice_is_not_claimed_without_racket_or_shuttle_evidence(self) -> None:
        result = analyze_trajectory(
            hitter="A",
            start=CourtPoint(0.75, 0.84),
            end=CourtPoint(0.2, 0.56),
            source_confidence=0.92,
            wrist_speed=0.78,
            arm_angular_speed=125,
            contact_height=73,
            body_extension=64,
            wrist_above_shoulder=True,
        )

        self.assertNotEqual(result.stroke_type, "slice")
        self.assertIn("chưa xác minh", result.stroke_variant_label or "")

    def test_summarizes_deep_cross_court_pattern(self) -> None:
        summary = summarize_rally([
            {"length_type": "long", "direction_type": "cross"},
            {"length_type": "long", "direction_type": "cross"},
            {"length_type": "medium", "direction_type": "straight"},
        ])

        self.assertEqual(summary["dominant_pattern"], "Ép cuối sân chéo")
        self.assertGreater(summary["cross_rate"], 0.6)


if __name__ == "__main__":
    unittest.main()
