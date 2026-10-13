import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FilesApiError } from "./computer-files";
import {
  EDIT_MAX_BYTES,
  SAVE_AUTO_RETRY_LIMIT,
  beginSave,
  changeDraft,
  changedSinceLoad,
  describeSaveSuccess,
  draftIsChanged,
  failSave,
  offerEditor,
  saveBlockedReason,
  startEditSession,
} from "./computer-files-edit";
import { maskedFileRange, textFileRange } from "./computer-files-fixtures";

const live = { ...textFileRange, source: "live" as const };

function session() {
  return startEditSession(live);
}

describe("the draft", () => {
  it("starts equal to the loaded text and is changed by typing", () => {
    const started = session();
    assert.equal(draftIsChanged(started), false);
    const typed = changeDraft(started, `${started.draft}more`);
    assert.equal(draftIsChanged(typed), true);
    assert.equal(changeDraft(typed, typed.draft), typed);
  });

  it("clears a failure notice when the text changes", () => {
    const failed = failSave(beginSave(session()), new FilesApiError(503, "owner_timeout", "x"));
    assert.equal(failed.kind, "kept");
    if (failed.kind !== "kept") return;
    assert.equal(failed.session.notice?.kind, "error");
    assert.equal(changeDraft(failed.session, "other").notice, null);
  });

  it("blocks Save while saving, over 256 KiB, and for NUL", () => {
    assert.equal(saveBlockedReason(session()), null);
    assert.equal(saveBlockedReason(beginSave(session())), "Saving");
    assert.match(saveBlockedReason(changeDraft(session(), "x".repeat(EDIT_MAX_BYTES + 1))) ?? "", /over 256 KiB/);
    assert.match(saveBlockedReason(changeDraft(session(), "a\u0000b")) ?? "", /NUL/);
  });
});

describe("what a save answered", () => {
  it("says Saved on the computer, with the saved-copy line, for a live save", () => {
    const message = describeSaveSuccess({ source: "live", backed_up: false, kept_as: null });
    assert.equal(message.headline, "Saved on the computer");
    assert.equal(message.detail, "Not yet in the saved copy");
  });

  it("says the change will be applied when the computer starts, with no saved-copy line, for an overlay save", () => {
    const message = describeSaveSuccess({ source: "overlay", backed_up: true, kept_as: null });
    assert.equal(message.headline, "Saved. Your change will be applied when the computer starts");
    assert.equal(message.detail, null);
  });

  it("names the file a simultaneous change was kept as", () => {
    const message = describeSaveSuccess({ source: "live", backed_up: false, kept_as: "/workspace/plan.md.conflict" });
    assert.equal(message.keptAsNotice, "A change made at the same moment was kept as plan.md.conflict");
  });
});

describe("a save that failed", () => {
  it("is a conflict on precondition_failed and carries the new base hash", () => {
    const failure = failSave(
      beginSave(session()),
      new FilesApiError(409, "precondition_failed", "x", { currentSha256: "f".repeat(64) }),
    );
    assert.equal(failure.kind, "conflict");
    if (failure.kind === "conflict") {
      assert.equal(failure.currentSha256, "f".repeat(64));
      assert.equal(failure.session.phase, "editing");
    }
  });

  it("keeps the draft and retries by itself three times for a computer that is starting", () => {
    let current = beginSave(session());
    const waits: Array<number | null> = [];
    for (let attempt = 0; attempt < SAVE_AUTO_RETRY_LIMIT + 1; attempt += 1) {
      const failure = failSave(current, new FilesApiError(503, "computer_starting", "x", { retryAfterMs: 2000 }));
      assert.equal(failure.kind, "kept");
      if (failure.kind !== "kept") return;
      waits.push(failure.retryInMs);
      assert.equal(failure.session.draft, current.draft);
      current = beginSave(failure.session);
    }
    assert.deepEqual(waits, [2000, 2000, 2000, null]);
  });

  it("does not retry by itself for an error that waiting will not fix", () => {
    const failure = failSave(beginSave(session()), new FilesApiError(409, "overlay_full", "x"));
    assert.equal(failure.kind, "kept");
    if (failure.kind === "kept") assert.equal(failure.retryInMs, null);
  });
});

describe("whether the editor is offered", () => {
  it("is offered for a live, editable text file", () => {
    assert.deepEqual(offerEditor(live), { offered: true });
  });

  it("is not offered for a stale answer, a masked file, a truncated file or a file over 256 KiB", () => {
    assert.deepEqual(offerEditor({ ...live, stale: true, fallback_reason: "owner_timeout" }), { offered: false, reason: "not-live-enough" });
    assert.equal(offerEditor(maskedFileRange).offered, false);
    assert.deepEqual(offerEditor({ ...live, truncated: true }), { offered: false, reason: "too-large" });
    assert.deepEqual(offerEditor({ ...live, size: EDIT_MAX_BYTES + 1 }), { offered: false, reason: "too-large" });
    assert.deepEqual(offerEditor({ ...live, editable: false }), { offered: false, reason: "not-editable" });
    assert.equal(offerEditor(null).offered, false);
  });

  it("is offered for a revealed secret", () => {
    assert.equal(offerEditor({ ...live, masked: false, revealed: true }).offered, true);
  });
});

describe("the change probe", () => {
  it("sees a different size or modified time, not an identical stat", () => {
    const loaded = session();
    assert.equal(changedSinceLoad(loaded, { size: loaded.loadedSize, modified_at: loaded.loadedModifiedAt }), false);
    assert.equal(changedSinceLoad(loaded, { size: loaded.loadedSize + 1, modified_at: loaded.loadedModifiedAt }), true);
    assert.equal(changedSinceLoad(loaded, { size: loaded.loadedSize, modified_at: "2030-01-01T00:00:00.000Z" }), true);
  });
});
