Feature: The per-turn child reads its credentials from its supervisor over a local socket and holds none of its own
  As an operator of an organization's computer
  I want the child that runs one turn to ask the supervisor for its credentials each time it needs them and to keep none in its environment
  So that a turn can run longer than the hour its first credentials last, a credential that could not be renewed ends the turn instead of being replaced by another, and the shell the model drives never sees a credential

  The supervisor holds the credentials of the turn it serves and renews them
  twenty minutes before they end. The child never renews and never calls the
  control plane: it reads whatever the supervisor holds over a Unix domain
  socket on a filesystem path, inside a directory only root can enter, every
  time the AWS SDK asks for credentials and every time a request goes to the
  model gateway. The socket has one operation, reads only the credentials of the
  dispatch being served, and answers nothing for any other. Its file has mode
  0600 as soon as it is bound, and the supervisor refuses to serve on a file with
  any wider mode.

  The child builds every AWS client with an explicit credentials provider that
  asks the socket, and applies the gateway token to each HTTP request in a
  wrapper around the request function. A child whose supervisor holds no usable
  credentials fails the request and the turn ends as an error; it never reads
  the process environment, the container credentials endpoint or the instance
  metadata service. The contract is docs/OWNER_CREDENTIAL_RENEWAL.md, sections 2
  (F2, F3, F9, F16), 3 (R10, R11, R12), 5, 8.3 and 8.4. The scenario about the
  shell's reach into the built container is in the draft
  computer_owner_credential_renewal.feature and is run against the real image by
  computer/test_owner_container.sh.

  The child's own credentials are the control plane's fakes of the supervisor
  scenarios. A recording endpoint on a loopback port stands in for DynamoDB, S3 and
  the model gateway, and the real AWS clients and the real model collection of the
  child are pointed at it, so what it records is what the child really signed
  with. The process environment of each scenario holds an AWS access key, and the
  endpoint holds the paths of a container credentials endpoint and an instance
  metadata service, none of which the child may use.

  Background:
    Given a supervisor whose task environment holds a bootstrap token
    And the control plane vetoes every idle stop with "work_pending"
    And the supervisor serves its child over a socket in a directory only root can enter

  @supervisor
  Scenario: The socket is a filesystem socket that only its owner can open
    When the supervisor starts
    Then the supervisor listens on a filesystem socket with mode 0600 in a directory with mode 0700
    And the socket path the child is told is a filesystem path in the runtime directory "/run/chatticus"

  @supervisor
  Scenario: A stale socket is replaced and the socket is removed when the supervisor stops
    Given an earlier supervisor left a stale file at the socket path
    When the supervisor starts
    Then the supervisor listens on a filesystem socket with mode 0600 in a directory with mode 0700
    When the supervisor stops serving its socket
    Then nothing is left at the socket path

  @supervisor
  Scenario: The socket answers nothing while no child runs
    When the supervisor starts
    And a process asks the socket for the credentials of dispatch "dispatch-turn-1"
    Then the socket closes the connection without an answer

  @child
  Scenario: A child reads its credentials from the supervisor and holds none in its environment
    Given the supervisor's own environment holds AWS credentials, a gateway token and the container credentials address
    And a supervisor that dispatched a turn to a child
    Then the child's environment holds the socket path and no AWS access key, secret key, session token or gateway token
    And the child's storage clients and its model gateway requests use the credentials the supervisor holds

  @supervisor
  Scenario: A turn that is not the one being served gets nothing over the socket
    Given a supervisor that dispatched a turn to a child
    When a process asks the socket for the credentials of dispatch "dispatch-other"
    Then the socket answers "no_turn"
    And the answer holds no credential
    And the supervisor's log holds "owner_credential_socket" with the outcome "no_turn" and no credential value
    When a process asks the socket for the credentials of the dispatch being served
    Then the socket answers with the credentials of the turn being served

  @supervisor
  Scenario Outline: A request the socket cannot read is answered no_turn and reveals nothing
    Given a supervisor that dispatched a turn to a child
    When a process sends the socket <request>
    Then the socket answers "no_turn"
    And the answer holds no credential
    And the supervisor's log holds "owner_credential_socket" with the outcome "malformed" and no credential value

    Examples:
      | request                                                                         |
      | a line that is not JSON                                                         |
      | a request for another operation                                                 |
      | a request with a field the protocol does not have                               |
      | a request for the dispatch being served with the wrong protocol version         |
      | a request of more than 1024 bytes                                               |
      | a request of more than 1024 bytes that never ends its line                      |

  @supervisor
  Scenario: The socket serves at most four connections at once
    Given a supervisor that dispatched a turn to a child
    When 4 processes connect to the socket and send nothing
    And a fifth process connects to the socket
    Then the supervisor closes the fifth connection without an answer
    And the other four connections are still open

  @supervisor
  Scenario: A child whose credentials have ended is told they expired
    Given the control plane answers every turn credential renewal with 503 "credentials_unavailable"
    And a supervisor that dispatched a turn to a child
    When 3600 seconds go by
    And a process asks the socket for the credentials of the dispatch being served
    Then the socket answers "expired"
    And the answer holds no credential

  @supervisor
  Scenario: What the supervisor logs about the socket names no credential
    Given a supervisor that dispatched a turn to a child
    When the child uses its storage and the model gateway every 2400 seconds for 2400 seconds
    And a process asks the socket for the credentials of dispatch "dispatch-other"
    Then the supervisor's log holds "owner_credential_socket" lines and none carries a token, a key or a credential

  @child
  Scenario: A turn that runs past the first hour keeps working
    Given a supervisor that dispatched a turn to a child
    When the child uses its storage and the model gateway every 100 seconds for 4000 seconds
    And the child ends with exit code 0
    Then the child's next request did not fail
    And the supervisor logged that the child exited clean
    And every storage request of the child after 3600 seconds carried credentials issued after 2400 seconds
    And every model gateway request of the child after 3600 seconds carried a token issued after 2400 seconds

  @child
  Scenario: A child whose credentials could not be renewed fails closed
    Given the control plane answers every turn credential renewal with 503 "credentials_unavailable"
    And a supervisor that dispatched a turn to a child
    When the child uses its storage and the model gateway every 60 seconds for 3660 seconds
    Then the child's next storage request failed for expired credentials
    And the child ended with a failure exit code
    And the supervisor logged that the child exited with that code
    And the child never used credentials from its environment or from the container's metadata service

  @child
  Scenario: The model gateway token is read for each request
    Given a supervisor that dispatched a turn to a child
    When the child sends its next request to the model gateway
    Then the request carried the token the supervisor held when it dispatched the turn
    When the supervisor renews the credentials of its turn
    And the child sends its next request to the model gateway
    Then the request carried the swapped token

  @child
  Scenario: The child holds no AWS client without explicit credentials
    Given a supervisor that dispatched a turn to a child
    And the child can no longer reach the supervisor's socket
    When the child sends a request to storage
    Then the request failed because the supervisor could not be reached
    And storage saw no request from the child
    And the child never used credentials from its environment or from the container's metadata service
