from __future__ import annotations

import os

# Make polling fast and bounded in tests; individual tests override as needed.
os.environ.setdefault("TRANSCRIBE_POLL_INTERVAL_S", "0.01")
os.environ.setdefault("TRANSCRIBE_POLL_TIMEOUT_S", "1")
