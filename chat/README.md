# Shared chat entry points

This is the first extraction of the existing Chatticus chat presentation and
turn observer. Chatticus and Papyrus consume the same source; this module does
not implement a second agent loop.

The existing `chatticus` UI-kit dependency now exports:

- `chatticus/chat-client`: wire DTOs, turn-scoped fetch/SSE observer, bounded
  reconnect/deduplication, and pure live/committed activity reducers.
- `chatticus/chat-react`: controlled `ChatRuntime`, normalized `ChatMessage`,
  transcript/composer, safe markdown and activity/tool components.
- `chatticus/chat.css`: generated component CSS scoped to `.chatticus-chat`.

The exports ship TypeScript source, like the existing UI kit. Next consumers
must include `chatticus` in `transpilePackages`. Import the component stylesheet
once in the host layout. Pin a Git commit/archive until a separate registry
release is reviewed; this change does not publish a package or change the
private root package's release policy.

The client accepts a host endpoint, a fresh asynchronous header provider, and an
optional fetch implementation. It never reads Chatticus membership, Amplify,
local storage, credentials or model configuration. Closing the SSE observer
aborts its connection; it does not request cancellation of server work.

`ChatRuntime` takes host-normalized `ThreadMessageLike` messages, running/disabled
state and an async send callback. Optional presentation hooks receive message
IDs and can supply headers, domain tool bodies or footers. Papyrus retains
its editorial tool cards and navigation; Chatticus retains its cost ledger.
The host owns authorization, channel selection, persistence, errors and retries.
A disabled send is blocked at the callback boundary as well as in the UI.

Optional `metadata.custom` fields used by the shared renderer are `authorLabel`,
`createdAt`, `failed`, `isStreaming`, `isStreamingShell`, `slow`, and `activity`
(the exported `TurnActivity` model). Hosts that only need ordinary messages can
omit them. Do not put credentials or private policy packs in presentation data.

Theme only the component boundary with these CSS custom properties:
`--chatticus-chat-surface`, `--chatticus-chat-raised`,
`--chatticus-chat-foreground`, `--chatticus-chat-accent`,
`--chatticus-chat-error`, `--chatticus-chat-action` and
`--chatticus-chat-action-text`. System colors are defaults. There is no page
reset, global theme or login/roster/computer requirement. Regenerate the checked
stylesheet with `npm run build:chat-styles` after changing component classes.

Run the hermetic consumer/replay acceptance from `conversation/`:

```
node --import tsx ../node_modules/@cucumber/cucumber/bin/cucumber.js --config cucumber-embedded.mjs
```

This increment does not extract the durable server runner, change backend
permissions or migrate Papyrus transcripts. Those remain separate gates in the
reviewed plan (PPY-de11ec / PPY-a438d0 / chatticus-080b0e).
