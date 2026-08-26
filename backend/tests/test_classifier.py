import unittest

from classifier import classify_stroke


class ClassifierTests(unittest.TestCase):
    def test_marks_fast_overhead_as_candidate_until_trajectory_arrives(self) -> None:
        result = classify_stroke(
            wrist_speed=1.5,
            elbow_angle=155,
            shoulder_angle=115,
            contact_height=78,
            arm_angular_speed=420,
            body_extension=82,
            wrist_above_shoulder=True,
            is_contact=True,
        )

        self.assertEqual(result.stroke_type, "overhead")
        self.assertIn("chờ đường cầu", result.stroke_label)
        self.assertIsNotNone(result.estimated_shuttle_speed_kmh)
        self.assertGreater(result.estimated_shuttle_speed_kmh or 0, 200)

    def test_does_not_call_bent_elbow_motion_a_confirmed_smash(self) -> None:
        result = classify_stroke(
            wrist_speed=1.06,
            elbow_angle=113,
            shoulder_angle=86,
            contact_height=52,
            arm_angular_speed=180,
            body_extension=68,
            wrist_above_shoulder=True,
            is_contact=True,
        )

        self.assertEqual(result.stroke_type, "overhead")
        self.assertGreater(result.estimated_shuttle_speed_kmh or 0, 190)

    def test_pose_speed_candidate_changes_instead_of_sticking_to_360(self) -> None:
        medium = classify_stroke(
            wrist_speed=1.1,
            elbow_angle=118,
            shoulder_angle=105,
            contact_height=65,
            arm_angular_speed=220,
            body_extension=65,
            wrist_above_shoulder=True,
            is_contact=True,
        )
        fast = classify_stroke(
            wrist_speed=2.4,
            elbow_angle=150,
            shoulder_angle=125,
            contact_height=80,
            arm_angular_speed=620,
            body_extension=85,
            wrist_above_shoulder=True,
            is_contact=True,
        )
        noisy = classify_stroke(
            wrist_speed=12,
            elbow_angle=160,
            shoulder_angle=130,
            contact_height=100,
            arm_angular_speed=5000,
            body_extension=100,
            wrist_above_shoulder=True,
            is_contact=True,
        )

        medium_speed = medium.estimated_shuttle_speed_kmh or 0
        fast_speed = fast.estimated_shuttle_speed_kmh or 0
        noisy_speed = noisy.estimated_shuttle_speed_kmh or 0

        self.assertLess(medium_speed, fast_speed)
        self.assertLess(fast_speed, 340)
        self.assertLess(noisy_speed, 340)
        self.assertNotEqual(noisy_speed, 360)

    def test_slow_overhead_waits_for_trajectory_without_speed(self) -> None:
        result = classify_stroke(
            wrist_speed=0.55,
            elbow_angle=125,
            shoulder_angle=100,
            contact_height=72,
            arm_angular_speed=90,
            body_extension=55,
            wrist_above_shoulder=True,
            is_contact=True,
        )

        self.assertEqual(result.stroke_type, "overhead")
        self.assertIsNone(result.estimated_shuttle_speed_kmh)

    def test_does_not_claim_slice_or_clear_from_pose_only(self) -> None:
        overhead_result = classify_stroke(
            wrist_speed=0.82,
            elbow_angle=120,
            shoulder_angle=110,
            contact_height=72,
            arm_angular_speed=120,
            body_extension=60,
            wrist_above_shoulder=True,
            is_contact=True,
        )
        drive_result = classify_stroke(
            wrist_speed=0.95,
            elbow_angle=145,
            shoulder_angle=92,
            contact_height=45,
            arm_angular_speed=130,
            body_extension=48,
            wrist_above_shoulder=False,
            is_contact=True,
        )
        second_overhead_result = classify_stroke(
            wrist_speed=0.85,
            elbow_angle=150,
            shoulder_angle=120,
            contact_height=75,
            arm_angular_speed=140,
            body_extension=70,
            wrist_above_shoulder=True,
            is_contact=True,
        )

        self.assertEqual(overhead_result.stroke_type, "overhead")
        self.assertEqual(drive_result.stroke_type, "drive_candidate")
        self.assertEqual(second_overhead_result.stroke_type, "overhead")


if __name__ == "__main__":
    unittest.main()
