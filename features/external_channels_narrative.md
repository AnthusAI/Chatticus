# External channels: the features in reading order

The initiative is reachable bots: a member writes to a bot from email, and later Slack, Teams and text, and the answer
comes back the way it was asked. The contract is `docs/EXTERNAL_CHANNELS.md`. These features tell the story; read them
in this order.

1. `external_channel_binding.feature` -- owners bind an address to a bot; members read; strangers see nothing; the
   operator and a kill switch decide whether the feature exists at all.
2. `external_conversation_mapping.feature` -- an external conversation is exactly one Chatticus channel, found by its
   conversation key or by any earlier message it references.
3. `external_inbound_admission.feature` -- the one inbound path: route, gates, sender, deduplication, mapping, then the
   existing message admission.
4. `external_outbound_delivery.feature` -- the one outbound path: replies follow the origin of the prompt, are sent once,
   and are tracked through retries and provider callbacks.

Planned and not yet written, in the order they will join the story:

- Email parsing and threading, and email rendering, against the same port.
- The SES adapter, its ingress and event Lambdas, and the sandbox proof.
- Trust classes, quarantine, loop prevention, limits and the owner panel.
- Slack, then Teams, then text messages.
