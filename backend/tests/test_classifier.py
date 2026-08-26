import unittest

from classifier import classify_stroke


class ClassifierTests(unittest.TestCase):
    def test_detects_smash_from_fast_overhead_contact(self) -> None:
        result = classify_stroke(
            wrist_speed=1.5,
            elbow_angle=155,
            shoulder_angle=115,
            contact_height=78,
            is_contact=True,
        )

        self.assertEqual(result.stroke_type, "smash")
        self.assertIsNone(result.estimated_shuttle_speed_kmh)

    def test_never_reports_speed_without_calibration(self) -> None:
        result = classify_stroke(
            wrist_speed=0.55,
            elbow_angle=125,
            shoulder_angle=100,
            contact_height=72,
            is_contact=True,
        )

        self.assertEqual(result.stroke_type, "drop_shot")
        self.assertIsNone(result.estimated_shuttle_speed_kmh)

    def test_classifies_slice_drive_and_clear(self) -> None:
        slice_result = classify_stroke(
            wrist_speed=0.82,
            elbow_angle=120,
            shoulder_angle=110,
            contact_height=72,
            is_contact=True,
        )
        drive_result = classify_stroke(
            wrist_speed=0.95,
            elbow_angle=145,
            shoulder_angle=92,
            contact_height=45,
            is_contact=True,
        )
        clear_result = classify_stroke(
            wrist_speed=0.85,
            elbow_angle=150,
            shoulder_angle=120,
            contact_height=75,
            is_contact=True,
        )

        self.assertEqual(slice_result.stroke_type, "slice")
        self.assertEqual(drive_result.stroke_type, "drive")
        self.assertEqual(clear_result.stroke_type, "clear")


if __name__ == "__main__":
    unittest.main()
