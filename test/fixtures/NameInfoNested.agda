module NameInfoNested where

module Outer where
  outerVal : Set₁
  outerVal = Set

  module Middle where
    middleVal : Set₁
    middleVal = Set

    module Inner where
      innerVal : Set₁
      innerVal = Set

      data InnerData : Set where
        innerCon : InnerData

record Pair : Set₁ where
  field
    fst : Set
    snd : Set

  module InsideRec where
    insideVal : Set₁
    insideVal = Set

module Anon where
  module _ (A : Set) where
    anonVal : Set
    anonVal = A

    module AnonInner where
      anonInnerVal : Set
      anonInnerVal = A

module Empty where
