Feature: A computer's disk is restored only from entries that are safe to restore
  As an operator of an organization's computer
  I want a snapshot pack to be restored only if every entry is a plain file, a directory, a safe relative link or a hard link to a file in the pack
  So that a tree the model's commands shaped cannot make the restore, which runs as root, write or link outside the disk

  The pack is made from a workspace that model-chosen commands control, so the restore treats it as untrusted. The
  packer leaves out what the restore would refuse, so an ordinary disk always restores.

  Background:
    Given a live disk with workspace file "keep.txt" containing "existing-content"

  Scenario: A pack with a link to an absolute path is refused and the disk is untouched
    Given a handmade pack holding a workspace symbolic link "escape" to "/etc/passwd"
    When the handmade pack is restored onto the live disk
    Then the restore is refused mentioning "absolute or leaves its tree"
    And the live disk still has workspace file "keep.txt" containing "existing-content"

  Scenario: A pack with a link that climbs out of the disk is refused
    Given a handmade pack holding a workspace symbolic link "escape" to "../../outside"
    When the handmade pack is restored onto the live disk
    Then the restore is refused mentioning "absolute or leaves its tree"
    And the live disk still has workspace file "keep.txt" containing "existing-content"

  Scenario: A pack with an entry beneath a link is refused
    Given a handmade pack holding a workspace symbolic link "door" to "real"
    And the handmade pack holds a workspace file "door/inner.txt" containing "beneath"
    When the handmade pack is restored onto the live disk
    Then the restore is refused mentioning "beneath a link"

  Scenario: A pack with a hard link to a file stored earlier in the pack restores both names
    Given a handmade pack holding a workspace file "first.txt" containing "shared-content"
    And the handmade pack holds a workspace hard link "second.txt" to "workspace/first.txt"
    When the handmade pack is restored onto the live disk
    Then the restored workspace file "second.txt" contains "shared-content"

  Scenario: A pack with a hard link to something that is not a file in the pack is refused
    Given a handmade pack holding a workspace hard link "second.txt" to "workspace/missing.txt"
    When the handmade pack is restored onto the live disk
    Then the restore is refused mentioning "not a file stored earlier"

  Scenario: A pack with a hard link to a path outside the disk is refused
    Given a handmade pack holding a workspace hard link "second.txt" to "../../etc/passwd"
    When the handmade pack is restored onto the live disk
    Then the restore is refused mentioning "not a file stored earlier"

  Scenario: A pack with a named pipe is refused
    Given a handmade pack holding a workspace named pipe "pipe"
    When the handmade pack is restored onto the live disk
    Then the restore is refused mentioning "FIFO entry"

  Scenario: A pack with a character device is refused
    Given a handmade pack holding a workspace character device "null"
    When the handmade pack is restored onto the live disk
    Then the restore is refused mentioning "CharacterDevice entry"

  Scenario: A pack with a relative link that stays inside the workspace restores the link
    Given a handmade pack holding a workspace symbolic link "alias" to "real/notes.txt"
    When the handmade pack is restored onto the live disk
    Then the restored workspace has a symbolic link "alias" pointing to "real/notes.txt"

  Scenario: Setuid and setgid bits in a pack are not restored
    Given a handmade pack holding a setuid workspace file "tool"
    And the handmade pack holds a setgid workspace directory "shared"
    When the handmade pack is restored onto the live disk
    Then the restored workspace file "tool" is not setuid
    And the restored workspace file "shared" is not setuid

  Scenario: Packing leaves out what the restore would refuse and the rest restores
    Given a live disk with a workspace file "first.txt" containing "shared-content" and a second hard link "second.txt"
    And the live disk has a workspace named pipe "pipe"
    And the live disk has a workspace symbolic link "absolute-link" pointing to "/etc/passwd"
    And the live disk has a workspace symbolic link "relative-link" pointing to "first.txt"
    When the live disk is packed and restored onto a fresh disk
    Then the fresh disk has workspace file "first.txt" containing "shared-content"
    And the fresh disk has workspace file "second.txt" containing "shared-content"
    And the fresh disk has a workspace symbolic link "relative-link" pointing to "first.txt"
    And the fresh disk has no workspace entry "pipe"
    And the fresh disk has no workspace entry "absolute-link"
