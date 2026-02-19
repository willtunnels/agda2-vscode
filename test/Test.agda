-- When we debug the extension, we end up in this file automatically
{-# OPTIONS --postfix-projections #-}

data Nat : Set where
  zero : Nat
  suc : Nat → Nat

add : Nat → Nat → Nat
add n m = {!  !}
