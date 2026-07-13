#!/usr/bin/env python3
"""Small xFP scoring walkthrough for a fictional MF persona named Pedri.

This is an explanatory example, not the production scoring engine.

It combines:
- July 6 v1-style absolute action scoring curves.
- v0.2 MF role weights, because that weight matrix already exists as config.
- A few fictional action observations for a central/attacking midfielder.

Run:
    python3 scripts/xfp_pedri_score_example.py
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from math import exp, log


REF_CURVES = {
    "Goal": {"ref50": 0.068, "ref_hi": 0.188},
    "Creation": {"ref50": 0.068, "ref_hi": 0.188},
    "Progression": {"ref50": 0.0013, "ref_hi": 0.0083},
    "Possession": {"ref50": 0.030, "ref_hi": 0.120},
}

ACTION_CATALOG = {
    "A01": ("Shot/OPP/Direct/Goal", "Goal"),
    "A02": ("Pass/OPP/Indirect/Goal", "Creation"),
    "A03": ("Cross/OPP/Indirect/Goal", "Creation"),
    "A04": ("Pass/OWN/Direct/Progression", "Progression"),
    "A05": ("Pass/OPP/Indirect/Progression", "Progression"),
    "A06": ("Cross/OPP/Direct/Progression", "Progression"),
    "A07": ("Dribble/OWN/Direct/Progression", "Progression"),
    "A08": ("Dribble/OPP/Direct/Progression", "Progression"),
    "A09": ("Penetration/OPP/Direct/Progression", "Progression"),
    "A10": ("Penetration/OPP/Indirect/Progression", "Progression"),
    "A11": ("Pass/OWN/Direct/Possession", "Possession"),
    "A12": ("Pass/OPP/Direct/Possession", "Possession"),
    "A13": ("Dribble/OWN/Direct/Possession", "Possession"),
    "A14": ("Dribble/OPP/Direct/Possession", "Possession"),
    "A15": ("Defense/OWN/Direct/Possession", "Possession"),
    "A16": ("Defense/OWN/Indirect/Possession", "Possession"),
    "A17": ("Defense/OPP/Direct/Possession", "Possession"),
    "A18": ("Defense/OPP/Indirect/Possession", "Possession"),
    "A19": ("Press/OPP/Direct/Possession", "Possession"),
    "A20": ("Press/OPP/Indirect/Possession", "Possession"),
    "A21": ("Duel/OWN/Direct/Possession", "Possession"),
    "A22": ("Duel/OPP/Direct/Possession", "Possession"),
    "A23": ("Duel/OWN/Indirect/Possession", "Possession"),
    "A24": ("Duel/OPP/Indirect/Possession", "Possession"),
}

MF_ROLE_WEIGHTS = {
    "Advanced Playmaker": {
        "weights": {"A01": 2, "A02": 5, "A04": 3, "A05": 4, "A08": 2, "A10": 2, "A12": 4, "A14": 2, "A20": 1},
        "production_bonus_weight": 0.08,
    },
    "Anchor": {
        "weights": {"A04": 2, "A11": 4, "A13": 2, "A15": 5, "A16": 5, "A17": 2, "A18": 2, "A21": 4, "A23": 4},
        "production_bonus_weight": 0.02,
    },
    "Ball Winning Midfielder": {
        "weights": {"A11": 2, "A13": 2, "A15": 5, "A16": 4, "A17": 4, "A18": 4, "A19": 4, "A20": 5, "A21": 5, "A22": 4, "A23": 4, "A24": 4},
        "production_bonus_weight": 0.02,
    },
    "Box To Box": {
        "weights": {"A01": 3, "A02": 2, "A04": 4, "A05": 3, "A07": 3, "A08": 3, "A09": 2, "A10": 2, "A11": 3, "A12": 3, "A15": 4, "A17": 4, "A19": 3, "A20": 3, "A21": 3, "A22": 3},
        "production_bonus_weight": 0.06,
    },
    "Deep-Lying Playmaker": {
        "weights": {"A04": 5, "A05": 3, "A07": 2, "A11": 5, "A12": 3, "A13": 3, "A15": 2, "A16": 2, "A21": 2},
        "production_bonus_weight": 0.04,
    },
    "Mezzala": {
        "weights": {"A01": 3, "A02": 4, "A03": 2, "A05": 4, "A06": 2, "A08": 4, "A09": 3, "A10": 3, "A12": 3, "A14": 3, "A17": 2, "A19": 2, "A20": 2},
        "production_bonus_weight": 0.07,
    },
    "Wide Midfielder": {
        "weights": {"A01": 2, "A02": 3, "A03": 5, "A05": 2, "A06": 5, "A08": 4, "A09": 3, "A12": 2, "A14": 3, "A17": 3, "A18": 3, "A19": 3, "A20": 3},
        "production_bonus_weight": 0.06,
    },
}


@dataclass(frozen=True)
class Observation:
    action_id: str
    base_value: float
    note: str
    cone_factor: float = 1.0
    packing_bypassed: int = 0
    dcm: float = 0.0
    credit: float = 1.0

    @property
    def outcome(self) -> str:
        return ACTION_CATALOG[self.action_id][1]

    @property
    def action_key(self) -> str:
        return ACTION_CATALOG[self.action_id][0]

    def raw_xfp(self) -> float:
        """Return raw xFP after the small difficulty/credit modifiers."""
        if self.outcome in {"Goal", "Creation"}:
            return self.base_value * self.cone_factor * self.credit
        packing_factor = min(1.6, 1 + 0.15 * max(0, self.packing_bypassed))
        return self.base_value * packing_factor * (1 + self.dcm) * self.credit


def absolute_score(value: float, outcome: str) -> float:
    """Map a raw value to a stable 0-100 consumer score."""
    ref = REF_CURVES[outcome]
    k = log(85 / 15) / (ref["ref_hi"] - ref["ref50"])
    return 100 / (1 + exp(-k * (value - ref["ref50"])))


def action_scores(observations: list[Observation]) -> dict[str, dict[str, float]]:
    values_by_action: dict[str, list[float]] = defaultdict(list)
    for obs in observations:
        values_by_action[obs.action_id].append(obs.raw_xfp())

    scores = {}
    for action_id, values in values_by_action.items():
        outcome = ACTION_CATALOG[action_id][1]
        # For this compact persona demo, use the mean observed value per action.
        # Production code can choose a season total, per-90 value, or rebaked curve.
        mean_raw = sum(values) / len(values)
        scores[action_id] = {
            "count": len(values),
            "raw_total": sum(values),
            "raw_mean": mean_raw,
            "score": absolute_score(mean_raw, outcome),
        }
    return scores


def role_scores(per_action: dict[str, dict[str, float]], production_score: float = 72.0) -> list[dict[str, float | str]]:
    rows = []
    for role, config in MF_ROLE_WEIGHTS.items():
        weighted_sum = 0.0
        total_weight = 0.0
        for action_id, weight in config["weights"].items():
            # In early/low-sample product states, "not observed yet" starts near 50.
            # Evidence and absence penalties are handled by the app layer.
            score = per_action.get(action_id, {"score": 50.0})["score"]
            weighted_sum += score * weight
            total_weight += weight
        base_role = weighted_sum / total_weight
        bonus = production_score * config["production_bonus_weight"]
        rows.append(
            {
                "role": role,
                "base_role": base_role,
                "production_bonus": bonus,
                "role_score": base_role + bonus,
            }
        )
    return sorted(rows, key=lambda row: row["role_score"], reverse=True)


def main() -> None:
    pedri_events = [
        Observation("A02", 0.110, "through ball to shot; xAG-like creation"),
        Observation("A04", 0.0046, "own-half progressive pass", packing_bypassed=1, dcm=0.05),
        Observation("A05", 0.0032, "opposition-half pass enabling next progression", credit=0.35),
        Observation("A08", 0.0062, "carry between lines", packing_bypassed=2, dcm=0.08),
        Observation("A12", 0.076, "tight-space pass retained in opponent half", dcm=0.05),
        Observation("A14", 0.058, "dribble retention under pressure", dcm=0.10),
        Observation("A19", 0.064, "counterpress regain", dcm=0.12),
        Observation("A20", 0.050, "pressing support that narrows options", credit=0.35),
        Observation("A21", 0.041, "own-half second-ball duel won"),
        Observation("A01", 0.052, "low-volume shot from zone 14", cone_factor=0.95),
    ]

    scores = action_scores(pedri_events)
    roles = role_scores(scores, production_score=72.0)

    print("Fictional persona: Pedri")
    print("Position group: MF")
    print("\nObserved action scores")
    for action_id in sorted(scores):
        action_key = ACTION_CATALOG[action_id][0]
        item = scores[action_id]
        print(
            f"- {action_id} {action_key}: "
            f"mean_raw={item['raw_mean']:.4f}, score={item['score']:.1f}, n={int(item['count'])}"
        )

    print("\nRole ranking")
    for row in roles:
        print(
            f"- {row['role']}: "
            f"base={row['base_role']:.1f}, "
            f"production_bonus={row['production_bonus']:.1f}, "
            f"total={row['role_score']:.1f}"
        )

    best = roles[0]
    print(f"\nBest role: {best['role']} ({best['role_score']:.1f})")


if __name__ == "__main__":
    main()
