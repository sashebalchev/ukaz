import Data

/-!
# THE LAWS OF THE LAPTOP FAN. This is the file the human reads and signs.

The fan program (fw-fanctrl) has a table of points: at this temperature the fan runs at this speed.
Between two points it draws a straight line. The table lives in the system's own configuration
(modules/nixos/framework/fan-curve.nix); a copy of it is frozen next to this file (curve.json), and the gate
fails if the system ever says something different.

In plain words, for the table of this laptop:
  1. Up to 55 degrees the fan is off.
  2. Never louder than 30 percent up to 76 degrees (30 percent is about 3000 rpm and cannot be heard).
  3. From 62 degrees the fan runs at 30 percent or more, from 80 degrees at 38 percent or more,
     from 90 degrees at full speed.
  4. A hotter machine never gets a slower fan.
  5. The table itself is sensible: temperatures go up from point to point, speeds never go down, nothing
     is above 100 percent.
"Never" and "from" mean every temperature, not a list of tried ones.

What this does NOT say: that the fan program really follows the table with straight lines (its manual says so),
that the laptop's fan follows what the program writes, and what happens when a temperature reading fails
(fw-fanctrl then assumes 50 degrees, which is "off": that is law F-03 and it cannot be met today).
-/

namespace Fan

/-- One point of the curve: at this temperature (whole degrees Celsius) the fan runs at this speed (whole percent). -/
abbrev Point := Nat × Nat

/-- A curve is its points, coolest first. -/
abbrev Curve := List Point

/-- The speed the fan program picks: a straight line between the two points around the temperature, rounded down.
Below the first point it is the first speed, above the last point it stays at the last speed. -/
def speedFrom : Point → Curve → Nat → Nat
  | (_, s), [], _ => s
  | (t0, s0), (t1, s1) :: rest, t =>
    if t ≤ t0 then s0
    else if t ≤ t1 then s0 + (s1 - s0) * (t - t0) / (t1 - t0)
    else speedFrom (t1, s1) rest t

/-- The fan speed (percent) of a curve at a temperature (degrees). An empty curve means a stopped fan. -/
def speed : Curve → Nat → Nat
  | [], _ => 0
  | p :: rest, t => speedFrom p rest t

/-- Is the curve sensible after this point: temperatures strictly rise, speeds never fall, none is above 100. -/
def sensibleFrom : Point → Curve → Bool
  | (_, s), [] => decide (s ≤ 100)
  | (t0, s0), (t1, s1) :: rest => decide (t0 < t1 ∧ s0 ≤ s1) && sensibleFrom (t1, s1) rest

/-- A curve is sensible if it has a point and every step after it is sensible. -/
def sensible : Curve → Bool
  | [] => false
  | p :: rest => sensibleFrom p rest

/-- The laws of the fan, for one curve. -/
structure Laws (c : Curve) : Prop where
  /-- The table itself makes sense. -/
  sensible_table : sensible c = true
  /-- Up to 55 degrees the fan is off. -/
  off_when_cool : ∀ t, t ≤ 55 → speed c t = 0
  /-- Up to 76 degrees the fan is never louder than 30 percent. -/
  quiet_when_warm : ∀ t, t ≤ 76 → speed c t ≤ 30
  /-- From 62 degrees the fan runs at 30 percent or more. -/
  helps_when_warm : ∀ t, 62 ≤ t → 30 ≤ speed c t
  /-- From 80 degrees at 38 percent or more. -/
  firmer_when_hot : ∀ t, 80 ≤ t → 38 ≤ speed c t
  /-- From 90 degrees at full speed. -/
  full_when_very_hot : ∀ t, 90 ≤ t → speed c t = 100
  /-- A hotter machine never gets a slower fan. -/
  hotter_is_never_slower : ∀ t₁ t₂, t₁ ≤ t₂ → speed c t₁ ≤ speed c t₂

/-- The curve in this laptop's configuration keeps all the laws. -/
theorem fan_ok : Laws FanData.quietCurve := sorry

end Fan
