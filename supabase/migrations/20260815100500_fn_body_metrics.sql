-- Pure formulas. IMMUTABLE, no table access, each carrying its source in a
-- COMMENT ON FUNCTION so the provenance of a number is queryable rather than
-- buried in a docstring.
--
-- These live in Postgres rather than Python so that a weight change propagates
-- through the whole derivation chain via triggers, with one definition that the
-- app, a trigger, an admin backfill and a reporting query all share.
--
-- NOTE: never raise SQLSTATE 40001 or 40P01 from anything reachable over HTTP.
-- PostgREST retries those server-side in an infinite loop even after the client
-- disconnects. Use PT409 for conflict semantics.

-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_bmi(p_weight_kg numeric, p_height_cm numeric)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
        WHEN p_weight_kg IS NULL OR p_height_cm IS NULL OR p_height_cm <= 0 THEN NULL
        ELSE round(p_weight_kg / power(p_height_cm / 100.0, 2), 2)
    END;
$$;
COMMENT ON FUNCTION fn_bmi IS
  'BMI kg/m2. Categories are half-open intervals - the commonly printed WHO
   table (24.9 / 25.0) has gaps. India: Misra et al. 2025 sets the obesity
   threshold at BMI >= 23, but STAGING needs waist + comorbidities, so with
   height/weight alone report a grade, never a stage.';

-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_bmr_mifflin(
    p_weight_kg numeric, p_height_cm numeric, p_age integer, p_sex biological_sex)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
        WHEN p_weight_kg IS NULL OR p_height_cm IS NULL OR p_age IS NULL OR p_sex IS NULL
            THEN NULL
        ELSE round(
            10 * p_weight_kg + 6.25 * p_height_cm - 5 * p_age
            + CASE WHEN p_sex = 'male' THEN 5 ELSE -161 END, 0)
    END;
$$;
COMMENT ON FUNCTION fn_bmr_mifflin IS
  'Mifflin-St Jeor 1990, Am J Clin Nutr 51:241. Uses ACTUAL body weight.
   ~82% of non-obese fall within +-10% of measured RMR versus ~45-50% for
   Harris-Benedict (Frankenfield 2005, J Am Diet Assoc 105:775). Recommended
   by the Academy of Nutrition and Dietetics EAL. Surface the error band:
   even the best equation is >10% wrong for ~1 in 5 people.
   ICMR-NIN 2020 notes FAO/WHO/UNU equations overestimate Indian BMR by
   10-12%; there is no validated Indian Mifflin analogue, so we widen the
   displayed band rather than silently applying a correction.';

-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_tdee(p_bmr numeric, p_activity activity_level)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE WHEN p_bmr IS NULL THEN NULL ELSE round(p_bmr * CASE p_activity
        WHEN 'sedentary'    THEN 1.20    -- NOTE: below FAO/WHO/UNU's lowest
        WHEN 'light'        THEN 1.375   -- free-living value of 1.40. ICMR-NIN
        WHEN 'moderate'     THEN 1.55    -- 2020 lowered Indian sedentary to 1.40.
        WHEN 'very_active'  THEN 1.725
        WHEN 'extra_active' THEN 1.90
    END, 0) END;
$$;
COMMENT ON FUNCTION fn_tdee IS
  'PAL multipliers from McArdle, Exercise Physiology 1996 - a textbook
   heuristic, NOT from Harris-Benedict and NOT from FAO/WHO/UNU. The verbal
   descriptions are the single largest error source in the whole chain,
   larger than the choice of BMR equation.
   PAL already contains TEF, EAT and NEAT - do NOT add TEF on top. That
   double-count is worth ~200-300 kcal/day and is a common app bug.';

-- ---------------------------------------------------------------------------
-- rate_kg_per_week * 1100 is the identity worth memorising.
-- K = 7700 kcal/kg (Wishnofsky 1958, Am J Clin Nutr 6:542).
CREATE OR REPLACE FUNCTION fn_daily_deficit(p_target_kg numeric, p_weeks numeric)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
        WHEN p_weeks IS NULL OR p_weeks <= 0 THEN NULL
        ELSE round((p_target_kg * 7700.0) / (p_weeks * 7.0), 0)
    END;
$$;
COMMENT ON FUNCTION fn_daily_deficit IS
  'The 7700 kcal/kg rule is STATIC physics applied to a dynamic system. As
   weight falls BMR falls, so it predicts unbounded linear loss and never a
   plateau, overestimating by roughly 2x over a year (Hall & Chow 2013,
   Int J Obes 37:1614). Never straight-line the projection to the goal date.';

-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_safe_rate_kg_per_week(p_weight_kg numeric)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
    SELECT least(1.0, round(0.01 * p_weight_kg, 2));
$$;
COMMENT ON FUNCTION fn_safe_rate_kg_per_week IS
  'Percentage-based clamp: min(1.0 kg/week, 1% body weight/week). A fixed
   1 kg/week is far more aggressive for a 50 kg woman than a 130 kg man.
   CDC 1-2 lb/wk, NHS 0.5-1 kg/wk, NICE NG246 600 kcal/day deficit.';

-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_calorie_floor(p_sex biological_sex, p_bmr numeric)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
    SELECT greatest(
        CASE WHEN p_sex = 'male' THEN 1500 ELSE 1200 END,
        round(0.70 * coalesce(p_bmr, 0), 0)
    );
$$;
COMMENT ON FUNCTION fn_calorie_floor IS
  'NIH/NHLBI and the 2013 AHA/ACC/TOS guideline prescribe 1200 kcal (F) /
   1500 kcal (M). That band is PRESCRIPTIVE for supervised diets, not a
   physiological universal, and it is not body-size adjusted - hence the
   0.70*BMR term. Below 800 kcal/day is a VLCD requiring medical supervision
   and is REFUSED outright, not clamped.';

-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_protein_target_g(
    p_weight_kg numeric, p_direction text, p_diet diet_type)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
    SELECT round(p_weight_kg * CASE
        WHEN p_direction = 'lose' THEN 1.6
        WHEN p_direction = 'gain' THEN 1.6
        WHEN p_diet IN ('vegetarian', 'vegan', 'jain') THEN 1.0
        ELSE 0.83
    END, 0);
$$;
COMMENT ON FUNCTION fn_protein_target_g IS
  'Weight loss / general population 1.2-1.6 g/kg. Muscle gain benefit
   plateaus at ~1.62 g/kg (Morton 2018, BJSM 52:376), ceiling 2.2.
   ISSN''s 2.3-3.1 g/kg figure is per kg of FAT-FREE MASS, not body weight -
   the most commonly mis-implemented number in the field, so it is not used
   here. Indian vegetarian baseline 1.0 g/kg per the ICMR-NIN 2020 footnote
   for cereal-based diets; ICMR RDA otherwise 0.83 g/kg.';

-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_hydration_ml(
    p_weight_kg numeric, p_sex biological_sex, p_activity activity_level)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
    SELECT round(p_weight_kg * CASE
        WHEN p_sex = 'male' THEN
            CASE WHEN p_activity IN ('very_active','extra_active') THEN 58
                 WHEN p_activity = 'moderate' THEN 45 ELSE 32 END
        ELSE
            CASE WHEN p_activity IN ('very_active','extra_active') THEN 52
                 WHEN p_activity = 'moderate' THEN 40 ELSE 27 END
    END, 0);
$$;
COMMENT ON FUNCTION fn_hydration_ml IS
  'ICMR-NIN 2020 is per-kg and activity-scaled (men 32/45/58, women 27/40/52
   mL/kg/day), unlike the flat IOM (3.7/2.7 L) and EFSA (2.5/2.0 L) figures.
   Those INCLUDE food moisture, so a beverage-only target is ~80% of total -
   comparing a water log to 3.7 L is simply wrong.
   Overhydration is a real risk: ACSM names intake exceeding sweat rate as the
   primary cause of exercise-associated hyponatremia. Never nag past thirst,
   and honour a clinician-set fluid limit.';

-- ---------------------------------------------------------------------------
-- Energy is ALWAYS computed from macros, never stored or borrowed.
-- EuroFIR recipe guideline, Step 10, verbatim: "Do not borrow data on energy
-- values. They should be always calculated."
CREATE OR REPLACE FUNCTION fn_energy_kcal(p_nutrients jsonb)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
    SELECT round(
        4 * coalesce((p_nutrients->>'protein_g')::numeric, 0)
      + 4 * coalesce((p_nutrients->>'carbs_g')::numeric, 0)
      + 9 * coalesce((p_nutrients->>'fat_g')::numeric, 0)
      + 2 * coalesce((p_nutrients->>'fiber_g')::numeric, 0), 0);
$$;
COMMENT ON FUNCTION fn_energy_kcal IS
  'Atwater factors: carb 4, protein 4, fat 9, fibre ~2 kcal/g. Stored energy
   drifts out of agreement with the macros beside it and users notice.';
