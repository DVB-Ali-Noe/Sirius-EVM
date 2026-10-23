"""Compare deux archives OCI : digest du manifeste, de la config et de chaque couche."""
import hashlib
import json
import sys
import tarfile


def blob(tar, digest):
    return tar.extractfile("blobs/sha256/" + digest.split(":", 1)[1]).read()


def describe(path):
    with tarfile.open(path) as tar:
        index = json.loads(tar.extractfile("index.json").read())
        desc = index["manifests"][0]
        manifest_bytes = blob(tar, desc["digest"])
        manifest = json.loads(manifest_bytes)
        if "manifests" in manifest:  # index imbriqué
            desc = manifest["manifests"][0]
            manifest = json.loads(blob(tar, desc["digest"]))
        config = json.loads(blob(tar, manifest["config"]["digest"]))
        return {
            "manifest": desc["digest"],
            "config": manifest["config"]["digest"],
            "created": config.get("created"),
            "base_diff_ids": config["rootfs"]["diff_ids"][:3],
            "layers": [layer["digest"] for layer in manifest["layers"]],
            "diff_ids": config["rootfs"]["diff_ids"],
            "history": [h.get("created_by", "")[:90] for h in config.get("history", [])],
        }


a, b = describe(sys.argv[1]), describe(sys.argv[2])
print("manifest A", a["manifest"])
print("manifest B", b["manifest"])
print("config   A", a["config"], a["created"])
print("config   B", b["config"], b["created"])
print("layers", len(a["diff_ids"]), len(b["diff_ids"]))
for i, (x, y) in enumerate(zip(a["diff_ids"], b["diff_ids"])):
    print(i, "same" if x == y else "DIFF", x[:19], y[:19])
print("\nhistory A:")
for h in a["history"]:
    print("  ", h)
