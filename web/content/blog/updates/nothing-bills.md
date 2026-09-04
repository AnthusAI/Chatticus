---
title: Nothing bills while nobody is working
date: 2026-09-04
description: A quiet household should not pay rent on an empty office. The idle floor is a product requirement, and the computer is summoned when a turn needs it.
ogHeadline: Nothing bills while nobody is working
ogTagline: Zero at idle. The computer is summoned.
relatedWiki:
  - shared-computer
  - always-on
---

A quiet household should not pay for capacity that is sitting empty. Chatticus holds no always-on process in the token path. There is no load balancer in front of the API. The transcript is DynamoDB. A stream is scoped to **one turn**, never to a tab left open. Reconnecting is a new request that reads already-committed chunks.

The computer is summoned when a turn needs it, not assumed at login. A bot can answer while the machine is still booting. Readiness is per-capability: talking, files, browser. Holding the whole agent loop behind "computer ready" is the wrong picture.

Zero at idle is the requirement. A design that is cheaper on average but charges rent all night loses.

Workers pull jobs. The control plane never reaches into a garage Mac. The same Ubuntu image runs on Fargate, EC2, and local Docker. Durable disk is an S3 snapshot plus a local cache on the current host — not a live container migration, and not S3 mounted as the root filesystem.

This is written down so we cannot quietly trade it away. [Design challenges](https://github.com/AnthusAI/Chattic.us/blob/develop/docs/DESIGN_CHALLENGES.md) lists the requirements and, as importantly, the non-requirements. [Messaging](https://github.com/AnthusAI/Chattic.us/blob/develop/docs/MESSAGING.md) is the transcript and the one-turn stream. If a later post contradicts those two, believe those two until we publish a correction.
