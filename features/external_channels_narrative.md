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

5. `email_inbound_parsing.feature` and `email_threading.feature` -- the email transport reads a message, and a thread is one channel.
6. `email_message_rendering.feature` -- a reply is one plain text mail that threads, says it is automated, and is recognized if it
   comes back.
7. `email_delivery_status.feature` -- what SES answers is classified, and a bounce or complaint suppresses the address.

Planned and not yet written, in the order they will join the story:

- The SES client, its ingress and event Lambdas, and the sandbox proof.
- Trust classes, quarantine, loop prevention, limits and the owner panel.
- Slack, then Teams, then text messages.
