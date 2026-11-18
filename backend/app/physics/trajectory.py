"""Quadratic-drag shuttle dynamics and deterministic RK4 integration."""

from __future__ import annotations

import numpy as np

GRAVITY_M_S2 = 9.80665
DEFAULT_TERMINAL_VELOCITY_M_S = 6.70


def drag_coefficient(terminal_velocity_m_s: float = DEFAULT_TERMINAL_VELOCITY_M_S) -> float:
    if terminal_velocity_m_s <= 0:
        raise ValueError("terminal velocity must be positive")
    return GRAVITY_M_S2 / terminal_velocity_m_s**2


def derivative(state: np.ndarray, drag_k: float) -> np.ndarray:
    velocity = state[3:]
    acceleration = np.array([0.0, 0.0, -GRAVITY_M_S2]) - drag_k * np.linalg.norm(velocity) * velocity
    return np.concatenate([velocity, acceleration])


def rk4_step(state: np.ndarray, dt: float, drag_k: float) -> np.ndarray:
    k1 = derivative(state, drag_k)
    k2 = derivative(state + 0.5 * dt * k1, drag_k)
    k3 = derivative(state + 0.5 * dt * k2, drag_k)
    k4 = derivative(state + dt * k3, drag_k)
    return state + dt * (k1 + 2 * k2 + 2 * k3 + k4) / 6.0


def integrate_state(state_at_reference: np.ndarray, reference_time_s: float, times_s: np.ndarray, drag_k: float, max_step_s: float = 1 / 240) -> np.ndarray:
    """Integrate from one reference state to requested timestamps in temporal order.

    Forward and backward targets are each walked once. This matters inside nonlinear
    fitting, where the same trajectory is evaluated thousands of times.
    """
    reference = np.asarray(state_at_reference, dtype=float).reshape(6)
    targets = np.asarray(times_s, dtype=float)
    results = np.empty((len(targets), 6), dtype=float)

    def walk(indices: np.ndarray) -> None:
        state = reference.copy()
        current = float(reference_time_s)
        for index in indices:
            target = float(targets[index])
            remaining = target - current
            steps = max(1, int(np.ceil(abs(remaining) / max_step_s)))
            dt = remaining / steps
            for _ in range(steps):
                state = rk4_step(state, dt, drag_k)
            results[index] = state
            current = target

    forward = np.flatnonzero(targets >= reference_time_s)
    walk(forward[np.argsort(targets[forward])])
    backward = np.flatnonzero(targets < reference_time_s)
    walk(backward[np.argsort(targets[backward])[::-1]])
    return results


def speed_kmh(state: np.ndarray) -> float:
    return float(np.linalg.norm(np.asarray(state, dtype=float)[3:]) * 3.6)
