import Solution

/-- Reads lines "now t1 t2 ..." and prints Pacer.step now [t1, t2, ...]. -/
def main : IO Unit := do
  let stdin ← IO.getStdin
  let stdout ← IO.getStdout
  repeat
    let line ← stdin.getLine
    if line.isEmpty then break
    let words := (((line.replace "\n" " ").replace "\r" " ").splitOn " ").filter (· ≠ "")
    let nums := words.filterMap String.toNat?
    match nums with
    | [] => stdout.putStrLn ""
    | now :: h =>
      stdout.putStrLn (" ".intercalate ((Pacer.step now h).map toString))
