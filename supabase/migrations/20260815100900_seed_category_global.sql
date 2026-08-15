-- Seed: the 18 global category portions.
--
-- This is the level that ALWAYS answers, so it must be complete before
-- anything else works. Each row records its `source` because only 7 of the 18
-- have a real Indian evidential basis:
--
--   ICMR_DGI_2024      - a published standard (tbsp 15 g, tsp 5 g, nut allowance)
--   Sharma_Chadha_2020 - the ONLY weighed Indian portion study (n=60, Delhi),
--                        the single source of truth for dal, rice, sabzi, curd
--   NIN_2011           - the serving definitions (raw basis, scaled here)
--   judgement          - a placeholder. No Indian source exists.
--
-- WARNING recorded for whoever edits this next: the "1 katori dal = 150 g"
-- figure circulating on Indian nutrition sites is ~40% BELOW the only weighed
-- measurement (median 242 g, IQR 212-341), and those sites cite IFCT 2017 for
-- it - a document that contains no portion sizes at all. Do not "correct"
-- these values from blogs.

INSERT INTO category_global (category, portion_unit, portion_grams, portion_count, source)
VALUES
    ('dal_gravy',     'katori',  200, 1, 'Sharma_Chadha_2020'),
    ('dry_sabzi',     'katori',  150, 1, 'Sharma_Chadha_2020'),
    ('rice_grain',    'bowl',    150, 1, 'Sharma_Chadha_2020'),
    ('flatbread',     'piece',    45, 2, 'Sharma_Chadha_2020'),  -- ONE portion = 2 rotis
    ('idli',          'piece',    40, 2, 'judgement'),
    ('dosa',          'piece',    90, 1, 'judgement'),
    ('protein_main',  'g',         1, 150, 'NIN_2011'),          -- 150 g cooked
    ('paneer_tofu',   'g',         1, 100, 'judgement'),
    ('egg',           'piece',    50, 2, 'ICMR_DGI_2024'),
    ('curd_raita',    'katori',  150, 1, 'Sharma_Chadha_2020'),
    ('salad_raw',     'serving', 100, 1, 'NIN_2011'),
    ('fruit',         'piece',   120, 1, 'NIN_2011'),
    ('beverage_milk', 'glass',   200, 1, 'NIN_2011'),
    ('beverage_hot',  'cup',     150, 1, 'judgement'),
    ('snack_fried',   'piece',    40, 2, 'judgement'),
    ('sweet',         'piece',    40, 1, 'judgement'),
    ('nuts_seeds',    'handful',  25, 1, 'ICMR_DGI_2024'),
    ('fat_oil',       'tsp',       5, 1, 'ICMR_DGI_2024')
ON CONFLICT DO NOTHING;
