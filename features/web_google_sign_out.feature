Feature: Google sign-in session and sign-out in the web SPA
  As a Chatticus user
  I want my signed-in session to survive a reload
  And signing out to end my Cognito and Google SSO session
  So that I am not sent through Google's account picker on every visit
  And the next person on a shared machine still sees the account chooser

  Background:
    Given the web SPA Cognito auth module

  Scenario: Reloading the workspace keeps the signed-in session
    Given the web SPA has an active signed-in session
    When the person reloads the workspace
    Then the web SPA still has that signed-in session
    And the person is not sent through Google sign-in

  Scenario: Signing out ends the SSO session instead of clearing memory only
    Given the web SPA has an active signed-in session with id_token "session-token"
    When the person signs out from the web SPA
    Then the web SPA begins Cognito sign-out redirect with id_token_hint "session-token"
    And the web SPA does not clear the session with removeUser only

  Scenario: Signing back in after sign-out prompts for account selection
    Given the web SPA has an active signed-in session with id_token "session-token"
    And the person has signed out of the web SPA
    When the person starts Google sign-in from the web SPA
    Then the Google authorization request includes prompt "select_account"

  Scenario: Returning from Cognito sign-out clears the persisted session
    Given the web SPA is completing a Cognito sign-out redirect
    When the sign-out redirect callback is handled
    Then the web SPA persisted session is cleared

  Scenario: Signing in without a prior sign-out does not prompt for account selection
    Given the web SPA has no signed-in session
    When the person starts Google sign-in from the web SPA
    Then the Google authorization request does not include prompt "select_account"
    And the Google authorization request includes identity_provider "Google"

  Scenario: Reloading without a persisted OIDC user restores via silent sign-in when the IdP session is valid
    Given the web SPA IdP session is valid but no persisted OIDC user
    When the person reloads the workspace
    Then the web SPA attempted silent sign-in
    And the web SPA still has that signed-in session
    And the person is not sent through Google sign-in

  Scenario: Reloading with an expired id_token renews silently before showing the sign-in panel
    Given the web SPA has an expired id_token and a valid refresh token
    When the person reloads the workspace
    Then the web SPA attempted silent sign-in
    And the web SPA still has that signed-in session
    And the person is not sent through Google sign-in
