import Challenge

/-! Deliberately wrong curves. Each one is proved NOT to satisfy the laws, showing the law is not too weak. -/

set_option maxRecDepth 20000

namespace Fan

/-- The fan already runs at 10 percent at 50 degrees. -/
def badOn50 : Curve := [(0, 0), (50, 10), (62, 30), (76, 30), (80, 38), (90, 100)]
theorem badOn50_bad : ¬ Laws badOn50 := by
  intro h
  have := h.off_when_cool 50 (by decide)
  revert this
  decide

/-- Louder than 30 percent at 70 degrees (50 percent). -/
def badLoud70 : Curve := [(0, 0), (55, 0), (62, 30), (70, 50), (80, 50), (90, 100)]
theorem badLoud70_bad : ¬ Laws badLoud70 := by
  intro h
  have := h.quiet_when_warm 70 (by decide)
  revert this
  decide

/-- Still below 30 percent at 65 degrees (stuck at 20 percent). -/
def badQuiet65 : Curve := [(0, 0), (55, 0), (62, 20), (76, 20), (80, 38), (90, 100)]
theorem badQuiet65_bad : ¬ Laws badQuiet65 := by
  intro h
  have := h.helps_when_warm 65 (by decide)
  revert this
  decide

/-- Only 36 percent at 82 degrees: below 38. -/
def badSoft82 : Curve := [(0, 0), (55, 0), (62, 30), (76, 30), (80, 30), (84, 36), (90, 100)]
theorem badSoft82_bad : ¬ Laws badSoft82 := by
  intro h
  have := h.firmer_when_hot 82 (by decide)
  revert this
  decide

/-- Tops out at 90 percent, so 92 degrees is not full speed. -/
def badNotFull92 : Curve := [(0, 0), (55, 0), (62, 30), (76, 30), (80, 38), (90, 90)]
theorem badNotFull92_bad : ¬ Laws badNotFull92 := by
  intro h
  have := h.full_when_very_hot 92 (by decide)
  revert this
  decide

/-- The table lists a speed that goes down: 52 percent at 84 degrees, then 40 percent at 87. -/
def badDips : Curve := [(0, 0), (55, 0), (62, 30), (76, 30), (80, 38), (84, 52), (87, 40), (90, 100)]
theorem badDips_bad : ¬ Laws badDips := by
  intro h
  have := h.sensible_table
  revert this
  decide

/-- A speed of 120 percent. -/
def badOver100 : Curve := [(0, 0), (55, 0), (62, 30), (76, 30), (80, 38), (90, 120)]
theorem badOver100_bad : ¬ Laws badOver100 := by
  intro h
  have := h.sensible_table
  revert this
  decide

/-- Temperatures do not rise: 76 is followed by 70. -/
def badTempsBack : Curve := [(0, 0), (55, 0), (62, 30), (76, 30), (70, 38), (90, 100)]
theorem badTempsBack_bad : ¬ Laws badTempsBack := by
  intro h
  have := h.sensible_table
  revert this
  decide

/-- No points at all. -/
def badEmpty : Curve := []
theorem badEmpty_bad : ¬ Laws badEmpty := by
  intro h
  have := h.sensible_table
  revert this
  decide

/-- The fan never turns on: 0 percent everywhere. -/
def badNeverOn : Curve := [(0, 0), (90, 0)]
theorem badNeverOn_bad : ¬ Laws badNeverOn := by
  intro h
  have := h.helps_when_warm 62 (by decide)
  revert this
  decide

/-- The fan runs at 100 percent from the very first point. -/
def badAlwaysOn : Curve := [(0, 100)]
theorem badAlwaysOn_bad : ¬ Laws badAlwaysOn := by
  intro h
  have := h.off_when_cool 0 (by decide)
  revert this
  decide

#print axioms badOn50_bad
#print axioms badLoud70_bad
#print axioms badQuiet65_bad
#print axioms badSoft82_bad
#print axioms badNotFull92_bad
/-- A dip that the table check and the speed rule both see: at 87 degrees the fan is at 52, at 88 only at 45. -/
def badDipsLater : Curve := [(0, 0), (55, 0), (62, 30), (76, 30), (80, 38), (84, 52), (87, 40), (88, 45), (90, 100)]
theorem badDipsLater_bad : ¬ Laws badDipsLater := by
  intro h
  have := h.hotter_is_never_slower 87 88 (by decide)
  revert this
  decide

#print axioms badDips_bad
#print axioms badDipsLater_bad
#print axioms badOver100_bad
#print axioms badTempsBack_bad
#print axioms badEmpty_bad
#print axioms badNeverOn_bad
#print axioms badAlwaysOn_bad

end Fan
