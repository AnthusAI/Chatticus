"""Packaging tests for the computer image host-worker layout.

Docker build smoke is optional: when Docker is unavailable the Dockerfile and
pip-layout tests still prove the rebuilt image would expose
``python -m chatticus.computer_host_worker``.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
DOCKERFILE = REPO_ROOT / "computer" / "Dockerfile"
ENTRYPOINT = REPO_ROOT / "computer" / "entrypoint.sh"
PYTHON_SRC = REPO_ROOT / "python"
HOST_WORKER_MODULE = PYTHON_SRC / "src" / "chatticus" / "computer_host_worker.py"


def _docker_available() -> bool:
    return shutil.which("docker") is not None and _docker_daemon_ready()


def _docker_daemon_ready() -> bool:
    try:
        subprocess.run(
            ["docker", "info"],
            capture_output=True,
            check=True,
            timeout=10,
        )
    except (
        subprocess.CalledProcessError,
        FileNotFoundError,
        subprocess.TimeoutExpired,
    ):
        return False
    return True


def test_computer_dockerfile_copies_python_and_installs_package() -> None:
    text = DOCKERFILE.read_text()
    assert "COPY python /opt/chatticus/src" in text
    assert "pip install /opt/chatticus/src" in text
    assert "COPY computer/entrypoint.sh" in text
    assert 'CMD ["sleep", "infinity"]' in text


def test_computer_dockerfile_installs_host_worker_runtime_deps() -> None:
    text = DOCKERFILE.read_text()
    for dep in ("boto3", "httpx", "fastapi", "pydantic", "python-dotenv"):
        assert dep in text


def test_computer_host_worker_source_is_in_python_tree() -> None:
    assert HOST_WORKER_MODULE.is_file()
    source = HOST_WORKER_MODULE.read_text()
    assert "def run_host_worker_once" in source
    assert "def main()" in source
    assert 'if __name__ == "__main__"' in source


def test_computer_entrypoint_starts_xvfb_when_boot_is_set() -> None:
    text = ENTRYPOINT.read_text()
    assert "CHATTICUS_COMPUTER_BOOT" in text
    assert "Xvfb" in text
    assert 'exec "$@"' in text


def test_computer_image_pip_layout_exposes_host_worker(tmp_path: Path) -> None:
    """Mirror computer/Dockerfile pip install without Docker."""
    venv_dir = tmp_path / "venv"
    subprocess.run([sys.executable, "-m", "venv", str(venv_dir)], check=True)
    pip = venv_dir / "bin" / "pip"
    python = venv_dir / "bin" / "python"
    subprocess.run(
        [
            str(pip),
            "install",
            str(PYTHON_SRC),
            "boto3",
            "httpx",
            "fastapi",
            "pydantic>=2",
            "python-dotenv",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    import_check = subprocess.run(
        [
            str(python),
            "-c",
            "import chatticus.computer_host_worker as m; "
            "assert callable(m.run_host_worker_once); "
            "assert callable(m.main)",
        ],
        capture_output=True,
        text=True,
    )
    assert import_check.returncode == 0, import_check.stderr
    missing_env = subprocess.run(
        [str(python), "-m", "chatticus.computer_host_worker"],
        capture_output=True,
        text=True,
    )
    assert missing_env.returncode != 0
    assert "CHATTICUS_TENANT_ID" in missing_env.stderr


@pytest.mark.skipif(not _docker_available(), reason="Docker daemon unavailable")
def test_docker_computer_image_imports_host_worker() -> None:
    tag = "chatticus-computer-test:4bca15"
    build = subprocess.run(
        [
            "docker",
            "build",
            "-f",
            str(DOCKERFILE),
            "-t",
            tag,
            str(REPO_ROOT),
        ],
        capture_output=True,
        text=True,
        timeout=600,
    )
    assert build.returncode == 0, build.stderr
    run = subprocess.run(
        [
            "docker",
            "run",
            "--rm",
            tag,
            "python",
            "-c",
            "import chatticus.computer_host_worker as m; " "assert callable(m.main)",
        ],
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert run.returncode == 0, run.stderr
