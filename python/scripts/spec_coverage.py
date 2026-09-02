"""Measure HTTP route coverage across Gherkin features and pytest tests.

Heuristic coverage rules (conservative text search, not semantic analysis):

1. Build corpora by concatenating ``features/*.feature`` and ``features/steps/*.py``
   (Gherkin) and ``python/tests/test_*.py`` (pytest).
2. For each FastAPI route (method + path template), search the corpus for:
   a. the full path template (e.g. ``/orgs/{tenant_id}/turns/{turn_id}/grant``);
   b. the suffix after ``/orgs/{tenant_id}`` (e.g. ``/turns/{turn_id}/grant``);
   c. a regex joining static path segments with wildcards between them;
   d. the trailing static path fragment (e.g. ``/workspace/read``, ``/workers/register``).
3. Short top-level routes ``/me`` and ``/health`` require path-like context
   (``/me``, ``GET /me``, ``"/me"``, ``'/me'``) so plain English words do not match.
4. HTTP method is not required when the path match is found.
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Iterable

from chatticus.control_plane import ControlPlane
from chatticus.http.app import create_app

ORG_TENANT_PREFIX = "/orgs/{tenant_id}"
FRAMEWORK_PATHS = frozenset({"/docs", "/openapi.json", "/redoc"})


def is_framework_noise(path: str) -> bool:
    """Return whether *path* is FastAPI/OpenAPI framework noise."""
    return path in FRAMEWORK_PATHS or path.startswith("/docs")


SHORT_ROUTE_PATTERNS: dict[str, re.Pattern[str]] = {
    "/me": re.compile(r"""(?:GET\s+)?['"]?/me['"]?(?!\w)"""),
    "/health": re.compile(r"""(?:GET\s+)?['"]?/health['"]?(?!\w)"""),
}


class CoverageClass(Enum):
    """How a route is exercised in tests."""

    GHERKIN = "GHERKIN"
    PYTEST_ONLY = "PYTEST-ONLY"
    UNCOVERED = "UNCOVERED"


@dataclass(frozen=True, order=True)
class HttpRoute:
    """One HTTP endpoint on the FastAPI app."""

    method: str
    path: str


def repo_root_from_script(script_path: Path) -> Path:
    """Return repository root (parent of ``python/``) for this script location."""
    return script_path.resolve().parents[2]


def normalize_path_suffix(path: str) -> str:
    """Strip the org tenant prefix when present."""
    if path.startswith(ORG_TENANT_PREFIX):
        suffix = path[len(ORG_TENANT_PREFIX) :]
        return suffix if suffix else "/"
    return path


def static_path_segments(path: str) -> list[str]:
    """Return literal path segments, omitting ``{param}`` placeholders."""
    segments: list[str] = []
    for part in path.strip("/").split("/"):
        if not part:
            continue
        if part.startswith("{") and part.endswith("}"):
            continue
        segments.append(part)
    return segments


def trailing_static_fragment(path: str) -> str | None:
    """Return a slash-led fragment from the last one or two static segments."""
    segments = static_path_segments(path)
    if len(segments) >= 2:
        return f"/{segments[-2]}/{segments[-1]}"
    if len(segments) == 1:
        return f"/{segments[0]}"
    return None


def flexible_static_segments_pattern(path: str) -> re.Pattern[str] | None:
    """Build a regex that links static segments with flexible gaps."""
    segments = static_path_segments(normalize_path_suffix(path))
    if len(segments) < 2:
        return None
    body = r".*".join(re.escape(segment) for segment in segments)
    return re.compile(rf"/{body}")


def short_route_pattern(path: str) -> re.Pattern[str] | None:
    """Return a strict matcher for short top-level routes."""
    return SHORT_ROUTE_PATTERNS.get(path)


def path_like_marker(segment: str) -> list[str]:
    """Return substrings that indicate path-like usage of one segment."""
    return [
        f"/{segment}/",
        f"/{segment}",
        f'"/{segment}"',
        f"'/{segment}'",
        f"GET /{segment}",
        f"POST /{segment}",
        f"PUT /{segment}",
        f"DELETE /{segment}",
        f"PATCH /{segment}",
    ]


def corpus_mentions_route(corpus: str, path: str) -> bool:
    """Return whether *corpus* text plausibly references *path*."""
    short_pattern = short_route_pattern(path)
    if short_pattern is not None:
        return short_pattern.search(corpus) is not None

    if path in corpus:
        return True

    suffix = normalize_path_suffix(path)
    if suffix in corpus:
        return True

    fragment = trailing_static_fragment(suffix)
    if fragment is not None and fragment in corpus:
        return True

    flexible_pattern = flexible_static_segments_pattern(path)
    if flexible_pattern is not None and flexible_pattern.search(corpus):
        return True

    segments = static_path_segments(suffix)
    if not segments:
        return False

    if len(segments) == 1:
        segment = segments[0]
        return any(marker in corpus for marker in path_like_marker(segment))

    long_segments = [segment for segment in segments if len(segment) >= 3]
    if not long_segments:
        return False

    if not all(segment in corpus for segment in long_segments):
        return False

    return any(marker in corpus for marker in path_like_marker(long_segments[-1]))


def read_corpus_files(paths: Iterable[Path]) -> str:
    """Concatenate file contents for heuristic search."""
    chunks: list[str] = []
    for path in sorted(paths):
        if path.is_file():
            chunks.append(path.read_text(encoding="utf-8"))
    return "\n".join(chunks)


def collect_gherkin_corpus(repo_root: Path) -> str:
    """Load Gherkin feature and step files."""
    feature_paths = list(repo_root.glob("features/*.feature"))
    step_paths = list(repo_root.glob("features/steps/*.py"))
    return read_corpus_files([*feature_paths, *step_paths])


def collect_pytest_corpus(repo_root: Path) -> str:
    """Load pytest test modules."""
    test_paths = list(repo_root.glob("python/tests/test_*.py"))
    return read_corpus_files(test_paths)


def enumerate_http_routes(app: object) -> list[HttpRoute]:
    """Collect HTTP method + path pairs from the app OpenAPI schema."""
    routes: list[HttpRoute] = []
    for path, operations in app.openapi()["paths"].items():
        if is_framework_noise(path):
            continue
        for method in sorted(operations):
            if method == "parameters":
                continue
            routes.append(HttpRoute(method=method.upper(), path=path))
    return sorted(routes)


def classify_route(
    route: HttpRoute,
    gherkin_corpus: str,
    pytest_corpus: str,
) -> CoverageClass:
    """Classify one route as GHERKIN, PYTEST-ONLY, or UNCOVERED."""
    if corpus_mentions_route(gherkin_corpus, route.path):
        return CoverageClass.GHERKIN
    if corpus_mentions_route(pytest_corpus, route.path):
        return CoverageClass.PYTEST_ONLY
    return CoverageClass.UNCOVERED


def format_route_line(route: HttpRoute) -> str:
    """Render one route for stdout."""
    return f"{route.method} {route.path}"


def print_report(
    routes: list[HttpRoute],
    classifications: dict[HttpRoute, CoverageClass],
) -> None:
    """Print heuristic note, summary, and per-class route lists."""
    print(
        "Heuristic: text search over Gherkin (features + steps) and pytest "
        "(test_*.py) corpora."
    )
    print(
        "Matches full path templates, org-path suffixes, static-segment regexes, "
        "and trailing path fragments."
    )
    print(
        "/me and /health require path-like markers; HTTP method is optional when "
        "the path matches."
    )
    print()

    counts = {coverage: 0 for coverage in CoverageClass}
    for route in routes:
        counts[classifications[route]] += 1

    print(f"Total routes: {len(routes)}")
    print(f"GHERKIN: {counts[CoverageClass.GHERKIN]}")
    print(f"PYTEST-ONLY: {counts[CoverageClass.PYTEST_ONLY]}")
    print(f"UNCOVERED: {counts[CoverageClass.UNCOVERED]}")
    print()

    pytest_only = [
        route for route in routes if classifications[route] == CoverageClass.PYTEST_ONLY
    ]
    uncovered = [
        route for route in routes if classifications[route] == CoverageClass.UNCOVERED
    ]
    gherkin = [
        route for route in routes if classifications[route] == CoverageClass.GHERKIN
    ]

    print("PYTEST-ONLY routes:")
    if pytest_only:
        for route in pytest_only:
            print(f"  {format_route_line(route)}")
    else:
        print("  (none)")
    print()

    print("UNCOVERED routes:")
    if uncovered:
        for route in uncovered:
            print(f"  {format_route_line(route)}")
    else:
        print("  (none)")
    print()

    print("GHERKIN routes:")
    if gherkin:
        for route in gherkin:
            print(f"  {format_route_line(route)}")
    else:
        print("  (none)")


def main() -> int:
    """Enumerate routes, classify coverage, and print a report.

    :returns: Always ``0``; this tool reports coverage but does not gate CI.
    """
    script_path = Path(__file__)
    repo_root = repo_root_from_script(script_path)

    app = create_app(ControlPlane(), invoke_key="")
    routes = enumerate_http_routes(app)

    gherkin_corpus = collect_gherkin_corpus(repo_root)
    pytest_corpus = collect_pytest_corpus(repo_root)

    classifications = {
        route: classify_route(route, gherkin_corpus, pytest_corpus) for route in routes
    }
    print_report(routes, classifications)
    return 0


if __name__ == "__main__":
    sys.exit(main())
