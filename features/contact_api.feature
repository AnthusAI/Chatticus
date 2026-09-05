Feature: The contact API records leads for professional services and training

  The marketing site's contact forms live in the private marketing repo now
  (chatticus-3926bc) and post to this API same-origin. UI-observable behavior
  (form fields, links, conversion events) is covered there; this covers the
  backend half -- that a submission is actually recorded as a contact lead --
  independent of which UI posts to it.

  Background:
    Given an empty control plane

  Scenario: A professional services contact submission is recorded
    When a professional services contact lead is submitted for "services@example.com"
    Then a contact lead is recorded with type professional_services

  Scenario: A professional training contact submission is recorded
    When a professional training contact lead is submitted for "training@example.com"
    Then a contact lead is recorded with type professional_training
