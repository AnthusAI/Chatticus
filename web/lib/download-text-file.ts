import type { CostsDownload } from "./costs-api";

/** Hands a text file to the browser as a download. */
export function downloadTextFile(file: CostsDownload): void {
  const url = URL.createObjectURL(new Blob([file.text], { type: `${file.mimeType};charset=utf-8` }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
