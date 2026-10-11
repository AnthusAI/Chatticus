Feature: A container owner reaches the Front Door with its own signed token, never with the invoke key
  As the operator of many organizations on one deployment
  I want a container owner to hold nothing that opens another organization
  So that a compromised owner is a breach of its own organization's running turn and no one else

  The invoke key is one value for the whole deployment: with it a caller can
  register as a worker of any organization and use every host route of that
  organization. The container owner therefore never holds it. The starter gives
  the owner a host token instead: the same claims as its model gateway token
  (organization, bot, turn, owner id) plus the host start generation, signed
  for the host audience, so neither token works on the other's surface. The
  starter also registers the owner as a worker, which the invoke key used to
  buy. The Front Door accepts the host token on exactly the five routes the
  owner calls, for the organization it names, while no other owner has taken
  its turn over. Every other route still needs the invoke key.

  Background:
    Given an empty control plane backed by a durable messaging store with HTTP
    And tenant "anthus" user "ryan" has a channel with a named bot "Helper"
    And bot "Helper" has an active turn owned by a container owner
    And the front door requires the invoke key "deployment-invoke-key"
    And the starter claimed host start generation 1 and registered the container owner as a worker
    And the container holds a host token for its turn valid for 300 seconds

  Scenario: The host token opens every route the owner calls
    When the container reports through every route it uses with its token
    Then every one of those routes answered with status 200

  Scenario Outline: A token that does not belong to this owner, organization or moment is refused
    Given the container holds a host token that is "<variant>"
    When the container calls "GET" "/orgs/{tenant}/host/computer" with its token
    Then the front door answers with status <status>

    Examples:
      | variant                              | status |
      | for another organization             | 403    |
      | for a turn that does not exist       | 403    |
      | bound to another owner of the turn   | 403    |
      | already expired                      | 401    |
      | signed with another key              | 401    |
      | minted for the model gateway         | 401    |

  Scenario: An owner that another owner replaced on the turn is refused on every route
    Given the container's lease runs out and the owner "second-owner" takes the turn over
    When the container calls "GET" "/orgs/{tenant}/host/computer" with its token
    Then the front door answers with status 403
    When the container calls "POST" "/orgs/{tenant}/host/heartbeat" with its token
    Then the front door answers with status 403

  Scenario: A request with neither a token nor the invoke key is refused
    When the container calls "GET" "/orgs/{tenant}/host/computer" without any token
    Then the front door answers with status 403

  Scenario Outline: The host token is refused on every route the owner does not call
    When the container calls "<method>" "<path>" with its token
    Then the front door answers with status 403

    Examples:
      | method | path                                        |
      | POST   | /orgs/{tenant}/workers/register             |
      | POST   | /orgs/{tenant}/host/actions/claim           |
      | POST   | /orgs/other/host/heartbeat                  |
      | GET    | /orgs/other/host/computer                   |
      | GET    | /orgs/{tenant}/bots                         |
      | POST   | /operator/orgs/{tenant}/enable              |

  Scenario: The host token cannot register a worker
    When the container registers the worker "intruder" with its token
    Then the front door answers with status 403
    And the organization has no worker "intruder"

  Scenario: The owner reports the computer stopped only for the start generation it was started for
    When the container reports the computer stopped for generation 2
    Then the front door answers with status 403
    When the container reports the computer stopped without naming a generation
    Then the front door answers with status 403
    And the organization computer still holds the host start lease of generation 1
    When the container reports the computer stopped for generation 1
    Then the front door answers with status 200
    And the organization computer has released the host start lease of generation 1

  Scenario: An owner of a superseded start generation cannot stop the computer a newer generation runs
    Given the host start lease expires and the starter claims host start generation 2
    When the container reports the computer stopped for generation 1
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
