# The fan law in plain English (read from the Lean text only)

## What the law is about
The fan program has a table of points. Each point says: at this temperature (in whole degrees Celsius) the fan runs at this speed (in whole percent of full speed). Between two points the program draws a straight line to find the speed. The law is about the table of THIS laptop, a copy of which is frozen in curve.json.

## The definitions, one sentence each
- **Point**: a pair (temperature, speed), for example (62, 30) means "at 62 degrees, 30 percent".
- **Curve**: a list of points, coolest first.
- **speedFrom**: given a point and the rest of the list, it finds the speed at a temperature: at or below the point's own temperature it gives the point's speed; otherwise, if the temperature is within the next point, it goes along the straight line to it, rounding down to a whole percent; otherwise it moves on to the next pair of points. If the list runs out, the last speed stays.
- **speed**: the fan speed of a curve at a temperature. A curve with no points gives 0 (a stopped fan); otherwise it starts from the first point.
- **sensibleFrom / sensible**: checks the table itself. Temperatures must rise strictly from point to point (never equal, never going back), speeds must never fall from point to point, the last speed is at most 100, and the table must have at least one point.
- **Laws**: the seven things below, all true for the curve.

## The seven fields of Laws
1. **sensible_table**: the table passes the check above.
2. **off_when_cool**: at every temperature up to and including 55 the fan speed is 0.
3. **quiet_when_warm**: at every temperature up to and including 76 the speed is 30 percent or less.
4. **helps_when_warm**: at every temperature from 62 upward the speed is 30 percent or more.
5. **firmer_when_hot**: from 80 upward the speed is 38 percent or more.
6. **full_when_very_hot**: from 90 upward the speed is exactly 100 percent.
7. **hotter_is_never_slower**: for any two temperatures, the hotter one never gets a lower speed than the cooler one.

"Every temperature" means every whole number, not a list of tried ones.

## Things that surprised me or can be misread
- **Exactly 55 is still off** ("up to 55" includes 55). At 56 the fan is already on: the table gives 4 percent.
- **Between points the speed is rounded down**, so for example 58 degrees gives 12 percent, not 12.9, and 85 gives 58, not 58.7.
- **Above the last point (90) the speed stays at the last speed.** So 95 or 150 degrees gives 100 percent. Below the first point (0) the speed is the first speed.
- **A curve with no points** has a stopped fan (speed 0 everywhere). The table check rejects it, so it can never pass the law.
- **"Never louder than 30" is only up to 76 degrees.** The law says nothing about how loud the fan may be between 77 and 89 degrees, except the minimums (38 from 80) and the rising rule. Also, 30 percent is described as "about 3000 rpm and cannot be heard" in the header; that is a claim in words, not something the Lean checks.
- **Temperatures are whole degrees** and the speeds are whole percents. Fractions such as 55.5 do not exist in this model; what the real program does with a fractional reading is not covered.
- **Between 55 and 62 and between 76 and 80 the law only fixes the ends.** For example a curve that jumps from 30 percent at 76 degrees straight to 100 percent at 77 would pass all the laws.
- **Rule 7 adds little on top of rule 1**: a table whose speeds never fall already makes the speed never fall. It is a safety net, not a second requirement.
- **The law is about the table, not the real fan.** It does not say the fan program follows the table with straight lines, that the laptop's fan follows what the program writes, or what happens when a temperature reading fails (the program then assumes 50 degrees, which is "off"; that is a separate law, F-03, not met today).
- **The table is frozen.** The law talks about the copy in curve.json; the gate fails if the system's own configuration says something different.
- **The law says nothing about time**: how fast the fan changes speed, delays or hysteresis (waiting before slowing down) are not covered.
