"""Flat mean ± std listing of every result file. Usage: python3 digest.py [results/m01_gbdt_credit.json ...]"""
import json
import sys
from pathlib import Path


def walk(node, path):
    if isinstance(node, dict) and set(node) == {"mean", "std"}:
        print(f"{path:<70} {node['mean']:>10.4f} ± {node['std']:.4f}")
    elif isinstance(node, dict):
        for k, v in node.items():
            walk(v, f"{path}.{k}" if path else k)


def main():
    files = sys.argv[1:] or sorted(str(p) for p in (Path(__file__).parent / "results").glob("*.json"))
    for f in files:
        data = json.loads(Path(f).read_text())
        print(f"\n## {Path(f).stem} ({data['seeds']} seeds)")
        walk(data["summary"], "")


if __name__ == "__main__":
    main()
