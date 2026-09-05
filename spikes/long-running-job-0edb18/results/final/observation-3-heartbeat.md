# Observation 3 — Heartbeat semantics

## Evidence

- `../20260905T183731Z-heartbeat-e049c923/observation-3-heartbeat.json`

## Finding

| Time | Healthy workers |
| --- | --- |
| After register | 1 |
| After 35 s without heartbeat | **0** |
| After explicit heartbeat POST | 1 |
| After another 35 s gap | **0** |

`heartbeat_timeout` is **30 s** (`ControlPlane`, Gherkin `worker_registration.feature`).
`docs/ARCHITECTURE.md` routing rule 1 drops stale heartbeats.

`computer_host_worker` does not send heartbeats during a long `execute()` call. The
scheduler **cannot distinguish** a busy training host from a dead one without a
separate liveness signal.
