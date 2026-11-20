-- THE LAW OF THE PACER. This is the file the human reads and signs. Nothing else in this folder is the law.
-- A pacer decides, for each read request, whether the read is allowed.
--
-- In plain words:
--   1. Two allowed reads are always at least 5 seconds apart.
--   2. In the hour that ends at any allowed read there are never more than 40 allowed reads.
--   3. A read that keeps the 5 second gap and is at most the 40th of its hour is allowed.
--   4. A refused read changes nothing. An allowed read adds itself and changes nothing else.
-- The hour is "less than 3600 seconds old": a read exactly 3600 seconds old is outside it. Forty reads between 0 and 195 seconds,
-- then a read at 3600 is allowed, and at 3599 is refused. "Allowed" has no yes/no flag: it means the history grew.
-- "Always" means: whatever requests arrive, in whatever order, even with clocks that jump backwards.
--
-- The last line says: a pacer that keeps all four laws exists. The agent proves it by writing one.

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

theorem pacer_exists : ∃ step, Laws step := sorry

end Pacer
