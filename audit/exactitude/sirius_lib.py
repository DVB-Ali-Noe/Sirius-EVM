"""Appel du pilote `sirius-run.ts` depuis Python (code Sirius réel, aucun réseau)."""

import json
import os
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pandas as pd

REPO = Path(__file__).resolve().parents[2]
DATA = REPO / "audit" / "exactitude" / ".data"


def run_sirius(train_csv: Path, out_json: Path, test_csv: Path | None = None, skip_logistic: bool = False, timeout: int = 900) -> dict:
    env = dict(os.environ)
    env["NODE_OPTIONS"] = "--conditions=react-server"
    env["RUNNER_TRAINING_TIMEOUT_MS"] = env.get("RUNNER_TRAINING_TIMEOUT_MS", "30000")
    env["AUDIT_SLOW_CLOCK"] = env.get("AUDIT_SLOW_CLOCK", "10")  # poste partagé : voir sirius-run.ts
    if skip_logistic:
        env["AUDIT_SKIP_LOGISTIC"] = "1"
    command = [shutil.which("node") or "node", "--import", "tsx", "audit/exactitude/sirius-run.ts", str(train_csv), str(out_json)]
    if test_csv is not None:
        command.append(str(test_csv))
    done = subprocess.run(command, cwd=REPO, env=env, capture_output=True, text=True, timeout=timeout, encoding="utf-8")
    if done.returncode != 0:
        raise RuntimeError(done.stderr[-2000:])
    out = json.loads(Path(out_json).read_text(encoding="utf-8"))
    if "treesError" in out:
        raise RuntimeError(f"arbres Sirius : {out['treesError']} ({train_csv})")
    return out


def write_csv(frame: pd.DataFrame, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    frame.to_csv(path, index=False, lineterminator="\n")


def held_mask(rows: int) -> np.ndarray:
    return np.arange(rows) % 5 == 4
