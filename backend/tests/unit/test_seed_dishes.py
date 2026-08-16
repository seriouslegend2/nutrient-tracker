from __future__ import annotations

import importlib.util
from pathlib import Path


def _seed_dishes() -> list[tuple[str, str, str, float, dict[str, float]]]:
    seed_file = Path(__file__).resolve().parents[3] / "seeds" / "seed_dishes.py"
    spec = importlib.util.spec_from_file_location("nutrient_tracker_seed_dishes", seed_file)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.DISHES


def test_seed_dishes_do_not_define_one_gram_default_portions() -> None:
    bad = [
        name
        for name, _category, unit, grams, _nutrients in _seed_dishes()
        if unit == "g" and grams == 1
    ]
    assert bad == []


def test_protein_and_paneer_dishes_use_category_serving_defaults() -> None:
    portions = {name: (unit, grams) for name, _category, unit, grams, _ in _seed_dishes()}

    assert portions["Paneer butter masala"] == ("serving", 100)
    assert portions["Palak paneer"] == ("serving", 100)
    assert portions["Paneer bhurji"] == ("serving", 100)
    assert portions["Chicken curry"] == ("serving", 150)
    assert portions["Fish curry"] == ("serving", 150)
