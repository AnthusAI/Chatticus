## Summary

Adds deterministic fault-injection coverage for all eight durable turn boundaries, with before-and-after crash windows for each.

- Introduces `turn_fault_hooks` (`TurnBoundary`, `CrashWindow`, `FaultInjector`, `SimulatedCrash`) and `turn_fault_injection` (`TurnFaultDriver`, `StepwiseTurnWorker`) to drive and recover turns without real provider calls or sleeps.
- Instruments `ControlPlane` at message commit, logical enqueue, worker claim, progress/completion append, acknowledgement, and deadline recovery hooks.
- Makes completion idempotent when a bot message row exists but the turn is still `active` (crash after commit, before finalize).
- Adds 16 Gherkin scenario outlines and a parametrized pytest suite asserting provider call count, channel messages, recovery attempt, terminal state, and single authoritative worker.

## Test plan

- [x] `pytest tests/test_turn_fault_injection.py` (17 tests, all 16 boundary/window pairs plus authoritative-actor check)
- [x] `behave ../features/turn_fault_injection.feature` (16 scenarios)
- [x] Full `pytest` and `behave` green
- [x] `black --check` and `ruff check` pass

## Kanbus

Closes chatticus-83b5e3 (blocked by e42008, now closed).
