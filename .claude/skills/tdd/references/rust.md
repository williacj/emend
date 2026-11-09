<!-- ABOUTME: Emend-specific routing for designing Rust tests under the TDD skill. -->
<!-- ABOUTME: Covers seam placement, property tests, typed failures, real boundaries, and async control. -->

# Rust test-design routing

Read this reference only for Rust work.

- Put a test in its module when the guarantee is meaningfully observed through a module-local seam.
  Put it under `tests/` when the stable seam is the crate's public behavior. Do not expose internals
  solely to make them testable.
- Use Emend's existing `proptest` dependency for invariants. Shape strategies so they reach the hard
  classes named by the test card's axes; a larger undirected sample count is not a substitute.
- When `proptest` shrinks a failure, preserve the minimized case as a permanent regression in addition
  to correcting the broader property or generator.
- Assert typed error variants and relevant structured fields when available. Avoid binding tests to
  display strings unless the user-visible string is itself the contract.
- Use the existing `tempfile` dependency, real files, and local bare Git repositories for guarantees
  that depend on filesystem or Git behavior. Keep at least one focused test on the real boundary.
- Coordinate async and concurrent tests with manual clocks, channels, barriers, or condition-based
  waits. Do not use sleeps as synchronization.
- Start with the narrowest Cargo selector that runs the intended cell, then reuse that exact selector
  for RED and GREEN. Run the required workspace or crate suite only at the Engineer's suite gate.

Use existing project dependencies before proposing `mockall`, `rstest`, Criterion,
`cargo-llvm-cov`, or another test crate. Add a dependency only when the card demonstrates a capability
the current tools cannot provide.
