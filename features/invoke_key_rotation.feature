Feature: The invoke key can be rotated while the Front Door is warm
  CloudFront presents one shared invoke key to the Front Door. An operator
  rotates it by putting a new value in the secret and redeploying the web
  stack. A warm Front Door must not keep trusting the old value for the life
  of its container: it reads the secret again within a minute. While the
  secret still stages the previous value, that value is accepted too, so the
  web users never see a refusal in the minutes it takes CloudFront to carry
  the new key. The operator retires the previous value when CloudFront has
  it, and from then on only the new key opens the door.

  Scenario: A rotated key is accepted after the cache window and the retired old key is refused
    Given a front door that reads the invoke key from its secret, which holds "first-key"
    Then a request with the invoke key "first-key" is let through
    When the secret is rotated to "second-key" and the previous value is retired
    Then a request with the invoke key "first-key" is let through
    When 61 seconds pass on the front door clock
    Then a request with the invoke key "second-key" is let through
    And a request with the invoke key "first-key" is refused

  Scenario: The previous key is accepted until it is retired
    Given a front door that reads the invoke key from its secret, which holds "first-key"
    When the secret is rotated to "second-key" and the previous value is kept
    And 61 seconds pass on the front door clock
    Then a request with the invoke key "second-key" is let through
    And a request with the invoke key "first-key" is let through
    When the previous value is retired
    And 61 seconds pass on the front door clock
    Then a request with the invoke key "first-key" is refused
    And a request with the invoke key "second-key" is let through

  Scenario: The health route is open and any other route refuses a request with no key
    Given a front door that reads the invoke key from its secret, which holds "first-key"
    Then a request with no invoke key is refused
    And the health route answers without an invoke key

  Scenario: A failed refresh keeps the keys already held
    Given a front door that reads the invoke key from its secret, which holds "first-key"
    When the secret cannot be read and 61 seconds pass on the front door clock
    Then a request with the invoke key "first-key" is let through
