"""Root pytest config.

Stop pytest from descending into ``infra/`` (CDK synth output, build artifacts)
when invoked from the repo root instead of ``python/``. The canonical
path is ``cd python && pytest`` (per AGENTS.md); this guard keeps the
root invocation from exploding on regenerable CDK assets.
"""

collect_ignore = ["infra"]
