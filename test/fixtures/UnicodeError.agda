module UnicodeError where

-- BMP characters
data ℕ : Set where
  zero : ℕ
  suc  : ℕ → ℕ

-- Supplementary plane: 𝕄 (U+1D544, 2 UTF-16 code units)
-- After 𝕄, all columns on this line are shifted by +1 in UTF-16.
𝕄 : Set
𝕄 = ℕ

-- This line has 𝕄 before the error, causing column shift.
-- The undefined name "bbb" is after 𝕄 on the same line.
𝕄error : ℕ
𝕄error = bbb
