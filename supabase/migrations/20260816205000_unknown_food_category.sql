-- Keep the enum change isolated because PostgreSQL cannot use a newly added
-- enum value inside the same migration transaction.
ALTER TYPE public.food_category ADD VALUE IF NOT EXISTS 'unknown';
