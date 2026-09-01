"""Tests for mapping browser storage partitions to on-disk profile dirs."""

from __future__ import annotations

from pathlib import Path

import pytest

from chatticus.browser_profiles import (
    LEGACY_BROWSER_PROFILE_DIRNAME,
    browser_profile_dir,
    ensure_browser_profiles_layout,
    migrate_legacy_browser_profile,
)


def test_browser_profile_dir_maps_untrusted_partition(tmp_path: Path) -> None:
    assert browser_profile_dir(tmp_path, "untrusted") == (
        tmp_path / "browser-profiles" / "untrusted"
    )


def test_browser_profile_dir_maps_privileged_partition(tmp_path: Path) -> None:
    assert browser_profile_dir(tmp_path, "privileged:banking") == (
        tmp_path / "browser-profiles" / "privileged" / "banking"
    )


def test_browser_profile_dir_defaults_blank_partition_to_untrusted(
    tmp_path: Path,
) -> None:
    assert (
        browser_profile_dir(tmp_path, "") == tmp_path / "browser-profiles" / "untrusted"
    )


def test_browser_profile_dir_rejects_invalid_partition(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="unknown storage partition"):
        browser_profile_dir(tmp_path, "shared")


def test_migrate_legacy_browser_profile_moves_once(tmp_path: Path) -> None:
    legacy = tmp_path / LEGACY_BROWSER_PROFILE_DIRNAME / "Default"
    legacy.mkdir(parents=True)
    legacy.joinpath("Cookies").write_text("signed-in\n", encoding="utf-8")
    migrate_legacy_browser_profile(tmp_path)
    migrated = (
        tmp_path / "browser-profiles" / "privileged" / "_legacy" / "Default" / "Cookies"
    )
    assert migrated.read_text(encoding="utf-8") == "signed-in\n"
    assert not (tmp_path / LEGACY_BROWSER_PROFILE_DIRNAME).exists()
    migrate_legacy_browser_profile(tmp_path)
    assert migrated.is_file()


def test_ensure_browser_profiles_layout_creates_partition_roots(
    tmp_path: Path,
) -> None:
    ensure_browser_profiles_layout(tmp_path)
    assert (tmp_path / "browser-profiles" / "untrusted").is_dir()
    assert (tmp_path / "browser-profiles" / "privileged").is_dir()
