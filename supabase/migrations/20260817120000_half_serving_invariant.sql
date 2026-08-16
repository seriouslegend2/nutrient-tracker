-- Meal serving counts are always positive half-unit increments. Exact grams,
-- nutrient quantities, and household portion preferences are intentionally exempt.

CREATE OR REPLACE FUNCTION public.fn_normalize_meal_servings()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
    IF NEW.portions IS NULL OR NEW.portions <= 0 THEN
        RAISE EXCEPTION 'Meal servings must be a positive number'
            USING ERRCODE = '22023', HINT = 'invalid_meal_servings';
    END IF;
    NEW.portions := trim_scale(greatest(0.5, floor(NEW.portions * 2 + 0.5) / 2));
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS normalize_meal_servings ON public.meals;
CREATE TRIGGER normalize_meal_servings
BEFORE INSERT OR UPDATE OF portions ON public.meals
FOR EACH ROW EXECUTE FUNCTION public.fn_normalize_meal_servings();

UPDATE public.meals
SET portions = greatest(0.5, floor(portions * 2 + 0.5) / 2)
WHERE portions < 0.5 OR portions * 2 <> trunc(portions * 2);

ALTER TABLE public.meals
DROP CONSTRAINT IF EXISTS meals_half_servings_check;
ALTER TABLE public.meals
ADD CONSTRAINT meals_half_servings_check
CHECK (portions >= 0.5 AND portions * 2 = trunc(portions * 2));

REVOKE ALL ON FUNCTION public.fn_normalize_meal_servings() FROM PUBLIC, anon, authenticated;
