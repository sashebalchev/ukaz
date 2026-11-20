import Challenge

/-! Deliberately wrong pacers. Each one is proved NOT to satisfy the laws, showing the law is not too weak. -/

set_option maxRecDepth 20000

namespace Pacer

instance (now : Nat) (h : History) : Decidable (GapOk now h) := by
  cases h with
  | nil => exact isTrue trivial
  | cons t rest => exact inferInstanceAs (Decidable (t + 5 ≤ now))

theorem not_laws_of_spaced (s : Nat → History → History) (times : List Nat) (a b : Nat) (rest : History)
    (e : replay s times = a :: b :: rest) (hab : a < b + 5) : ¬ Laws s := by
  intro hl
  have := hl.spaced times
  rw [e] at this
  have h1 : b + 5 ≤ a := this.1
  omega

theorem not_laws_of_capped (s : Nat → History → History) (times : List Nat) (t : Nat) (rest : History)
    (e : replay s times = t :: rest) (hc : 40 < count t (t :: rest)) : ¬ Laws s := by
  intro hl
  have := hl.capped times
  rw [e] at this
  have h1 : count t (t :: rest) ≤ 40 := this
  omega

/-- helper: gap test and count test -/
def ok (g cap : Nat) (hr : Nat → Nat → Bool) (now : Nat) (h : History) : Bool :=
  (match h with | [] => true | t :: _ => decide (t + g ≤ now)) && decide ((h.filter (hr now)).length + 1 ≤ cap)

def pace (g cap : Nat) (hr : Nat → Nat → Bool) (now : Nat) (h : History) : History :=
  if ok g cap hr now h then now :: h else h

-- 1. gap 4 instead of 5
def badGap4 := pace 4 40 inside
theorem badGap4_bad : ¬ Laws badGap4 :=
  not_laws_of_spaced _ [0, 4] 4 0 [] (by decide) (by decide)

-- 2. cap 41 instead of 40
def badCap41 := pace 5 41 inside
theorem badCap41_bad : ¬ Laws badCap41 :=
  not_laws_of_capped _ ((List.range 41).map (· * 5)) 200 (((List.range 40).map (· * 5)).reverse)
    (by decide) (by decide)

-- 3. forgets the history on refusal
def badForget (now : Nat) (h : History) : History :=
  if ok 5 40 inside now h then now :: h else []
theorem badForget_bad : ¬ Laws badForget := by
  intro hl
  have := hl.silent 1 [0]
  revert this; decide

-- 4. always refuses (killed by law 3)
def badRefuse (_now : Nat) (h : History) : History := h
theorem badRefuse_bad : ¬ Laws badRefuse := by
  intro hl
  have := hl.permitted 0 [] trivial (by decide)
  revert this; decide

-- 5. always allows
def badAllow (now : Nat) (h : History) : History := now :: h
theorem badAllow_bad : ¬ Laws badAllow :=
  not_laws_of_spaced _ [0, 0] 0 0 [] (by decide) (by decide)

-- 6. allows backwards time (a gap of 5 in either direction)
def badBack (now : Nat) (h : History) : History :=
  let g := match h with | [] => true | t :: _ => decide (t + 5 ≤ now ∨ now + 5 ≤ t)
  if g && decide (count now h + 1 ≤ 40) then now :: h else h
theorem badBack_bad : ¬ Laws badBack :=
  not_laws_of_spaced _ [10, 0] 0 10 [] (by decide) (by decide)

-- 7. counts the whole history instead of the hour
def badWhole (now : Nat) (h : History) : History :=
  let g := match h with | [] => true | t :: _ => decide (t + 5 ≤ now)
  if g && decide (h.length + 1 ≤ 40) then now :: h else h
theorem badWhole_bad : ¬ Laws badWhole := by
  intro hl
  have := hl.permitted 3600 ((List.range 40).map (· * 5)).reverse (by decide) (by decide)
  revert this; decide

-- 8. off by one at 3600: a read exactly 3600 s old still counts
def badEdgeLong := pace 5 40 (fun now t => decide (now ≤ t + 3600))
theorem badEdgeLong_bad : ¬ Laws badEdgeLong := by
  intro hl
  have := hl.permitted 3600 ((List.range 40).map (· * 5)).reverse (by decide) (by decide)
  revert this; decide

-- 9. off by one the other way: the hour is only 3599 s, a 41st read slips in
def badEdgeShort := pace 5 40 (fun now t => decide (now + 1 < t + 3600))
theorem badEdgeShort_bad : ¬ Laws badEdgeShort :=
  not_laws_of_capped _ (((List.range 40).map (· * 5)) ++ [3599]) 3599
    (((List.range 40).map (· * 5)).reverse) (by decide) (by decide)

-- 10. cap 39 instead of 40: refuses the 40th read
def badCap39 := pace 5 39 inside
theorem badCap39_bad : ¬ Laws badCap39 := by
  intro hl
  have := hl.permitted 195 ((List.range 39).map (· * 5)).reverse (by decide) (by decide)
  revert this; decide

-- 11. gap 6 instead of 5: refuses a read exactly 5 s later
def badGap6 := pace 6 40 inside
theorem badGap6_bad : ¬ Laws badGap6 := by
  intro hl
  have := hl.permitted 5 [0] (by decide) (by decide)
  revert this; decide

-- 12. records the wrong time (now + 1) when allowing
def badStamp (now : Nat) (h : History) : History :=
  if ok 5 40 inside now h then (now + 1) :: h else h
theorem badStamp_bad : ¬ Laws badStamp := by
  intro hl
  have := hl.permitted 0 [] trivial (by decide)
  revert this; decide

-- 13. no cap at all (only the gap is checked)
def badNoCap := pace 5 1000000 inside
theorem badNoCap_bad : ¬ Laws badNoCap :=
  not_laws_of_capped _ ((List.range 41).map (· * 5)) 200 (((List.range 40).map (· * 5)).reverse)
    (by decide) (by decide)

#print axioms badGap4_bad
#print axioms badCap41_bad
#print axioms badForget_bad
#print axioms badRefuse_bad
#print axioms badAllow_bad
#print axioms badBack_bad
#print axioms badWhole_bad
#print axioms badEdgeLong_bad
#print axioms badEdgeShort_bad
#print axioms badCap39_bad
#print axioms badGap6_bad
#print axioms badStamp_bad
#print axioms badNoCap_bad

end Pacer
