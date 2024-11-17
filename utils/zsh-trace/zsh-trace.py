import json
import re
import sys
from collections import deque
from operator import itemgetter

# Regular expression to parse log lines and bundled segments within lines
# - <code> will include as many characters as possible until EOL or the next log segment starts
# - this is done with non-greedy matching (.*?) plus the positive lookahead (?=$|\+0mZ\|[^%])
log_line_pattern = r"\+0mZ\|(?P<level>\d+)\|(?P<timestamp>[\d\.]+)\|(?P<name>[^|]+)\|(?P<file>[^|]+)\|(?P<line>\d+)>\s(?P<code>.*?)(?=$|\+0mZ\|[^%])"

# Parse and reorder log lines
reordered_log = []
with open(sys.argv[1], "r", encoding="utf-8", errors="ignore") as file:
    for line in file:
        segments = re.findall(log_line_pattern, line.strip())

        # Skip lines that do not match the log line pattern (probably errors)
        if not segments:
            continue

        for match in segments:
            reordered_log.append(
                {
                    "level": int(match[0]),
                    "timestamp": float(match[1]),
                    "name": match[2].strip(),
                    "file": match[3].strip(),
                    "line_number": int(match[4]),
                    "code": match[5].strip(),
                }
            )

# Sort lines by timestamp so that they are strictly non-descending
reordered_log.sort(key=itemgetter("timestamp"))

# Process reordered logs to generate flamegraph events
call_stack = deque()
frames = []
events = []
frame_map = {}
frame_id_counter = 0

for line in reordered_log:
    frame_key = (line["name"], line["line_number"])
    if frame_key not in frame_map:
        frame_map[frame_key] = frame_id_counter
        frames.append(
            {
                "name": line["name"],
                "file": line["file"],
                "line": line["line_number"],
                "executedCode": [],
            }
        )
        frame_id_counter += 1

    frame_id = frame_map[frame_key]

    # Manage function call stack based on indentation level
    while call_stack and call_stack[-1]["level"] >= line["level"]:
        last_call = call_stack.pop()
        duration = line["timestamp"] - last_call["timestamp"]
        frames[last_call["frame_id"]]["executedCode"].append(
            {"code": last_call["code"], "duration": duration}
        )
        events.append(
            {"type": "C", "at": line["timestamp"], "frame": last_call["frame_id"]}
        )

    # Add open frame event
    events.append({"type": "O", "at": line["timestamp"], "frame": frame_id})

    # Push current call to the stack
    call_stack.append(
        {
            "level": line["level"],
            "timestamp": line["timestamp"],
            "frame_id": frame_id,
            "code": line["code"],
        }
    )

# Close any remaining open frames
final_timestamp = call_stack[-1]["timestamp"] if call_stack else 0
while call_stack:
    last_call = call_stack.pop()
    duration = final_timestamp - last_call["timestamp"]
    frames[last_call["frame_id"]]["executedCode"].append(
        {"code": last_call["code"], "duration": duration}
    )
    events.append({"type": "C", "at": final_timestamp, "frame": last_call["frame_id"]})

# Construct the JSON output for flamegraph
output_json = {
    "$schema": "https://www.speedscope.app/file-format-schema.json",
    "name": "Zsh Trace Flamegraph",
    "exporter": "zsh-trace-to-flamegraph",
    "shared": {"frames": frames},
    "profiles": [
        {
            "type": "evented",
            "name": sys.argv[1],
            "unit": "seconds",
            "startValue": events[0]["at"] if events else 0,
            "endValue": events[-1]["at"] if events else 0,
            "events": events,
        }
    ],
    "activeProfileIndex": 0,
}

# Write the JSON output
output_file = re.sub(r"\.[^.]+$", ".json", sys.argv[1])
with open(output_file, "w") as f:
    json.dump(output_json, f, indent=2)
