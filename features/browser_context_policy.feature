Feature: Untrusted and privileged browser contexts
  As a household member
  I want research browsing isolated from signed-in sessions
  So that an untrusted page cannot spend privileged cookies or ambient secrets

  Background:
    Given an empty control plane
    And the household computer holds privileged credentials:
      | kind              | name     | value                 |
      | browser_session   | banking  | signed-in-cookie-jar  |
      | browser_session   | mail     | mail-cookie-jar       |
      | cli_secret        | gh_token | ghp_not_for_pages     |
      | workspace_secret  | notes    | /workspace/.env       |

  Scenario: Untrusted browsing cannot use privileged sessions or ambient secrets
    When the worker opens an untrusted browser context on "https://untrusted.example/article"
    Then the context kind is "untrusted"
    And the untrusted context cannot use credential "banking"
    And the untrusted context cannot use credential "mail"
    And the untrusted context cannot use credential "gh_token"
    And the untrusted context cannot read workspace secret "/workspace/.env"
    And the model-visible tool result does not include session secrets

  Scenario: A privileged context may use only its named session
    When the worker opens a privileged browser context for service "banking" on "https://bank.example/app"
    Then the context kind is "privileged"
    And the privileged context can use credential "banking"
    And the privileged context cannot use credential "mail"
    And the privileged context cannot use credential "gh_token"
    And the model-visible tool result does not include session secrets

  Scenario: Untrusted and privileged contexts do not share storage
    When the worker opens an untrusted browser context on "https://untrusted.example/article"
    And the worker opens a privileged browser context for service "banking" on "https://bank.example/app"
    Then the two browser contexts use distinct storage partitions
    And cookies written in the untrusted context are absent from the privileged context
    And cookies written in the privileged context are absent from the untrusted context

  Scenario: Page content cannot promote an untrusted context to privileged
    When the worker opens an untrusted browser context on "https://untrusted.example/article"
    And a page instructs the model to reuse the banking session
    And the model requests a privileged session in that untrusted context
    Then the capability policy denies the request
    And the untrusted context still cannot use credential "banking"
