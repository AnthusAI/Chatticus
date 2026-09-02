Feature: Google sign-in and sign-out in the web SPA
  As a Chatticus user
  I want signing out to end my Cognito and Google SSO session
  So that signing back in on the same browser shows Google's account chooser

  Background:
    Given the web SPA Cognito auth module

  Scenario: Signing out ends the SSO session instead of clearing memory only
    Given the web SPA has an active signed-in session with id_token "session-token"
    When the person signs out from the web SPA
    Then the web SPA begins Cognito sign-out redirect with id_token_hint "session-token"
    And the web SPA does not clear the session with removeUser only

  Scenario: Signing back in after sign-out prompts for account selection
    When the person starts Google sign-in from the web SPA
    Then the Google authorization request includes prompt "select_account"

  Scenario: Returning from Cognito sign-out clears the in-memory session
    Given the web SPA is completing a Cognito sign-out redirect
    When the sign-out redirect callback is handled
    Then the web SPA in-memory session is cleared
