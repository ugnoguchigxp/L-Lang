# LLVM checked i32 sum experiment

This fixture uses the existing `module-collection-v1` language and expresses a
left fold over `List<i32>`. It is accepted by the LLVM experiment only when its
checked program matches the exact `checked-sum-i32` subset.

The experiment is not a product backend or a portable Collection artifact.
See [the implementation plan](../../docs/LLVM_EXPERIMENTAL_BACKEND_IMPLEMENTATION_PLAN.md).
