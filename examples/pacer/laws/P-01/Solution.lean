namespace Pacer

/-- The times (whole seconds) of the allowed reads so far, newest first. -/
abbrev History := List Nat

/-- Is the read at time `t` inside the hour that ends at `now`? -/
def inside (now t : Nat) : Bool := decide (now < t + 3600)

/-- How many reads of the history are inside the hour that ends at `now`. -/
def count (now : Nat) (h : History) : Nat := (h.filter (inside now)).length

/-- The newest read in the history is at least 5 seconds before `now` (or there is no read yet). -/
def GapOk (now : Nat) (h : History) : Prop :=
  match h with
  | [] => True
  | t :: _ => t + 5 ≤ now

/-- Neighbouring reads of a history (newest first) are at least 5 seconds apart. -/
def Spaced : History → Prop
  | a :: b :: rest => b + 5 ≤ a ∧ Spaced (b :: rest)
  | _ => True

/-- The hour that ends at the newest read of the history holds at most 40 reads. -/
def Capped : History → Prop
  | [] => True
  | t :: rest => count t (t :: rest) ≤ 40

/-- Feed the requests `times` (oldest first) to `step`, starting with no reads. Gives the history afterwards. -/
def replay (step : Nat → History → History) (times : List Nat) : History :=
  times.foldl (fun h now => step now h) []

/-- The four laws. `step now h` is the history after a request at time `now` when the history was `h`. -/
structure Laws (step : Nat → History → History) : Prop where
  spaced : ∀ times, Spaced (replay step times)
  capped : ∀ times, Capped (replay step times)
  permitted : ∀ now h, GapOk now h → count now h + 1 ≤ 40 → step now h = now :: h
  silent : ∀ now h, step now h = h ∨ step now h = now :: h

/-- Gap check as a Bool. -/
def gapb (now : Nat) : History → Bool
  | [] => true
  | t :: _ => decide (t + 5 ≤ now)

/-- The pacer: allow the read iff the gap is kept and it is at most the 40th of its hour. -/
def step (now : Nat) (h : History) : History :=
  if gapb now h && decide (count now h + 1 ≤ 40)
  then now :: h else h

theorem step_cases (now : Nat) (h : History) :
    (GapOk now h ∧ count now h + 1 ≤ 40 ∧ step now h = now :: h) ∨ step now h = h := by
  unfold step
  by_cases hc : (gapb now h && decide (count now h + 1 ≤ 40)) = true
  · left
    rw [if_pos hc]
    simp only [Bool.and_eq_true, decide_eq_true_eq] at hc
    refine ⟨?_, hc.2, rfl⟩
    cases h with
    | nil => trivial
    | cons t r => have h1 := hc.1; simp only [gapb, decide_eq_true_eq] at h1; exact h1
  · right; rw [if_neg hc]

theorem count_cons_self (now : Nat) (h : History) : count now (now :: h) = count now h + 1 := by
  simp [count, List.filter_cons, inside, Nat.add_comm]

theorem guard_true (now : Nat) (h : History) (hg : GapOk now h) (hn : count now h + 1 ≤ 40) :
    (gapb now h && decide (count now h + 1 ≤ 40)) = true := by
  cases h with
  | nil => simpa [gapb] using hn
  | cons t r => simp only [GapOk] at hg; simp [gapb, hg, hn]

def Inv (h : History) : Prop := Spaced h ∧ Capped h

theorem inv_step (now : Nat) (h : History) (hi : Inv h) : Inv (step now h) := by
  rcases step_cases now h with ⟨hg, hn, he⟩ | he
  · rw [he]
    refine ⟨?_, ?_⟩
    · cases h with
      | nil => simp [Spaced]
      | cons t r => exact ⟨hg, hi.1⟩
    · show count now (now :: h) ≤ 40
      rw [count_cons_self]; exact hn
  · rw [he]; exact hi

theorem inv_foldl (times : List Nat) : ∀ h, Inv h → Inv (times.foldl (fun h now => step now h) h) := by
  induction times with
  | nil => intro h hi; exact hi
  | cons x xs ih => intro h hi; exact ih _ (inv_step x h hi)

theorem inv_replay (times : List Nat) : Inv (replay step times) :=
  inv_foldl times [] ⟨trivial, trivial⟩

theorem step_ok : Laws step where
  spaced times := (inv_replay times).1
  capped times := (inv_replay times).2
  permitted now h hg hn := by
    have hc := guard_true now h hg hn
    unfold step
    exact if_pos hc
  silent now h := by
    rcases step_cases now h with ⟨_, _, he⟩ | he
    · exact Or.inr he
    · exact Or.inl he

theorem pacer_exists : ∃ step, Laws step := ⟨step, step_ok⟩

end Pacer
