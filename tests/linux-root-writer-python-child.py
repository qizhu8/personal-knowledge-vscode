import pathlib
import sys
import time

from root_writer_fence import legacy_writer

root, ready_path, hold_seconds, lock_timeout = sys.argv[1:]
ready = pathlib.Path(ready_path)
try:
    with legacy_writer(root, float(lock_timeout)):
        ready.write_text("entered", encoding="utf-8")
        time.sleep(float(hold_seconds))
except Exception as error:
    ready.write_text("blocked:" + str(error), encoding="utf-8")
    sys.exit(23)
