Feature: Browse a computer's files from its published snapshot
  As a member of an organization
  I want to list and read the files on the organization computer while it is off
  So that I can see what my bots made without starting anything

  A publish writes the pack, then an index of every entry, then the manifest that names both. The Front Door answers
  read-only file requests from that index and one ranged read of the file's own gzip member, and it writes nothing.

  Background:
    Given an empty control plane
    And tenant "anthus" user "ryan" has computer "household-computer"
    And a snapshot bucket for the computer file routes

  Scenario: Publishing writes an index that matches the manifest
    Given the computer disk holds workspace file "src/a.c" containing "int main(void) { return 0; }"
    When the computer disk is published
    Then the host wrote the pack, then the index, then the manifest
    And the manifest names the index that was written next to the pack
    And the index lists "workspace/src/a.c" as a file of 28 bytes

  Scenario: Publishing an unchanged disk again produces the same pack and the same index
    Given the computer disk holds workspace file "src/a.c" containing "int main(void) { return 0; }"
    When the computer disk is published
    And the computer disk is published again without any change

  Scenario: A member lists a directory and reads a file from the snapshot
    Given the computer disk holds workspace file "src/a.c" containing "int main(void) { return 0; }"
    And the computer disk holds workspace file "README.md" containing "# Notes"
    When the computer disk is published
    And a member lists the computer files at "/workspace"
    Then the file response status is 200
    And the file response was published as of the manifest time
    And the file response says "path" is "/workspace"
    And the file response says "stale" is "false"
    And the file response says "fallback_reason" is "null"
    And the listing shows these entries in order:
      | name      | kind      |
      | src       | directory |
      | README.md | file      |
    And the entry "README.md" is a file of 7 bytes with SHA-256 of "# Notes"
    When a member reads the computer file "/workspace/src/a.c"
    Then the file response status is 200
    And the content response holds "int main(void) { return 0; }"
    And the content response has the SHA-256 of "int main(void) { return 0; }" and the same ETag
    And the file response says "size" is "28"
    And the file response was published as of the manifest time
    And the file response carries header "X-Content-Type-Options" as "nosniff"
    And the file response has a modification time

  Scenario: A listing puts directories first and then sorts by name
    Given the computer disk holds workspace file "b.txt" containing "b"
    And the computer disk holds workspace file "a.txt" containing "a"
    And the computer disk holds workspace file "zeta/inner.txt" containing "z"
    And the computer disk holds workspace file "alpha/inner.txt" containing "a"
    When the computer disk is published
    And a member lists the computer files at "/workspace"
    Then the listing shows these entries in order:
      | name  | kind      |
      | alpha | directory |
      | zeta  | directory |
      | a.txt | file      |
      | b.txt | file      |

  Scenario: One entry can be inspected on its own
    Given the computer disk holds workspace file "src/a.c" containing "int main(void) { return 0; }"
    When the computer disk is published
    And a member stats the computer file "/workspace/src/a.c"
    Then the file response status is 200
    And the entry "a.c" is a file of 28 bytes with SHA-256 of "int main(void) { return 0; }"
    And the stat entry has a modification time
    And the file response says "stale" is "false"
    And the file response was published as of the manifest time

  Scenario: Excluded directories are absent from the pack and the index
    Given the computer disk holds workspace file "app/src/main.ts" containing "export {};"
    And the computer disk holds workspace file "app/node_modules/dep/index.js" containing "module.exports = 1;"
    And the computer disk holds workspace file "app/.cache/entry" containing "cached"
    And the computer disk holds workspace file "app/build" containing "a file named build is not a directory"
    When the computer disk is published
    Then the index lists nothing whose path contains "node_modules"
    And the index lists nothing whose path contains ".cache"
    And the index lists "workspace/app/build"
    When a member lists the computer files at "/workspace/app"
    Then the listing shows these entries in order:
      | name  | kind      |
      | src   | directory |
      | build | file      |
    When a new hydrating host restores the published snapshot
    Then the restored workspace has file "app/src/main.ts" containing "export {};"
    And the restored workspace has no "app/node_modules"
    And the restored workspace has no "app/.cache"

  @owner-log
  Scenario: A file over 50 MiB is skipped and logged
    Given the computer disk holds workspace file "small.txt" containing "kept"
    And the computer disk holds sparse workspace file "images/huge.iso" of 52428801 bytes
    When the computer disk is published
    Then the console reports the skipped file "workspace/images/huge.iso"
    And the index lists nothing whose path contains "huge.iso"
    And the index lists "workspace/small.txt"

  Scenario: A listing is cut at 2000 entries
    Given the computer disk holds 2003 workspace files in directory "many"
    When the computer disk is published
    And a member lists the computer files at "/workspace/many"
    Then the file response status is 200
    And the listing has 2000 entries and truncated is true

  Scenario: A listing under the limit is not marked truncated
    Given the computer disk holds 3 workspace files in directory "few"
    When the computer disk is published
    And a member lists the computer files at "/workspace/few"
    Then the listing has 3 entries and truncated is false

  Scenario Outline: A path that does not stay under /workspace is refused
    Given the computer disk holds workspace file "src/a.c" containing "int main(void) { return 0; }"
    When the computer disk is published
    And a member reads the computer file "<path>"
    Then the file response status is 400
    And the file response error is "invalid_path"
    And the file response carries header "X-Content-Type-Options" as "nosniff"

    Examples:
      | path                          |
      | /workspace/../etc/passwd      |
      | /workspace/src/../../etc/hosts |
      | /workspace/..                 |
      | /etc/passwd                   |
      | /browser-profiles/untrusted   |
      | /workspacefoo/a.c             |
      | workspace/src/a.c             |
      | /workspace/src/a<NUL>.c       |

  Scenario: An overlong path is refused
    Given the computer disk holds workspace file "src/a.c" containing "int main(void) { return 0; }"
    When the computer disk is published
    And a member reads the computer file whose path is 1100 characters long
    Then the file response status is 400
    And the file response error is "invalid_path"

  Scenario: A listing without a path is refused
    Given the computer disk holds workspace file "src/a.c" containing "int main(void) { return 0; }"
    When the computer disk is published
    And a member lists the computer files with no path
    Then the file response status is 400
    And the file response error is "invalid_path"

  Scenario: A member of another organization is refused
    Given the computer disk holds workspace file "src/a.c" containing "int main(void) { return 0; }"
    When the computer disk is published
    And a member of "other-household" lists the computer files of "anthus" at "/workspace"
    Then the file response status is 403
    And the response body does not contain "a.c"

  Scenario: Someone who belongs to no organization is refused
    Given the computer disk holds workspace file "src/a.c" containing "int main(void) { return 0; }"
    When the computer disk is published
    And someone who belongs to no organization lists the computer files of "anthus" at "/workspace"
    Then the file response status is 403
    And the response body does not contain "a.c"

  Scenario: Reading a directory as a file is refused
    Given the computer disk holds workspace file "src/a.c" containing "int main(void) { return 0; }"
    When the computer disk is published
    And a member reads the computer file "/workspace/src"
    Then the file response status is 422
    And the file response error is "not_a_file"

  Scenario: A path that is not in the snapshot is not found
    Given the computer disk holds workspace file "src/a.c" containing "int main(void) { return 0; }"
    When the computer disk is published
    And a member reads the computer file "/workspace/src/missing.c"
    Then the file response status is 404
    And the file response error is "not_found"

  Scenario: A file that looks like a secret is listed but its content is masked
    Given the computer disk holds workspace file ".env" containing "API_KEY=super-secret-value"
    And the computer disk holds workspace file "home/.ssh/config" containing "IdentityFile secret-path"
    And the computer disk holds workspace file "notes.md" containing "public notes"
    When the computer disk is published
    And a member lists the computer files at "/workspace"
    Then the entry ".env" is a file of 26 bytes with SHA-256 of "API_KEY=super-secret-value"
    When a member reads the computer file "/workspace/.env"
    Then the file response status is 200
    And the content response is masked and empty
    And the response body does not contain "super-secret-value"
    When a member reads the computer file "/workspace/home/.ssh/config"
    Then the content response is masked and empty
    When a member reads the computer file "/workspace/notes.md"
    Then the content response holds "public notes"

  Scenario: A binary file is returned as base64
    Given the computer disk holds workspace file "logo.png" with binary content
    When the computer disk is published
    And a member reads the computer file "/workspace/logo.png"
    Then the file response status is 200
    And the content response is binary base64 of 8 bytes

  Scenario: A large file is read by range
    Given the computer disk holds workspace file "big.txt" of 600000 bytes of repeating text
    When the computer disk is published
    And a member reads the computer file "/workspace/big.txt"
    Then the file response says "size" is "600000"
    And the content response returns 262144 bytes from offset 0 and truncated is true
    When a member reads 16 bytes of the computer file "/workspace/big.txt" from offset 599990
    Then the content response returns 10 bytes from offset 599990 and truncated is false
    When a member reads 16 bytes of the computer file "/workspace/big.txt" from offset 16
    Then the content response holds "0123456789abcdef"
    And the file response says "truncated" is "true"

  Scenario: A read longer than 256 KiB is refused
    Given the computer disk holds workspace file "big.txt" of 600000 bytes of repeating text
    When the computer disk is published
    And a member reads 262145 bytes of the computer file "/workspace/big.txt" from offset 0
    Then the file response status is 413
    And the file response error is "range_too_large"

  Scenario: Symbolic links are shown as links and followed only inside the snapshot
    Given the computer disk holds workspace file "src/a.c" containing "int main(void) { return 0; }"
    And the computer disk holds workspace link "latest" pointing to "src/a.c"
    And the computer disk holds workspace link "escape" pointing to "../../outside"
    When the computer disk is published
    And a member lists the computer files at "/workspace"
    Then the entry "latest" is a symlink to "src/a.c"
    And the listing has no entry named "escape"
    When a member reads the computer file "/workspace/latest"
    Then the content response holds "int main(void) { return 0; }"
    When a member reads the computer file "/workspace/escape"
    Then the file response status is 404
    And the file response error is "not_found"

  Scenario: A loop of symbolic links stops after eight hops
    Given the computer disk holds workspace link "loop-a" pointing to "loop-b"
    And the computer disk holds workspace link "loop-b" pointing to "loop-a"
    When the computer disk is published
    And a member reads the computer file "/workspace/loop-a"
    Then the file response status is 422
    And the file response error is "too_many_symlinks"

  @owner-log
  Scenario: A stored file that does not match its indexed hash is never returned
    Given the computer disk holds workspace file "src/a.c" containing "int main(void) { return 0; }"
    When the computer disk is published
    And the published snapshot claims a different hash for "workspace/src/a.c"
    And a member reads the computer file "/workspace/src/a.c"
    Then the file response status is 500
    And the file response error is "corrupt_snapshot"
    And the response body does not contain "int main"
    And the console reports a corrupt snapshot member for "/workspace/src/a.c"

  Scenario: A computer that never published has no snapshot to browse
    When a member lists the computer files at "/workspace"
    Then the file response status is 404
    And the file response error is "no_snapshot"

  Scenario: A snapshot published before indexes existed still hydrates but cannot be browsed
    Given the computer disk holds workspace file "src/a.c" containing "int main(void) { return 0; }"
    When the computer disk is published
    And the published snapshot is replaced by one made before indexes existed
    And a member lists the computer files at "/workspace"
    Then the file response status is 409
    And the file response error is "snapshot_not_indexed"
    When a new hydrating host restores the published snapshot
    Then the restored workspace has file "src/a.c" containing "int main(void) { return 0; }"

  Scenario: Re-indexing gives an older snapshot an index and a second run changes nothing
    Given the computer disk holds workspace file "src/a.c" containing "int main(void) { return 0; }"
    And the computer disk holds workspace file "app/node_modules/dep/index.js" containing "module.exports = 1;"
    When the computer disk is published
    And the published snapshot is replaced by one made before indexes existed
    And the snapshots are re-indexed as a dry run
    Then the re-index reports "would_reindex"
    And the manifest names no index
    When the snapshots are re-indexed for real
    Then the re-index reports "reindexed"
    And the manifest keeps its original publish time
    When a member reads the computer file "/workspace/src/a.c"
    Then the content response holds "int main(void) { return 0; }"
    And the index lists nothing whose path contains "node_modules"
    When the snapshots are re-indexed for real
    Then the re-index reports "already_indexed"

  Scenario: The file routes read and never write
    Given the computer disk holds workspace file "src/a.c" containing "int main(void) { return 0; }"
    When the computer disk is published
    And a member lists the computer files at "/workspace/src"
    And a member stats the computer file "/workspace/src/a.c"
    And a member reads the computer file "/workspace/src/a.c"
    Then the file routes made no writes
