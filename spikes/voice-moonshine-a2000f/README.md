# Voice feasibility spike: Moonshine WASM in the browser

Throwaway spike for Kanbus story `chatticus-a2000f`. It runs the feasibility
tests in [docs/VOICE.md](../../docs/VOICE.md#feasibility-tests). It is not
product code. The results are recorded in `docs/VOICE.md`.

## What it does

`server.mjs` serves the spike page with `Cross-Origin-Opener-Policy:
same-origin` and a configurable `Cross-Origin-Embedder-Policy`, plus the
`@moonshine-ai/moonshine-wasm` 0.1.5 package under `/pkg/`.

`page/feed.js` loads a Moonshine transcriber and feeds a recorded fixture
into a streaming transcriber **at real-time pace**, calling `transcribe()`
on every tick as `MicTranscriber` does. It records:

- when each completed line arrives, relative to when that utterance ended in
  the fixture;
- main-thread time spent in transcription passes.

`run.mjs` drives the page in headless Chromium or WebKit through Playwright.
It samples CPU time and resident memory for Chromium's whole browser process
tree, and writes a JSON result to `results/`. WebKit's content process is
not a child of the runner, so only the in-page figures are valid for WebKit.

`page/index.html` and `page/spike.js` are an interactive live-microphone demo
(`MicTranscriber`). Every completed line is routed the way docs/VOICE.md
describes:

- **Sent:** the line starts with a teammate's name. Exact names always
  count. A phonetic match counts only when the transcript puts a comma after
  the word, as it does for a name spoken as an address.
- **Local command:** the line is in the closed command grammar, or is an
  answer such as "approve, maple falcon" or "option 2".
- **Discarded:** anything else.

Nothing leaves the tab. Run `npm run serve` and open http://localhost:4173 in
Chrome or Safari; `localhost` counts as a secure context, so the browser will
ask for microphone access.

`scripts/live-mic-probe.mjs` drives the same demo headless, using Chromium's
fake microphone fed with the fixture. It needs the server running.

## Fixture

`scripts/make_fixture.py` uses macOS `say` (voice Samantha) to synthesize 12
utterances, with 4 s of silence between them:

- addressed instructions;
- local commands;
- an approval with a confirmation code;
- unaddressed chatter.

It writes `fixtures/utterances.wav` (16 kHz mono, 72.4 s) and the script
with the true start and end time of each utterance. Synthetic speech is
cleaner than a real microphone in a real room, so treat accuracy here as an
upper bound.

## Run

```bash
npm install
npx playwright install chromium webkit
npm run fixture
VOICE_SPIKE_ENGINE=chromium VOICE_SPIKE_THREADS=2 node run.mjs
```

| Variable | Values | Default |
|---|---|---|
| `VOICE_SPIKE_ENGINE` | `chromium`, `webkit` | `chromium` |
| `VOICE_SPIKE_ARCH` | `TinyStreaming`, `SmallStreaming`, `MediumStreaming` | `TinyStreaming` |
| `VOICE_SPIKE_FIXTURE` | `speech`; `silence` (zeros, same length); `idle` (no model, baseline) | `speech` |
| `VOICE_SPIKE_THREADS` | Overrides `navigator.hardwareConcurrency`, which sizes the WASM thread pool | the machine's core count |
| `VOICE_SPIKE_COEP` | `require-corp`, `credentialless`, `none` | `require-corp` |
| `VOICE_SPIKE_LOOPS` | Times to repeat the fixture | `1` |
| `VOICE_SPIKE_KEYTERMS` | `on`, `off` | `on` |

`python3 scripts/summarize.py` recomputes latency, CPU, memory and
misrecognitions from every file in `results/`.

The model files come from `download.moonshine.ai` and are cached by the
browser.
