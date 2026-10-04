import json
import re
import statistics
from collections import Counter
from pathlib import Path

def normalize(text):
    return " ".join(re.sub(r"[^\w\s]", " ", text.lower()).split())


results_directory = Path(__file__).resolve().parent.parent / "results"
for result_path in sorted(results_directory.glob("*.json")):
    result = json.loads(result_path.read_text())
    gaps = sorted(line["secondsAfterSpeechEnded"] for line in result.get("lines", []) if line["secondsAfterSpeechEnded"] is not None)
    summary = {
        "outcome": result.get("outcome"),
        "isolated": result.get("crossOriginIsolated"),
        "pool": result.get("threadPool"),
        "keyterms": ("on" if result["keyterms"] else "off") if "keyterms" in result else "on (pre-switch)",
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
    wrong = Counter(line["heard"] for line in result.get("lines", []) if line["expected"] and normalize(line["heard"]) != normalize(line["expected"]))
    for heard, count in wrong.most_common():
        print(f"   {count}x {heard}")
