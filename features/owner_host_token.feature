Feature: The invoke key opens the host worker routes of a customer's computer, and a container owner never holds it
  As the operator of many organizations on one deployment
  I want a container owner to hold nothing that opens another organization
  So that a compromised owner is a breach of its own organization's computer and no one else

  The invoke key is one value for the whole deployment: with it a caller can
  register as a worker of any organization and use every host route of that
  organization. The container owner therefore never holds it. It holds a
  supervisor token instead, which the Front Door accepts on a fixed list of
  owner routes (told in owner_supervisor_server.feature). The host worker that
  serves a computer in a customer's account still registers with the invoke key
  and then speaks with its own worker token, and a request that carries neither
  is refused.

  Background:
    Given an empty control plane backed by a durable messaging store with HTTP
    And tenant "anthus" user "ryan" has a channel with a named bot "Helper"
    And the front door requires the invoke key "deployment-invoke-key"

  Scenario: A request with neither a token nor the invoke key is refused
    When a caller sends "GET" "/orgs/{tenant}/host/computer" without any token
    Then the front door answers with status 403

  Scenario: The invoke key still opens the routes of the host worker of a customer's computer
    When a host worker registers over HTTP with the invoke key
    Then the front door answers with status 200
    When the host worker calls the heartbeat route with its worker token and the invoke key
    Then the front door answers with status 200
    When the host worker calls the heartbeat route with its worker token and no invoke key
    Then the front door answers with status 403
    When the host worker calls the heartbeat route with its worker token and a wrong invoke key
    Then the front door answers with status 403

  Scenario: A worker token looks up its own worker and is refused once the worker is replaced
    When a host worker registers over HTTP with the invoke key
    And the host worker calls the heartbeat route with its worker token and the invoke key
    Then the front door answers with status 200
    When the host worker registers again and presents its previous worker token
    Then the front door answers with status 403
