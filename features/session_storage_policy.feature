Feature: Storage credentials scoped to one conversation session
  As the operator of an organization computer
  I want the storage credentials a container receives to reach one conversation session and nothing else
  So that a container that is compromised can corrupt neither another conversation nor another organization

  The control plane will pass this policy to the security token service when
  it starts a container. Here the policy is only built, as data, and checked
  against what the session storage actually touches: objects under the
  session's prefix in the session bucket, and table items under the session's
  partition key.

  Scenario: The policy names the session's own objects and items
    Given the session of bot "bot-1" in channel "channel-1" of organization "anthus"
    When the storage policy is built for the session
    Then the policy allows objects only under the prefix "conversations/anthus%23bot-1%23channel-1/" of bucket "pi-sessions"
    And the policy allows table items only with the partition key "PI#anthus#bot-1#channel-1"

  Scenario: The policy grants nothing outside the session bucket and table
    Given the session of bot "bot-1" in channel "channel-1" of organization "anthus"
    When the storage policy is built for the session
    Then every resource of the policy belongs to bucket "pi-sessions" or to the table "conversations"
    And the policy grants no wildcard action

  Scenario: Two sessions of the same bot get disjoint policies
    Given the session of bot "bot-1" in channel "channel-1" of organization "anthus"
    And the session of bot "bot-1" in channel "channel-2" of organization "anthus"
    When the storage policy is built for each session
    Then the two policies share no object prefix and no partition key

  Scenario: An identifier that could widen the policy is refused
    Given the session of bot "bot-*" in channel "channel-1" of organization "anthus"
    When the storage policy is built for the session
    Then building the policy is refused

  Scenario: An identifier that could blur the session boundary is refused
    Given the session of bot "bot#other" in channel "channel-1" of organization "anthus"
    When the storage policy is built for the session
    Then building the policy is refused

  Scenario: The owner's policy adds its computer's snapshot objects and its organization's messaging items
    Given the owner session of bot "bot-1" in channel "channel-1" of organization "anthus" on computer "computer-1"
    When the owner policy is built for the session
    Then the owner policy still allows the conversation session of the plain policy
    And the owner policy allows snapshot objects only under "tenants/anthus/computers/computer-1/" of bucket "snapshots"
    And the owner policy allows messaging items only with partition keys starting "anthus#" in the table "messaging"

  Scenario: The owner's policy of one organization and computer shares nothing with another's
    Given the owner session of bot "bot-1" in channel "channel-1" of organization "anthus" on computer "computer-1"
    And the owner session of bot "bot-1" in channel "channel-1" of organization "other" on computer "computer-2"
    When the owner policy is built for each session
    Then the two owner policies share no snapshot prefix and no messaging partition prefix

  Scenario: The owner's policy fits within the size STS accepts for realistic identifiers
    Given the owner session with identifiers as long as the platform generates them
    When the owner policy is built for the session
    Then the owner policy is within the STS size limit

  Scenario: A computer identifier that could widen the owner's policy is refused
    Given the owner session of bot "bot-1" in channel "channel-1" of organization "anthus" on computer "computer-*"
    When the owner policy is built for the session
    Then building the owner policy is refused
