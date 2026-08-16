-- Existing body-weight goals predate cadence and represent one fixed period.
UPDATE public.goals
   SET cadence = 'period'::goal_cadence,
       updated_at = now()
 WHERE kind = 'body_weight'
   AND cadence <> 'period'::goal_cadence;
