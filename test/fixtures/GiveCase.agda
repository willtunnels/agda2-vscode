module GiveCase where

data ℕ : Set where
  zero : ℕ
  suc  : ℕ → ℕ

-- Goal 0: give zero
g : ℕ
g = {! zero !}

-- Goal 1: case split on n
f : ℕ → ℕ
f n = {! n !}
