export function Wordmark() {
  return (
    <span className="wordmark" aria-label="Chatticus">
      <span className="wordmark-mark" aria-hidden="true">
        <span className="wordmark-core" />
        <span className="wordmark-signal" />
      </span>
      <span>chatticus<span className="wordmark-period">.</span></span>
    </span>
  );
}
