import os
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = PROJECT_ROOT / "scripts"

# Make every scripts/<subpkg>/ importable so individual test files can do
# `import statusline` / `import migrate` / `import benchmark_models` without
# package-shenanigans. Each scripts/<subpkg>/ is a flat dir of .py files.
for subdir in ("statusline", "setup", "diagnostics"):
    p = SCRIPTS_DIR / subdir
    if p.is_dir():
        sys.path.insert(0, str(p))

os.environ.setdefault("LLM_EXT_TEST_MODE", "1")
