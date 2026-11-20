import Challenge

/-! Strength certificate: any two step functions that satisfy the four laws behave identically
on every request sequence. -/

namespace Pacer

theorem replay_snoc (s : Nat → History → History) (l : List Nat) (x : Nat) :
    replay s (l ++ [x]) = s x (replay s l) := by
  simp [replay, List.foldl_append]

theorem count_cons_self (x : Nat) (h : History) : count x (x :: h) = count x h + 1 := by
  simp [count, inside]

/-- If the history after a request is `now :: h`, then the request met both permission conditions. -/
theorem perm_of_spaced_capped (x : Nat) (h : History)
    (hs : Spaced (x :: h)) (hc : Capped (x :: h)) : GapOk x h ∧ count x h + 1 ≤ 40 := by
  constructor
  · cases h with
    | nil => exact trivial
    | cons t rest => exact hs.1
  · have := hc
    simp only [Capped] at this
    rw [count_cons_self] at this
    exact this

open Classical in
/-- On a history reached by the pacer itself, the step is exactly "add iff permitted". -/
theorem step_iff (s : Nat → History → History) (hl : Laws s) (l : List Nat) (x : Nat) :
    s x (replay s l) = if GapOk x (replay s l) ∧ count x (replay s l) + 1 ≤ 40
      then x :: replay s l else replay s l := by
  by_cases hp : GapOk x (replay s l) ∧ count x (replay s l) + 1 ≤ 40
  · rw [if_pos hp]; exact hl.permitted _ _ hp.1 hp.2
  · rw [if_neg hp]
    rcases hl.silent x (replay s l) with e | e
    · exact e
    · exfalso
      apply hp
      have e' : replay s (l ++ [x]) = x :: replay s l := by rw [replay_snoc]; exact e
      have hs := hl.spaced (l ++ [x])
      have hc := hl.capped (l ++ [x])
      rw [e'] at hs hc
      exact perm_of_spaced_capped x _ hs hc

theorem laws_determine (s1 s2 : Nat → History → History) (h1 : Laws s1) (h2 : Laws s2) :
    ∀ times, replay s1 times = replay s2 times := by
  intro times
  have key : ∀ l : List Nat, replay s1 l.reverse = replay s2 l.reverse := by
    intro l
    induction l with
    | nil => rfl
    | cons x l ih =>
      rw [List.reverse_cons, replay_snoc, replay_snoc, step_iff s1 h1, step_iff s2 h2, ih]
  have := key times.reverse
  rwa [List.reverse_reverse] at this

#print axioms laws_determine

end Pacer
