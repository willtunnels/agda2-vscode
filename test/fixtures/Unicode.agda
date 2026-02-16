module Unicode where

-- BMP characters: ℕ (U+2115, 3 bytes UTF-8, 1 UTF-16 code unit)
data ℕ : Set where
  zero : ℕ
  suc  : ℕ → ℕ

-- Supplementary plane: 𝕄 (U+1D544, 4 bytes UTF-8, 2 UTF-16 code units)
𝕄 : Set
𝕄 = ℕ

-- After supplementary char, offsets diverge
α : ℕ
α = zero
