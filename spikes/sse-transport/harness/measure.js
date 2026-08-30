const statusEl = document.getElementById("status");
const logEl = document.getElementById("log");
const downloadButton = document.getElementById("download-json");

let latestSummary = null;

function logLine(message) {
  logEl.textContent = `${logEl.textContent}${message}\n`;
}

function setStatus(message) {
  statusEl.textContent = message;
}

function percentile(sortedValues, percentileValue) {
  if (sortedValues.length === 0) {
    return null;
  }
  const index = Math.min(
    sortedValues.length - 1,
    Math.ceil((percentileValue / 100) * sortedValues.length) - 1,
  );
  return sortedValues[index];
}

function summarizeFrames(frames, metadata) {
  const gaps = frames
    .map((frame) => frame.inter_frame_gap_ms)
    .filter((gap) => gap !== null)
    .sort((left, right) => left - right);

  const sameTickBatches = frames.filter((frame) => frame.same_event_loop_tick).length;
  const longPauseBatches = frames.filter((frame) => frame.after_long_pause).length;

  return {
    ...metadata,
    frame_count: frames.length,
    duration_ms:
      frames.length > 0 ? frames[frames.length - 1].client_unix_ms - frames[0].client_unix_ms : 0,
    first_byte_ms: frames.length > 0 ? frames[0].client_unix_ms - metadata.started_client_ms : null,
    inter_frame_gap_ms: {
      p50: percentile(gaps, 50),
      p95: percentile(gaps, 95),
      p99: percentile(gaps, 99),
      min: gaps.length > 0 ? gaps[0] : null,
      max: gaps.length > 0 ? gaps[gaps.length - 1] : null,
    },
    batching: {
      same_event_loop_tick_frames: sameTickBatches,
      after_long_pause_frames: longPauseBatches,
      likely_batched: sameTickBatches > 0 || longPauseBatches > 0,
    },
    first_frame: frames[0] ?? null,
    last_frame: frames.length > 0 ? frames[frames.length - 1] : null,
    frames,
  };
}

function buildStreamUrl(baseUrl, durationSeconds, maxFrames = null) {
  const url = new URL(baseUrl);
  url.searchParams.set("duration", String(durationSeconds));
  if (maxFrames !== null) {
    url.searchParams.set("max_frames", String(maxFrames));
  }
  return url.toString();
}

function runMeasurement({
  pathLabel,
  streamUrl,
  durationSeconds,
  reconnectAfterFrames = 0,
  backgrounded = false,
}) {
  return new Promise((resolve) => {
    const startedClientMs = Date.now();
    const frames = [];
    let eventSource = null;
    let reconnectObserved = false;
    let reconnectResult = null;
    let closeReason = null;
    let lastClientMs = null;
    let lastEventLoopMs = null;
    let seqBeforeReconnect = null;

    const finish = (reason) => {
      if (eventSource) {
        eventSource.close();
      }
      const summary = summarizeFrames(frames, {
        path: pathLabel,
        stream_url: streamUrl,
        duration_seconds_requested: durationSeconds,
        started_client_ms: startedClientMs,
        ended_client_ms: Date.now(),
        backgrounded,
        reconnect_after_frames: reconnectAfterFrames,
        reconnect_result: reconnectResult,
        close_reason: reason,
      });
      resolve(summary);
    };

    const handleMessage = (event) => {
      const now = Date.now();
      const payload = JSON.parse(event.data);
      const sameEventLoopTick = lastEventLoopMs === now;
      const afterLongPause =
        lastClientMs !== null && now - lastClientMs > 1000 && frames.length > 0;

      if (
        reconnectAfterFrames > 0 &&
        !reconnectObserved &&
        frames.length === reconnectAfterFrames
      ) {
        reconnectObserved = true;
        const expectedSeq = seqBeforeReconnect + 1;
        reconnectResult = {
          expected_next_seq: expectedSeq,
          actual_next_seq: payload.seq,
          success: payload.seq === expectedSeq,
        };
      }

      frames.push({
        seq: payload.seq,
        server_unix_ms: payload.server_unix_ms,
        client_unix_ms: now,
        inter_frame_gap_ms: lastClientMs === null ? null : now - lastClientMs,
        same_event_loop_tick: sameEventLoopTick,
        after_long_pause: afterLongPause,
        event_id: event.lastEventId,
      });

      lastClientMs = now;
      lastEventLoopMs = now;

      if (frames.length % 20 === 0) {
        setStatus(`${pathLabel}: ${frames.length} frames, last seq ${payload.seq}`);
      }
    };

    const handleError = () => {
      if (frames.length === 0) {
        return;
      }
      if (reconnectAfterFrames > 0 && !reconnectObserved) {
        return;
      }
      closeReason = "stream_closed";
      finish(closeReason);
    };

    const connect = () => {
      const baseUrl = streamUrl.split("?")[0];
      const url =
        reconnectAfterFrames > 0
          ? buildStreamUrl(baseUrl, durationSeconds, reconnectAfterFrames)
          : streamUrl;
      eventSource = new EventSource(url);
      eventSource.onmessage = handleMessage;
      eventSource.onerror = handleError;
      eventSource.onopen = () => {
        setStatus(`${pathLabel}: connected`);
      };
    };

    if (reconnectAfterFrames > 0) {
      seqBeforeReconnect = reconnectAfterFrames - 1;
    }
    connect();

    setTimeout(() => {
      if (reconnectAfterFrames > 0 && reconnectResult === null && frames.length > reconnectAfterFrames) {
        const resumedSeq = frames[frames.length - 1].seq;
        const expectedSeq = reconnectAfterFrames;
        reconnectResult = {
          expected_next_seq: expectedSeq,
          actual_next_seq: resumedSeq,
          success: resumedSeq === expectedSeq,
        };
      }
      finish("duration_elapsed");
    }, durationSeconds * 1000 + 500);
  });
}

async function startRun(options) {
  downloadButton.disabled = true;
  logEl.textContent = "";
  setStatus("Running...");
  try {
    latestSummary = await runMeasurement(options);
    logEl.textContent = JSON.stringify(latestSummary, null, 2);
    setStatus(`Done: ${options.pathLabel}`);
    downloadButton.disabled = false;
    if (window.__chatticusHarness) {
      window.__chatticusHarness.latestSummary = latestSummary;
    }
    return latestSummary;
  } catch (error) {
    setStatus(`Failed: ${error.message}`);
    throw error;
  }
}

function currentDurationSeconds() {
  return Number(document.getElementById("duration-seconds").value);
}

function currentReconnectAfter() {
  return Number(document.getElementById("reconnect-after").value);
}

document.getElementById("run-direct").addEventListener("click", () => {
  const baseUrl = document.getElementById("direct-url").value.trim();
  const durationSeconds = currentDurationSeconds();
  return startRun({
    pathLabel: "direct",
    streamUrl: buildStreamUrl(baseUrl, durationSeconds),
    durationSeconds,
    reconnectAfterFrames: 0,
    backgrounded: document.hidden,
  });
});

document.getElementById("run-cloudfront").addEventListener("click", () => {
  const baseUrl = document.getElementById("cloudfront-url").value.trim();
  const durationSeconds = currentDurationSeconds();
  return startRun({
    pathLabel: "cloudfront",
    streamUrl: buildStreamUrl(baseUrl, durationSeconds),
    durationSeconds,
    reconnectAfterFrames: 0,
    backgrounded: document.hidden,
  });
});

document.getElementById("run-reconnect-direct").addEventListener("click", () => {
  const baseUrl = document.getElementById("direct-url").value.trim();
  const durationSeconds = currentDurationSeconds();
  const reconnectAfter = currentReconnectAfter() || 20;
  return startRun({
    pathLabel: "direct_reconnect",
    streamUrl: buildStreamUrl(baseUrl, durationSeconds),
    durationSeconds,
    reconnectAfterFrames: reconnectAfter,
    backgrounded: document.hidden,
  });
});

document.getElementById("run-reconnect-cloudfront").addEventListener("click", () => {
  const baseUrl = document.getElementById("cloudfront-url").value.trim();
  const durationSeconds = currentDurationSeconds();
  const reconnectAfter = currentReconnectAfter() || 20;
  return startRun({
    pathLabel: "cloudfront_reconnect",
    streamUrl: buildStreamUrl(baseUrl, durationSeconds),
    durationSeconds,
    reconnectAfterFrames: reconnectAfter,
    backgrounded: document.hidden,
  });
});

document.getElementById("download-json").addEventListener("click", () => {
  if (!latestSummary) {
    return;
  }
  const blob = new Blob([JSON.stringify(latestSummary, null, 2)], {
    type: "application/json",
  });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `sse-spike-${latestSummary.path}-${Date.now()}.json`;
  link.click();
});

window.__chatticusHarness = {
  runMeasurement,
  buildStreamUrl,
  summarizeFrames,
  latestSummary: null,
};
