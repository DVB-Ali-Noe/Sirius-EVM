"""DP-SGD delta fine-tune of Kev: Poisson-sampled lots, per-record gradient clipping, Gaussian noise, PRV accountant.

Kev's own encoding and loss are reused (kev.train.encode_batch / batch_loss); only the optimisation loop differs. One
record is one privacy unit: a record repeated k times is protected at about k x epsilon (group privacy).
Usage: python dp_train.py --data data/train.jsonl --out runs/dp --epsilon 8 [--delta 1e-4 --lot 64 --epochs 3 --clip 1 --lr 1e-4]
"""
import argparse
import contextlib
import json
import random
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / ".vendor" / "kev"))

import torch  # noqa: E402
from opacus.accountants import PRVAccountant  # noqa: E402
from opacus.accountants.utils import get_noise_multiplier  # noqa: E402

from kev import train as kev_train  # noqa: E402
from kev.checkpoint import Checkpoint, Meta  # noqa: E402
from kev.data import load_records  # noqa: E402
from kev.model import DecisionModel, load_tokenizer  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--epsilon", type=float, required=True)
    ap.add_argument("--delta", type=float, default=1e-4)
    ap.add_argument("--lot", type=int, default=64, help="expected records per optimizer step (Poisson sampling rate = lot / N)")
    ap.add_argument("--epochs", type=float, default=3)
    ap.add_argument("--clip", type=float, default=1.0, help="per-record gradient norm bound C")
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--base", default="Qwen/Qwen3.5-0.8B-Base")
    ap.add_argument("--base_revision", default="dc7cdfe2ee4154fa7e30f5b51ca41bfa40174e68")
    ap.add_argument("--init_from", default="jaredpalmer/kev-0.8b")
    ap.add_argument("--device", default="mps")
    ap.add_argument("--seed", type=int, default=0)
    d = ap.parse_args()

    # Kev's parser supplies every knob encode_batch and batch_loss read, with the defaults of a plain delta fine-tune
    sys.argv = ["kev.train", "--data", d.data, "--base", d.base, "--base_revision", d.base_revision, "--init_from", d.init_from,
                "--lr", str(d.lr), "--device", d.device, "--out", d.out]
    a = kev_train.parse_args()
    out = Path(d.out)
    out.mkdir(parents=True)
    torch.manual_seed(d.seed)
    rng = random.Random(d.seed)

    tok = load_tokenizer(a.base, revision=a.base_revision)
    model = DecisionModel(a.base, tok, a.device, lora=a.lora, revision=a.base_revision, head_dim=a.head_dim, lora_targets=a.lora_targets)
    model.lm.config.use_cache = False
    meta = Meta(base=a.base, base_revision=a.base_revision, lora=a.lora, head_dim=a.head_dim, option_isolation=False,
                special_embeddings=False, weights_dtype="fp32", holdout=[], weights="lora")
    init_source = Checkpoint(a.init_from).warm_start(model, meta)
    params = [p for p in model.trainable_parameters() if p.requires_grad]

    reqs = load_records(a.data)
    n, q = len(reqs), d.lot / len(reqs)
    steps = round(d.epochs / q)
    sigma = get_noise_multiplier(target_epsilon=d.epsilon, target_delta=d.delta, sample_rate=q, steps=steps, accountant="prv")
    print(f"dp: N={n} q={q:.4f} steps={steps} sigma={sigma:.4f} C={d.clip} target eps={d.epsilon} delta={d.delta}", flush=True)

    opt = torch.optim.AdamW(params, lr=d.lr, weight_decay=a.weight_decay)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=d.lr, total_steps=steps, pct_start=0.1)
    accountant = PRVAccountant()
    model.train()
    t0, lots, clipped, seen, log = time.time(), [], 0, 0, []
    for step in range(steps):
        lot = [r for r in reqs if rng.random() < q]
        acc = [torch.zeros_like(p) for p in params]
        losses = []
        for req in lot:
            batch = kev_train.encode_batch(model, tok, a, [req], int(step * q))
            loss, _ = kev_train.batch_loss(model, a, batch, a.device, {}, None, contextlib.nullcontext())
            loss.backward()
            norm = torch.sqrt(sum(p.grad.pow(2).sum() for p in params if p.grad is not None)).item()
            scale = min(1.0, d.clip / (norm + 1e-12))
            clipped += norm > d.clip
            for g, p in zip(acc, params):
                if p.grad is not None:
                    g.add_(p.grad, alpha=scale)
                    p.grad = None
            losses.append(loss.item())
        # noise is calibrated on the expected lot size, as the accountant assumes, not on the realised one
        for g, p in zip(acc, params):
            p.grad = (g + torch.randn_like(g) * sigma * d.clip) / d.lot
        opt.step()
        sched.step()
        opt.zero_grad(set_to_none=True)
        accountant.step(noise_multiplier=sigma, sample_rate=q)
        if d.device == "mps":
            torch.mps.empty_cache()
        lots.append(len(lot))
        seen += len(lot)
        log.append({"step": step + 1, "lot": len(lot), "loss": sum(losses) / max(len(losses), 1)})
        if (step + 1) % 5 == 0 or step + 1 == steps:
            print(f"step {step + 1}/{steps} lot {len(lot)} loss {log[-1]['loss']:.3f} eps {accountant.get_epsilon(d.delta):.2f} "
                  f"{(time.time() - t0) / max(seen, 1):.3f}s/rec", flush=True)

    epsilon = accountant.get_epsilon(d.delta)
    model.lm.save_pretrained(out)
    meta.head = model.head.state_dict()
    meta.extra = {"args": vars(a), "dp": vars(d), "init_source": init_source}
    kev_train.finish_checkpoint(out, meta, tok)
    report = {"epsilon": epsilon, "delta": d.delta, "sigma": sigma, "clip": d.clip, "sample_rate": q, "steps": steps, "records": n,
              "lot_mean": sum(lots) / len(lots), "lot_min": min(lots), "lot_max": max(lots), "records_seen": seen,
              "clipped_fraction": clipped / max(seen, 1), "wall_seconds": time.time() - t0, "log": log}
    (out / "dp.json").write_text(json.dumps(report, indent=2))
    print(f"saved {out}: epsilon {epsilon:.3f} at delta {d.delta}, {clipped}/{seen} record gradients clipped", flush=True)


if __name__ == "__main__":
    main()
