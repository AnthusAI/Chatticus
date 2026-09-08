# Spec coverage baseline

Captured from `cursor/behavior-specs-from-pytest` after HTTP grant/read
landed in `capability_sink_wiring.feature` and before the next chapter
migrations (`organizations`, `me`, `worker_credentials`).

Command:

```
PYTHONPATH=/tmp/chatticus-behavior-migration/python/src \
  /Users/home/Projects/Chattic.us/python/.venv/bin/python \
  python/scripts/spec_coverage.py
```

Heuristic: text search over Gherkin (`features/*.feature` + `features/steps/*.py`)
and pytest (`python/tests/test_*.py`). Matches full path templates, org-path
suffixes, static-segment regexes, and trailing path fragments. `/me` and
`/health` require path-like markers. HTTP method is optional when the path
matches. Framework docs/openapi/redoc paths are omitted. Enumeration uses
`create_app(...).openapi()["paths"]`.

## Summary

| Class | Count |
| --- | --- |
| Total routes | 34 |
| GHERKIN | 28 |
| PYTEST-ONLY | 1 |
| UNCOVERED | 5 |

## PYTEST-ONLY

- `POST /orgs/{tenant_id}/bots/{bot_id}/memory`

## UNCOVERED

- `GET /orgs/{tenant_id}/computers/stopped`
- `POST /orgs/{tenant_id}/computers/stopped`
- `POST /orgs/{tenant_id}/turns/{turn_id}/browse/authorize`
- `POST /orgs/{tenant_id}/turns/{turn_id}/renew`
- `POST /orgs/{tenant_id}/turns/{turn_id}/tool/denied`

## GHERKIN

- `GET /health`
- `GET /me`
- `GET /orgs/{tenant_id}/bots`
- `GET /orgs/{tenant_id}/bots/{bot_id}`
- `GET /orgs/{tenant_id}/channels/{channel_id}`
- `GET /orgs/{tenant_id}/channels/{channel_id}/messages`
- `GET /orgs/{tenant_id}/channels/{channel_id}/turn`
- `GET /orgs/{tenant_id}/tasks/{task_id}`
- `GET /orgs/{tenant_id}/turns/{turn_id}`
- `GET /orgs/{tenant_id}/turns/{turn_id}/events`
- `GET /orgs/{tenant_id}/turns/{turn_id}/stream`
- `GET /orgs/{tenant_id}/users/{user_id}/bots`
- `GET /orgs/{tenant_id}/users/{user_id}/channels`
- `GET /orgs/{tenant_id}/users/{user_id}/computer`
- `GET /orgs/{tenant_id}/users/{user_id}/tasks`
- `GET /orgs/{tenant_id}/users/{user_id}/turns`
- `POST /orgs/{tenant_id}/bots`
- `POST /orgs/{tenant_id}/bots/{bot_id}/tasks/tool`
- `POST /orgs/{tenant_id}/channels`
- `POST /orgs/{tenant_id}/channels/{channel_id}/messages`
- `POST /orgs/{tenant_id}/turns/{turn_id}/chunks`
- `POST /orgs/{tenant_id}/turns/{turn_id}/claim`
- `POST /orgs/{tenant_id}/turns/{turn_id}/resume`
- `POST /orgs/{tenant_id}/turns/{turn_id}/waiting`
- `POST /orgs/{tenant_id}/workers/register`
- `POST /orgs/{tenant_id}/workers/{worker_id}/heartbeat`
- `PUT /orgs/{tenant_id}/turns/{turn_id}/grant`
