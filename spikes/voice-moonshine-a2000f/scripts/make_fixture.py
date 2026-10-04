import json
import subprocess
import tempfile
import wave
from pathlib import Path

utterances = [
    "Ada, open a pull request for the voice spike against develop.",
    "Switch to Grace.",
    "Grace, what is the status of the release branch?",
    "I think we should get lunch after this meeting.",
    "Repeat that.",
    "Ada, rename the branch to voice moonshine and push it.",
    "Stop listening.",
    "Approve, blue seven.",
    "Option two.",
    "Grace, run the behave suite and tell me which scenarios fail.",
    "Did you see the game last night?",
    "Scratch that.",
]
sample_rate = 16000
silence_seconds = 4.0
fixture_directory = Path(__file__).resolve().parent.parent / "fixtures"
frames = bytearray()
script = []
leading_silence = b"\x00\x00" * int(sample_rate * 2.0)
frames += leading_silence
with tempfile.TemporaryDirectory() as temporary_directory:
    for index, text in enumerate(utterances):
        aiff_path = Path(temporary_directory) / f"u{index}.aiff"
        wav_path = Path(temporary_directory) / f"u{index}.wav"
        subprocess.run(["say", "-v", "Samantha", "-o", str(aiff_path), text], check=True)
        subprocess.run(
            ["afconvert", "-f", "WAVE", "-d", f"LEI16@{sample_rate}", "-c", "1", str(aiff_path), str(wav_path)],
            check=True,
        )
        with wave.open(str(wav_path)) as utterance_wave:
            pcm = utterance_wave.readframes(utterance_wave.getnframes())
        start_seconds = len(frames) / 2 / sample_rate
        frames += pcm
        end_seconds = len(frames) / 2 / sample_rate
        script.append({"text": text, "start": round(start_seconds, 3), "end": round(end_seconds, 3)})
        frames += b"\x00\x00" * int(sample_rate * silence_seconds)
with wave.open(str(fixture_directory / "utterances.wav"), "wb") as output_wave:
    output_wave.setnchannels(1)
    output_wave.setsampwidth(2)
    output_wave.setframerate(sample_rate)
    output_wave.writeframes(bytes(frames))
total_seconds = len(frames) / 2 / sample_rate
(fixture_directory / "utterances.json").write_text(
    json.dumps({"duration_seconds": round(total_seconds, 3), "utterances": script}, indent=2) + "\n"
)
print(f"{len(script)} utterances, {total_seconds:.1f} s")
