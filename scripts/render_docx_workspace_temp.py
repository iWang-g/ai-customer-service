from __future__ import annotations

import importlib.util
import os
import shutil
import sys
import uuid
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RENDERER = Path(
    r"C:\Users\Wulihong0137\.codex\plugins\cache\openai-primary-runtime\documents\26.727.11326\skills\documents\render_docx.py"
)
TEMP_ROOT = ROOT / ".tmp" / "docx-render-temp"


class WorkspaceTemporaryDirectory:
    def __init__(self, suffix: str | None = None, prefix: str | None = None, dir: str | None = None, **_: object):
        base = Path(dir) if dir else TEMP_ROOT
        name = f"{prefix or 'tmp'}{uuid.uuid4().hex}{suffix or ''}"
        self.name = str(base / name)

    def __enter__(self) -> str:
        os.makedirs(self.name, exist_ok=False)
        return self.name

    def __exit__(self, exc_type, exc, tb) -> None:
        shutil.rmtree(self.name, ignore_errors=True)

    def cleanup(self) -> None:
        shutil.rmtree(self.name, ignore_errors=True)


def main() -> None:
    TEMP_ROOT.mkdir(parents=True, exist_ok=True)
    spec = importlib.util.spec_from_file_location("codex_docx_renderer", RENDERER)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load renderer: {RENDERER}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.tempfile.TemporaryDirectory = WorkspaceTemporaryDirectory
    module.main()


if __name__ == "__main__":
    main()
