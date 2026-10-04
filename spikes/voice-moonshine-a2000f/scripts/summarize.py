import json
import statistics
from collections import Counter
from pathlib import Path

results_directory = Path(__file__).resolve().parent.parent / "results"
for result_path in sorted(results_directory.glob("*.json")):
    result = json.loads(result_path.read_text())
    gaps = sorted(line["secondsAfterSpeechEnded"] for line in result.get("lines", []) if line["secondsAfterSpeechEnded"] is not None)
    summary = {
        "outcome": result.get("outcome"),
        "isolated": result.get("crossOriginIsolated"),
        "pool": result.get("threadPool"),
        "keyterms": bool(result.get("keyterms")),
        "loadSeconds": round(result["loadSeconds"], 1) if result.get("loadSeconds") else None,
        "treeCpuPercent": result.get("browserProcessTreeCpuPercentOfOneCore"),
        "mainThreadPercent": result.get("computeBusyPercentOfOneThread"),
        "peakTreeRssMb": result.get("peakBrowserProcessTreeRssMb"),
        "lines": len(gaps),
    }
    if gaps:
        summary.update(
            medianSeconds=round(statistics.median(gaps), 2),
            p95Seconds=gaps[int(len(gaps) * 0.95)] if len(gaps) >= 20 else None,
            maxSeconds=max(gaps),
        )
    print(result_path.name)
    print("  ", summary)
    wrong = Counter(line["heard"] for line in result.get("lines", []) if line["expected"] and line["heard"].rstrip(".,:").lower() != line["expected"].rstrip(".,:").lower())
    for heard, count in wrong.most_common():
        print(f"   {count}x {heard}")
