Feature: Waitlist operator invite

  Scenario: Inviting a signup issues a single-use link
    Given a confirmed waitlist signup in the queue
    When an operator invites them via the waitlist CLI
    Then an invitation link is issued for that signup
    And the signup is marked invited
    And the invitation email is sent

  Scenario: Invited signups no longer appear in the default operator queue
    Given a confirmed waitlist signup in the queue
    When an operator invites them via the waitlist CLI
    And the waitlist CLI lists the queue
    Then that signup does not appear in the waitlist CLI output

  Scenario: A disqualified signup cannot be invited
    Given a disqualified confirmed waitlist signup
    When an operator tries to invite them via the waitlist CLI
    Then the waitlist CLI refuses with a not-invitable error

  Scenario: An unconfirmed signup cannot be invited
    Given a complete waitlist signup with email not yet confirmed
    When an operator tries to invite them via the waitlist CLI
    Then the waitlist CLI refuses with a not-invitable error

  Scenario: An active invitation cannot be issued again
    Given an invited waitlist signup with a non-expired link
    When an operator tries to invite them via the waitlist CLI
    Then the waitlist CLI refuses with a not-invitable error

  Scenario: A consumed invitation cannot be issued again
    Given an invited waitlist signup whose link has been followed
    When an operator tries to invite them via the waitlist CLI
    Then the waitlist CLI refuses with a not-invitable error

  Scenario: An expired unconsumed signup can be invited again
    Given an invited waitlist signup whose link has expired
    When an operator invites them via the waitlist CLI
    Then an invitation link is issued for that signup
    And the invitation email is sent

  Scenario: Following an invitation link marks it used and offers sign-in
    Given an invited waitlist signup
    When a GET request to /waitlist/invite with a valid token
    Then the invitation is marked consumed
    And the response offers sign-in at /chat

  Scenario: A used invitation link cannot be used again
    Given an invited waitlist signup whose link has been followed
    When a GET request to /waitlist/invite with the same token
    Then the invitation is refused

  Scenario: An expired invitation link is refused
    Given an invited waitlist signup whose link has expired
    When a GET request to /waitlist/invite with that token
    Then the invitation is refused
