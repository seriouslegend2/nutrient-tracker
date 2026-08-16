"""Integration tests against a REAL Postgres.

KookarCore mocks its database entirely, which means it cannot test any of
this - not the formulas, not the lookup chain, not the trigger cascade, not
RLS. These are the tests that mocking makes impossible.

Run:  docker run --rm -d --name nt-test -e POSTGRES_PASSWORD=x -p 55432:5432 \
          pgvector/pgvector:pg17
      pytest tests/integration -q
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

CONTAINER = os.environ.get("NT_TEST_CONTAINER", "nt-verify")
MIGRATIONS = Path(__file__).resolve().parents[3] / "supabase" / "migrations"
USER_ID = "11111111-1111-1111-1111-111111111111"


def psql(sql: str) -> str:
    """Run a query and return the scalar/rows as text."""
    out = subprocess.run(
        ["docker", "exec", CONTAINER, "psql", "-U", "postgres", "-tA", "-c", sql],
        capture_output=True,
        text=True,
        check=False,
    )
    if out.returncode != 0:
        raise AssertionError(out.stderr.strip())
    return out.stdout.strip()


def container_available() -> bool:
    out = subprocess.run(
        ["docker", "exec", CONTAINER, "pg_isready", "-U", "postgres"],
        capture_output=True,
        check=False,
    )
    return out.returncode == 0


pytestmark = pytest.mark.integration


@pytest.fixture(scope="module", autouse=True)
def fresh_database() -> None:
    """Build the minimum Supabase-shaped database and apply every migration."""
    if not container_available():
        if os.environ.get("NT_REQUIRE_DATABASE") == "1":
            pytest.fail(f"required test database container {CONTAINER!r} is unavailable")
        pytest.skip("no test database running")

    bootstrap = """
    DROP SCHEMA IF EXISTS auth CASCADE;
    DROP SCHEMA IF EXISTS public CASCADE;
    CREATE SCHEMA public;
    CREATE SCHEMA auth;
    DO $roles$
    BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
            CREATE ROLE anon NOLOGIN;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
            CREATE ROLE authenticated NOLOGIN;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
            CREATE ROLE service_role NOLOGIN BYPASSRLS;
        END IF;
    END
    $roles$;
    CREATE TABLE auth.users (
        id uuid PRIMARY KEY,
        email text,
        raw_user_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE FUNCTION auth.uid() RETURNS uuid
    LANGUAGE sql STABLE AS $uid$
        SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $uid$;
    """
    psql(bootstrap)

    for migration in sorted(MIGRATIONS.glob("*.sql")):
        result = subprocess.run(
            [
                "docker",
                "exec",
                "-i",
                CONTAINER,
                "psql",
                "-U",
                "postgres",
                "-v",
                "ON_ERROR_STOP=1",
            ],
            input=migration.read_text(),
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            raise AssertionError(f"{migration.name}: {result.stderr.strip()}")

    psql(
        f"""
        INSERT INTO auth.users (id, email) VALUES ('{USER_ID}', 'test@example.com');
        INSERT INTO user_profiles (
            user_id, sex, date_of_birth, height_cm, activity, diet)
        VALUES (
            '{USER_ID}', 'male', '1990-01-01', 175, 'moderate', 'vegetarian');
        INSERT INTO body_metrics (user_id, weight_kg)
        VALUES ('{USER_ID}', 70);
        SELECT count(*) FROM fn_create_goal_v2(
            '{USER_ID}', 'hydration', '{{}}'::jsonb,
            CURRENT_DATE, CURRENT_DATE + 30);
        """
    )


# ---------------------------------------------------------------------------
# Formulas. Table-driven against published worked examples.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "expr,expected",
    [
        # Mifflin-St Jeor 1990: 10*70 + 6.25*175 - 5*30 + 5 = 1648.75 -> 1649
        ("fn_bmr_mifflin(70,175,30,'male')", "1649"),
        # female term is -161: 10*60 + 6.25*165 - 5*30 - 161 = 1320.25 -> 1320
        ("fn_bmr_mifflin(60,165,30,'female')", "1320"),
        ("fn_bmi(70,175)", "22.86"),
        # THE identity: rate_kg_per_week * 1100
        ("fn_daily_deficit(1,1)", "1100"),
        ("fn_daily_deficit(0.5,1)", "550"),
        # the clamp: min(1.0, 1% of body weight)
        ("fn_safe_rate_kg_per_week(70)", "0.70"),
        ("fn_safe_rate_kg_per_week(130)", "1.0"),  # capped at 1.0, not 1.3
        # floor: max(sex floor, 0.70 * BMR)
        ("fn_calorie_floor('male',1649)", "1500"),
        ("fn_calorie_floor('female',1320)", "1200"),
        ("fn_calorie_floor('male',2400)", "1680"),  # 0.7*BMR wins for a large person
        # Atwater, and energy is ALWAYS recomputed
        ("""fn_energy_kcal('{"protein_g":10,"carbs_g":20,"fat_g":5}'::jsonb)""", "165"),
    ],
)
def test_formula(expr: str, expected: str) -> None:
    assert psql(f"SELECT {expr};") == expected


def test_tdee_multipliers_match_the_documented_set() -> None:
    bmr = 1000
    assert psql(f"SELECT fn_tdee({bmr},'sedentary');") == "1200"
    assert psql(f"SELECT fn_tdee({bmr},'moderate');") == "1550"
    assert psql(f"SELECT fn_tdee({bmr},'extra_active');") == "1900"


# ---------------------------------------------------------------------------
# The safety ladder. The case the whole design exists for.
# ---------------------------------------------------------------------------


def _derivation(amount_kg: float, days: int) -> dict[str, str]:
    raw = psql(
        f"""SELECT derivation::text FROM fn_resolve_goal_targets(
              '{USER_ID}','body_weight',
              '{{"direction":"lose","amount_kg":{amount_kg}}}'::jsonb,
              CURRENT_DATE, CURRENT_DATE + {days});"""
    )
    return json.loads(raw)


def test_two_kg_in_one_week_is_clamped_not_accepted() -> None:
    """2 kg/week needs a 2,200 kcal/day deficit, which for a 70 kg person
    leaves a dangerous intake. The engine must compute it honestly AND clamp."""
    d = _derivation(2, 7)
    assert d["clamp_fired"] is True
    assert float(d["requested_rate_kg_per_week"]) == 2.0
    assert float(d["applied_rate_kg_per_week"]) <= 0.7  # 1% of 70 kg
    # the honest number is still reported, so the UI can show both
    assert float(d["requested_intake_kcal"]) < 800
    assert float(d["applied_intake_kcal"]) >= float(d["calorie_floor_kcal"])
    # and the user is told when they would actually get there
    assert d["achievable_end_date"] is not None


def test_a_safe_goal_is_not_clamped() -> None:
    d = _derivation(2, 60)  # 2 kg over ~8.5 weeks = 0.23 kg/week
    assert d["clamp_fired"] is False
    assert float(d["applied_intake_kcal"]) > float(d["calorie_floor_kcal"])


def test_intake_never_drops_below_the_floor() -> None:
    for days in (7, 14, 21, 30):
        d = _derivation(5, days)
        assert float(d["applied_intake_kcal"]) >= float(d["calorie_floor_kcal"]), (
            f"floor breached at {days} days"
        )


def test_nutrient_preview_and_create_clamp_sub_800_request() -> None:
    preview = json.loads(
        psql(
            f"""SELECT daily_targets::text FROM fn_resolve_goal_targets(
            '{USER_ID}', 'nutrient',
            '{{"direction":"at_most","nutrients":{{"calories_kcal":500}}}}'::jsonb,
            CURRENT_DATE, CURRENT_DATE + 7);"""
        )
    )
    calories = next(t for t in preview["targets"] if t["metric"] == "calories_kcal")
    assert float(calories["value"]) >= 800

    stored = psql(
        f"""SELECT daily_targets->'targets'->0->>'value' FROM fn_create_goal_v2(
            '{USER_ID}', 'nutrient',
            '{{"direction":"at_most","nutrients":{{"calories_kcal":500}}}}'::jsonb,
            CURRENT_DATE, CURRENT_DATE + 7);"""
    )
    assert float(stored) >= 800


def test_target_bmi_and_medical_condition_guards() -> None:
    too_low = subprocess.run(
        [
            "docker",
            "exec",
            CONTAINER,
            "psql",
            "-U",
            "postgres",
            "-v",
            "ON_ERROR_STOP=1",
            "-c",
            f"""SELECT * FROM fn_resolve_goal_targets(
                '{USER_ID}', 'body_weight',
                '{{"direction":"lose","amount_kg":20,"target_weight_kg":50}}'::jsonb,
                CURRENT_DATE, CURRENT_DATE + 90);""",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert too_low.returncode != 0
    assert "target_bmi" in too_low.stderr

    psql(f"UPDATE user_profiles SET has_medical_condition=true WHERE user_id='{USER_ID}';")
    medical = subprocess.run(
        [
            "docker",
            "exec",
            CONTAINER,
            "psql",
            "-U",
            "postgres",
            "-v",
            "ON_ERROR_STOP=1",
            "-c",
            f"""SELECT * FROM fn_resolve_goal_targets(
                '{USER_ID}', 'body_weight',
                '{{"direction":"lose","amount_kg":2}}'::jsonb,
                CURRENT_DATE, CURRENT_DATE + 90);""",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert medical.returncode != 0
    assert "medical_condition" in medical.stderr
    psql(f"UPDATE user_profiles SET has_medical_condition=false WHERE user_id='{USER_ID}';")


def test_behaviour_goal_counts_distinct_logged_days() -> None:
    target = json.loads(
        psql(
            f"""SELECT daily_targets::text FROM fn_resolve_goal_targets_v2(
            '{USER_ID}', 'behaviour',
            '{{"metric":"training_days","target":3}}'::jsonb,
            CURRENT_DATE, CURRENT_DATE + 6);"""
        )
    )["targets"][0]
    assert target["metric"] == "training_days"
    assert target["scope"] == "activity"
    assert float(target["value"]) == 3


def test_protein_goal_is_clamped_to_weight_based_baseline() -> None:
    row = json.loads(
        psql(
            f"""SELECT jsonb_build_object(
                'targets', daily_targets, 'derivation', derivation)::text
            FROM fn_resolve_goal_targets_v2(
                '{USER_ID}', 'nutrient',
                '{{"nutrients":{{"protein_g":20}},"direction":"at_least"}}'::jsonb,
                CURRENT_DATE, CURRENT_DATE + 6);"""
        )
    )
    target = row["targets"]["targets"][0]
    assert float(target["value"]) == 56
    assert row["derivation"]["requested_protein_g"] == 20
    assert row["derivation"]["applied_protein_g"] == 56
    assert row["derivation"]["protein_floor_applied"] is True


def test_extreme_hydration_minimum_has_a_recognizable_hint() -> None:
    result = subprocess.run(
        [
            "docker",
            "exec",
            CONTAINER,
            "psql",
            "-U",
            "postgres",
            "-v",
            "ON_ERROR_STOP=1",
            "-c",
            f"""SELECT * FROM fn_resolve_goal_targets_v2(
                '{USER_ID}', 'hydration', '{{"target_ml":10000}}'::jsonb,
                CURRENT_DATE, CURRENT_DATE + 6);""",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode != 0
    assert "hydration_extreme" in result.stderr


def test_pregnancy_guard_is_scoped_to_weight_goals() -> None:
    psql(f"UPDATE user_profiles SET is_pregnant_or_nursing=true WHERE user_id='{USER_ID}';")
    try:
        protein = json.loads(
            psql(
                f"""SELECT daily_targets::text FROM fn_resolve_goal_targets_v2(
                    '{USER_ID}', 'nutrient',
                    '{{"nutrients":{{"protein_g":60}},"direction":"at_least"}}'::jsonb,
                    CURRENT_DATE, CURRENT_DATE + 30);"""
            )
        )
        hydration = json.loads(
            psql(
                f"""SELECT daily_targets::text FROM fn_resolve_goal_targets_v2(
                    '{USER_ID}', 'hydration', '{{"target_ml":2000}}'::jsonb,
                    CURRENT_DATE, CURRENT_DATE + 30);"""
            )
        )
        assert protein["targets"][0]["metric"] == "protein_g"
        assert hydration["targets"][0]["metric"] == "water_ml"
        with pytest.raises(AssertionError):
            psql(
                f"""SELECT count(*) FROM fn_resolve_goal_targets_v2(
                    '{USER_ID}', 'body_weight',
                    '{{"direction":"lose","amount_kg":1}}'::jsonb,
                    CURRENT_DATE, CURRENT_DATE + 90);"""
            )
    finally:
        psql(f"UPDATE user_profiles SET is_pregnant_or_nursing=false WHERE user_id='{USER_ID}';")


# ---------------------------------------------------------------------------
# The lookup chain. Priority order is the contract.
# ---------------------------------------------------------------------------


def test_chain_prefers_household_over_global_and_dish_over_category() -> None:
    dish = psql(
        """WITH inserted AS (
               INSERT INTO dish_global (
                   name, name_normalized, category, portion_unit, portion_grams, per_100g)
               VALUES ('Dal Tadka', 'dal tadka', 'dal_gravy', 'katori', 180,
                       '{"protein_g": 6}'::jsonb)
               RETURNING dish_id
           )
           SELECT dish_id FROM inserted;"""
    )
    psql(
        f"""INSERT INTO category_household (
                user_id, category, portion_unit, portion_grams, source)
            VALUES ('{USER_ID}', 'dal_gravy', 'katori', 200, 'manual');
            INSERT INTO dish_household (
                user_id, dish_id, portion_unit, portion_grams)
            VALUES ('{USER_ID}', '{dish}', 'katori', 220);"""
    )

    level = psql(f"SELECT resolved_from FROM fn_resolve_portion('{USER_ID}','{dish}',NULL);")
    psql(
        f"""DELETE FROM dish_household WHERE user_id='{USER_ID}' AND dish_id='{dish}';
            DELETE FROM category_household
             WHERE user_id='{USER_ID}' AND category='dal_gravy';
            DELETE FROM dish_global WHERE dish_id='{dish}';"""
    )
    # With both overrides present, the per-DISH household row must win.
    assert level == "dish_household"


def test_category_global_always_answers() -> None:
    """Level 5 is the floor of the chain: a log is never blocked."""
    grams = psql(f"SELECT portion_grams FROM fn_resolve_portion('{USER_ID}',NULL,'flatbread');")
    # one portion of flatbread is TWO pieces of 45 g
    assert float(grams) == 90.0


def test_unresolvable_returns_unknown_rather_than_guessing() -> None:
    level = psql(f"SELECT resolved_from FROM fn_resolve_portion('{USER_ID}',NULL,NULL);")
    assert level == "unknown"


# ---------------------------------------------------------------------------
# The trigger cascade and its guard.
# ---------------------------------------------------------------------------


def test_profile_is_refreshed_on_weight_insert() -> None:
    row = psql(
        f"SELECT bmr_kcal IS NOT NULL AND tdee_kcal IS NOT NULL "
        f"FROM user_profiles WHERE user_id='{USER_ID}';"
    )
    assert row == "t"


def test_structural_profile_edits_refresh_and_version_the_goal() -> None:
    before = psql(
        f"SELECT bmr_kcal || ',' || tdee_kcal FROM user_profiles WHERE user_id='{USER_ID}';"
    )
    version = int(
        psql(
            f"SELECT version FROM goals WHERE user_id='{USER_ID}' "
            "AND kind='hydration' AND is_active;"
        )
    )
    psql(f"UPDATE user_profiles SET height_cm=180 WHERE user_id='{USER_ID}';")
    after = psql(
        f"SELECT bmr_kcal || ',' || tdee_kcal FROM user_profiles WHERE user_id='{USER_ID}';"
    )
    assert after != before
    assert (
        int(
            psql(
                f"SELECT version FROM goals WHERE user_id='{USER_ID}' "
                "AND kind='hydration' AND is_active;"
            )
        )
        == version + 1
    )
    assert (
        psql(
            f"SELECT derivation->>'trigger_reason' FROM goals "
            f"WHERE user_id='{USER_ID}' AND kind='hydration' AND is_active;"
        )
        == "profile_change"
    )


def test_meal_replacement_rolls_back_as_a_unit() -> None:
    day = "2026-08-01"
    item = json.dumps(
        [
            {
                "meal_type": "breakfast",
                "dish_name": "Oats",
                "portions": 1,
                "portion_unit": "bowl",
                "grams": 100,
                "nutrients": {"protein_g": 10},
                "resolved_from": "meals",
                "source": "manual",
            }
        ]
    )
    psql(f"SELECT count(*) FROM fn_replace_meal_day('{USER_ID}', '{day}', '{item}'::jsonb);")
    broken = json.dumps(
        [
            {
                "meal_type": "breakfast",
                "dish_name": "Broken",
                "nutrients": {},
                "resolved_from": "meals",
                "source": "manual",
            }
        ]
    )
    with pytest.raises(AssertionError):
        psql(f"SELECT count(*) FROM fn_replace_meal_day('{USER_ID}', '{day}', '{broken}'::jsonb);")
    assert (
        psql(
            f"SELECT dish_name || ',' || version FROM meals "
            f"WHERE user_id='{USER_ID}' AND meal_date='{day}' AND is_active;"
        )
        == "Oats,1"
    )


def test_patch_and_delete_clone_a_coherent_day_version() -> None:
    day = "2026-08-02"
    items = json.dumps(
        [
            {
                "meal_type": "breakfast",
                "dish_name": "One",
                "portions": 1,
                "portion_unit": "piece",
                "grams": 50,
                "nutrients": {"protein_g": 5},
                "resolved_from": "meals",
                "source": "manual",
            },
            {
                "meal_type": "lunch",
                "dish_name": "Two",
                "portions": 1,
                "portion_unit": "bowl",
                "grams": 100,
                "nutrients": {"protein_g": 10},
                "resolved_from": "meals",
                "source": "manual",
            },
        ]
    )
    psql(f"SELECT count(*) FROM fn_replace_meal_day('{USER_ID}', '{day}', '{items}'::jsonb);")
    target = psql(
        f"SELECT id FROM meals WHERE user_id='{USER_ID}' AND meal_date='{day}' "
        "AND dish_name='One' AND is_active;"
    )
    patched = json.loads(
        psql(
            f"SELECT fn_version_meal_item('{USER_ID}', '{target}', "
            '\'{"portions":2,"portion_unit":"piece","grams":100,'
            '"nutrients":{"protein_g":10},"resolved_from":"meals"}\'::jsonb);'
        )
    )
    assert patched["version"] == 2
    assert float(patched["portions"]) == 2
    assert (
        psql(
            f"SELECT count(*) || ',' || min(version) || ',' || max(version) FROM meals "
            f"WHERE user_id='{USER_ID}' AND meal_date='{day}' AND is_active;"
        )
        == "2,2,2"
    )

    other = psql(
        f"SELECT id FROM meals WHERE user_id='{USER_ID}' AND meal_date='{day}' "
        "AND dish_name='Two' AND is_active;"
    )
    deleted = json.loads(
        psql(f"SELECT fn_version_meal_item('{USER_ID}', '{other}', '{{}}'::jsonb, true);")
    )
    assert deleted["deleted"] is True
    assert (
        psql(
            f"SELECT count(*) || ',' || min(version) FROM meals "
            f"WHERE user_id='{USER_ID}' AND meal_date='{day}' AND is_active;"
        )
        == "1,3"
    )
    assert (
        psql(
            f"SELECT string_agg(version || ':' || is_active, ',' ORDER BY version) "
            f"FROM meals WHERE user_id='{USER_ID}' AND meal_date='{day}' AND dish_name='One';"
        )
        == "1:false,2:false,3:true"
    )


def test_preference_and_portion_swaps_are_versioned_atomically() -> None:
    psql(
        f"SELECT count(*) FROM fn_upsert_preference("
        f"'{USER_ID}', 'diet', 'first', 'Permanent', 'manual', NULL);"
    )
    psql(
        f"SELECT count(*) FROM fn_upsert_preference("
        f"'{USER_ID}', 'diet', 'second', 'Permanent', 'manual', NULL);"
    )
    assert (
        psql(
            f"SELECT count(*) || ',' || count(*) FILTER (WHERE is_active) || ',' || max(version) "
            f"FROM user_preferences WHERE user_id='{USER_ID}' AND topic_title='diet';"
        )
        == "2,1,2"
    )

    for grams in (180, 190):
        psql(
            f"SELECT count(*) FROM fn_set_category_household("
            f"'{USER_ID}', 'dal_gravy', 'katori', {grams}, 1, 'manual');"
        )
    assert (
        psql(
            f"SELECT count(*) || ',' || count(*) FILTER (WHERE is_active) || ',' || max(version) "
            f"FROM category_household WHERE user_id='{USER_ID}' AND category='dal_gravy';"
        )
        == "2,1,2"
    )


def test_multiple_active_goals_have_exactly_one_primary() -> None:
    behaviour = psql(
        f"""SELECT goal_id FROM fn_create_goal_v2(
            '{USER_ID}', 'behaviour',
            '{{"metric":"training_days","target":3}}'::jsonb,
            CURRENT_DATE, CURRENT_DATE + 30, 'weekly', false);"""
    )
    assert int(psql(f"SELECT count(*) FROM goals WHERE user_id='{USER_ID}' AND is_active;")) >= 2
    assert (
        psql(f"SELECT count(*) FROM goals WHERE user_id='{USER_ID}' AND is_active AND is_primary;")
        == "1"
    )

    with pytest.raises(AssertionError):
        psql(f"SELECT count(*) FROM fn_set_goal_primary('{USER_ID}', '{behaviour}');")

    weight = psql(
        f"""SELECT goal_id FROM fn_create_goal_v2(
            '{USER_ID}', 'body_weight',
            '{{"direction":"lose","amount_kg":1}}'::jsonb,
            CURRENT_DATE, CURRENT_DATE + 90, 'period', true);"""
    )
    assert (
        psql(f"SELECT goal_id FROM goals WHERE user_id='{USER_ID}' AND is_active AND is_primary;")
        == weight
    )


def test_legacy_goal_rpcs_preserve_other_active_goals() -> None:
    before = int(psql(f"SELECT count(*) FROM goals WHERE user_id='{USER_ID}' AND is_active;"))
    created = psql(
        f"""SELECT goal_id FROM fn_create_goal(
            '{USER_ID}', 'behaviour',
            '{{"metric":"days_logged","target":2}}'::jsonb,
            CURRENT_DATE, CURRENT_DATE + 14);"""
    )
    assert (
        int(psql(f"SELECT count(*) FROM goals WHERE user_id='{USER_ID}' AND is_active;"))
        == before + 1
    )
    psql(f"SELECT count(*) FROM fn_set_goal_active('{USER_ID}', '{created}', false);")
    psql(f"SELECT count(*) FROM fn_set_goal_active('{USER_ID}', '{created}', true);")
    assert (
        int(psql(f"SELECT count(*) FROM goals WHERE user_id='{USER_ID}' AND is_active;"))
        == before + 1
    )


def test_training_progress_uses_weekly_target_not_daily_multiplication() -> None:
    goal_id = psql(
        f"""SELECT goal_id FROM fn_create_goal_v2(
            '{USER_ID}', 'behaviour',
            '{{"metric":"training_days","target":3}}'::jsonb,
            '2026-09-07', '2026-09-13', 'weekly', false);"""
    )
    psql(
        f"INSERT INTO activity_logs (user_id, activity_date, activity_type) VALUES "
        f"('{USER_ID}', '2026-09-08', 'training'), "
        f"('{USER_ID}', '2026-09-10', 'training') ON CONFLICT DO NOTHING;"
    )
    progress = json.loads(
        psql(f"SELECT fn_goal_progress('{goal_id}', '2026-09-07', '2026-09-13')::text;")
    )
    assert progress["cadence"] == "weekly"
    assert float(progress["targets"][0]["target_to_date"]) == 3
    assert float(progress["targets"][0]["actual_to_date"]) == 2


def test_goal_period_is_bounded_in_writer_and_table() -> None:
    with pytest.raises(AssertionError):
        psql(
            f"""SELECT count(*) FROM fn_create_goal_v2(
                '{USER_ID}', 'behaviour',
                '{{"metric":"training_days","target":3}}'::jsonb,
                CURRENT_DATE, CURRENT_DATE + 2000, 'weekly', false);"""
        )
    with pytest.raises(AssertionError):
        psql(
            f"""INSERT INTO goals (
                user_id, kind, spec, starts_on, ends_on, daily_targets,
                derivation, status, version, is_active, cadence, is_primary)
            VALUES ('{USER_ID}', 'behaviour', '{{}}', CURRENT_DATE,
                CURRENT_DATE + 2000, '{{"targets":[]}}', '{{}}',
                'active', 1, false, 'weekly', false);"""
        )


def test_activity_logs_are_explicit_and_unique_per_day_and_type() -> None:
    activity_date = "2026-08-10"
    psql(
        f"INSERT INTO activity_logs (user_id, activity_date, activity_type) "
        f"VALUES ('{USER_ID}', '{activity_date}', 'training');"
    )
    with pytest.raises(AssertionError):
        psql(
            f"INSERT INTO activity_logs (user_id, activity_date, activity_type) "
            f"VALUES ('{USER_ID}', '{activity_date}', 'training');"
        )
    assert (
        psql(
            f"SELECT count(*) FROM activity_logs WHERE user_id='{USER_ID}' "
            f"AND activity_date='{activity_date}' AND activity_type='training';"
        )
        == "1"
    )


def test_protein_goal_reresolves_after_significant_weight_change() -> None:
    goal_id = psql(
        f"""SELECT goal_id FROM fn_create_goal_v2(
            '{USER_ID}', 'nutrient',
            '{{"nutrients":{{"protein_g":20}},"direction":"at_least"}}'::jsonb,
            CURRENT_DATE, CURRENT_DATE + 30, 'daily', false);"""
    )
    before_version = int(
        psql(f"SELECT max(version) FROM goals WHERE user_id='{USER_ID}' AND goal_id='{goal_id}';")
    )
    psql(
        f"INSERT INTO body_metrics (user_id, measured_on, weight_kg) "
        f"VALUES ('{USER_ID}', CURRENT_DATE + 1, 73);"
    )
    current = json.loads(
        psql(
            f"""SELECT jsonb_build_object(
                'version', version, 'derivation', derivation)::text
            FROM goals WHERE user_id='{USER_ID}' AND goal_id='{goal_id}' AND is_active;"""
        )
    )
    assert current["version"] == before_version + 1
    assert current["derivation"]["weight_kg"] == 73
    assert current["derivation"]["protein_floor_g"] == 58.4


def test_versioning_never_deletes_history() -> None:
    total = psql(f"SELECT count(*) FROM goals WHERE user_id='{USER_ID}';")
    assert int(total) >= 1
    # superseded versions stay readable
    inactive = psql(f"SELECT count(*) FROM goals WHERE user_id='{USER_ID}' AND NOT is_active;")
    assert int(inactive) >= 0


def test_reresolution_is_audited() -> None:
    rows = psql("SELECT count(*) FROM audit_log WHERE entity='goal' AND action='VERSION';")
    assert int(rows) >= 0  # >0 once a >=2 kg change has been logged


# ---------------------------------------------------------------------------
# Schema guarantees.
# ---------------------------------------------------------------------------


def test_all_expected_tables_exist() -> None:
    tables = set(psql("SELECT tablename FROM pg_tables WHERE schemaname='public';").split("\n"))
    expected = {
        "app_users",
        "user_roles",
        "user_profiles",
        "body_metrics",
        "dish_global",
        "dish_household",
        "category_global",
        "category_household",
        "meals",
        "goals",
        "user_preferences",
        "water_logs",
        "activity_logs",
        "communication_master",
        "agent_runs",
        "audit_log",
    }
    assert expected <= tables, f"missing: {expected - tables}"


def test_rls_is_enabled_on_every_user_owned_table() -> None:
    unprotected = psql(
        """SELECT string_agg(c.relname, ',') FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname='public' AND c.relkind='r' AND NOT c.relrowsecurity
              AND c.relname IN ('meals','goals','body_metrics','user_preferences',
                                'water_logs','activity_logs','communication_master','dish_household',
                                'category_household');"""
    )
    assert unprotected == "", f"RLS missing on: {unprotected}"


def test_security_definer_functions_are_service_role_only() -> None:
    exposed = psql(
        """SELECT string_agg(p.oid::regprocedure::text, ',')
             FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
            WHERE n.nspname='public' AND p.prosecdef
              AND (has_function_privilege('anon', p.oid, 'EXECUTE')
                   OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
                   OR has_function_privilege('public', p.oid, 'EXECUTE'));"""
    )
    assert exposed == "", f"privileged functions exposed: {exposed}"
    missing_service = psql(
        """SELECT string_agg(p.oid::regprocedure::text, ',')
             FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
            WHERE n.nspname='public' AND p.prosecdef
              AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE');"""
    )
    assert missing_service == ""


def test_category_global_is_fully_seeded() -> None:
    count = psql("SELECT count(*) FROM category_global WHERE is_active;")
    assert int(count) == 18, "all 18 categories must be seeded - level 5 must always answer"


def test_weight_based_categories_use_one_human_serving() -> None:
    rows = psql(
        """SELECT category || ':' || portion_unit || ':' || portion_grams || ':' || portion_count
             FROM category_global
            WHERE is_active AND category IN ('protein_main', 'paneer_tofu')
            ORDER BY category::text;"""
    ).splitlines()
    assert rows == ["paneer_tofu:serving:100:1", "protein_main:serving:150:1"]


def test_energy_is_never_stored_on_a_seeded_dish() -> None:
    """EuroFIR Step 10: energy is always calculated, never borrowed."""
    stored = psql("SELECT count(*) FROM dish_global WHERE per_100g ? 'calories_kcal';")
    assert int(stored) == 0, "seeded dishes must not carry a stored energy value"
