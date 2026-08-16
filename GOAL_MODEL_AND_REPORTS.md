# Goal Model And Reporting Contract

This document records the audited goal behavior and the required reporting
contract. It distinguishes calculations that exist today from planned product
behavior. Goal charts must never imply that an unsupported target was calculated.

## Goal Families

The customer UI exposes seven choices in four conceptual families:

| Family | Customer choices |
| --- | --- |
| Body composition | Weight loss or weight gain |
| Direct nutrition | Calories, protein, carbohydrates, fat |
| Hydration | Daily water |
| Training behavior | Training days |

An item/food target also exists in the domain but is not exposed by the standard
goal builder.

## Weight Loss And Gain

Weight goals are composite plans. They use the customer's latest weight, height,
age, sex, activity level, diet, requested weight change, target date,
pregnancy/nursing status, and medical-condition flag.

The resolver calculates:

- BMI from height and weight.
- BMR with Mifflin-St Jeor.
- TDEE from BMR and the selected activity multiplier.
- Requested and safe weekly weight-change rates.
- A calorie deficit or surplus.
- Daily calories, protein, carbohydrates, fat, and beverage-water targets.
- Target weight, target BMI, and a planned weight trajectory.

The maximum applied rate is the lower of 1 kg/week and 1% of body weight/week.
For loss, intake cannot fall below the greater of the sex-specific floor
(1,200 kcal for women or 1,500 kcal for men) and 70% of BMR. A requested loss
that would produce BMI below 18.5 is rejected. Pregnancy/nursing and disclosed
medical conditions block automatic weight planning.

Protein is currently 1.6 g/kg for both loss and gain. Fat receives 27% of planned
calories. Carbohydrates receive the remaining calories after protein and fat.
Water is the beverage fraction (80%) of a weight-, sex-, and activity-based
hydration estimate.

BMI is a safety guard, not a diagnosis or an automatic choice of how many
kilograms the customer should lose. Waist, body-fat percentage, lean mass,
workout details, and micronutrient targets are not currently used.

### Required weight-goal reports

The main chart must plot date on the x-axis and kilograms on the y-axis, with
planned weight trajectory and actual recorded weight. Supporting tabs must plot
daily actual versus planned values for:

1. Calories (kcal/day)
2. Protein (g/day)
3. Carbohydrates (g/day)
4. Fat (g/day)
5. Water (ml/day)

## Direct Nutrition Goals

Direct calorie, protein, carbohydrate, and fat goals are independent daily
targets.

- Calories: customer-stated target with the calorie safety floor applied.
- Protein: customer-stated target with a minimum of 0.8 g/kg.
- Carbohydrates: customer-stated target evaluated within a 10% band.
- Fat: customer-stated target evaluated within a 10% band.

These goals do not automatically generate each other and can be mutually
inconsistent. A future validation step should warn when macro energy conflicts
with a simultaneous calorie target.

### Required direct-goal reports

Direct goal charts are not cumulative. They must plot:

- X-axis: date.
- Y-axis: the goal metric in its declared unit.
- Actual amount recorded that day.
- Daily target line or target band.
- A visible gap for missing data, never an invented zero.

## Hydration

Hydration uses latest weight, sex, activity, and the customer-entered target. The
profile reference is weight-, sex-, and activity-adjusted. Targets at or above
10,000 ml/day, or more than twice the profile estimate, are rejected. This is a
water-log target and does not claim to measure physiological hydration status.

Its chart uses date on the x-axis and ml/day on the y-axis, with recorded water
and the daily target.

## Training

Training currently means explicit training-day check-ins only. It does not
calculate calories, protein, carbohydrates, fat, workout energy, exercise
duration, strength/endurance requirements, muscle gain, or recovery.

The only honest current chart compares completed training days with target days
for the selected weekly, monthly, or full-period cadence.

A composite Fitness or Muscle Gain plan must be a separate future model. It
would require an objective, training type, frequency, duration, and appropriate
body-composition inputs before generating nutrition targets.

## Recalculation

Profile-dependent active goals (weight, hydration, and protein) are versioned and
re-resolved after relevant profile/activity changes, after sufficient time, or
after a meaningful weight change. Historical versions remain auditable.

## Trends Page Structure

The Trends page has one range selector only:

- 7 days: daily buckets.
- 4 weeks: weekly buckets.
- 3 months: weekly buckets.
- 1 year: monthly buckets.

General intake, nutrition, water, and body reports appear first. Goal reporting
appears below them with one tab per active goal. Each composite goal exposes all
targets that the resolver actually generated. Missing values remain missing.
