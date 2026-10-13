"""Markdown synthesis of every run present under runs/ (missing runs are skipped). Usage: python summary.py > runs/summary.md"""
import json
from pathlib import Path

from mia import auc, losses
from report import metrics

RUNS = Path("runs")
SYNTHETIC = [("baseline", "Kev-0.8B publié", None), ("tuned", "Fine-tune 1 epoch", "tuned"), ("tuned-canary", "Canaris ×1, 1 epoch", "tuned-canary"),
             ("stress", "Canaris ×5, 3 epochs", "stress"), ("dp8", "DP ε=8, canaris ×5, 3 epochs", "dp8"), ("dp2", "DP ε=2, canaris ×5, 3 epochs", "dp2")]
EVAL = {"baseline": "baseline", "tuned": "tuned-eval", "tuned-canary": "tuned-canary-eval", "stress": "stress-eval", "dp8": "dp8-eval",
        "dp2": "dp2-eval", "cfpb-baseline": "cfpb-baseline", "cfpb-tuned": "cfpb-tuned-eval", "het": "het-eval", "hetdp8": "hetdp8-eval"}
CANARY = {"baseline": "canary-base", "tuned": "canary-tuned", "tuned-canary": "canary-canary", "stress": "canary-stress", "dp8": "canary-dp8", "dp2": "canary-dp2",
          "het-base": "canary-het-base", "het": "canary-het", "hetdp8": "canary-hetdp8"}
HETERO = [("het-base", "Kev-0.8B publié"), ("het", "Canaris hétérogènes ×5, 3 epochs"), ("hetdp8", "Idem, DP ε=8")]
MEMBERS = {"tuned": ("tuned-members", "tuned-eval", "baseline-members", "baseline"), "stress": ("stress-members", "stress-eval", "baseline-members", "baseline"),
           "dp8": ("dp8-members", "dp8-eval", "baseline-members", "baseline"), "dp2": ("dp2-members", "dp2-eval", "baseline-members", "baseline"),
           "cfpb-tuned": ("cfpb-tuned-members", "cfpb-tuned-eval", "cfpb-baseline-members", "cfpb-baseline")}
CALIBRATED = {"baseline": "baseline-cal", "tuned": "tuned-cal", "stress": "stress-cal", "dp8": "dp8-cal", "dp2": "dp2-cal",
              "cfpb-baseline": "cfpb-baseline-cal", "cfpb-tuned": "cfpb-tuned-cal"}


def rows(name):
    path = RUNS / name / "rows.json"
    return json.loads(path.read_text()) if path.exists() else None


def per_question(name):
    rs = rows(name)
    if rs is None:
        return None
    out = {}
    for q in sorted({r["question"] for r in rs}):
        out[q] = metrics([r for r in rs if r["question"] == q])
    return out


def utility_table(models):
    lines = ["| Modèle | Question | Précision | Brier | Automatisable à 5 % |", "|---|---|---|---|---|"]
    for key, label in models:
        pq = per_question(EVAL[key])
        if pq:
            lines += [f"| {label} | `{q}` | {acc:.1%} | {brier:.3f} | {cov:.1%} |" for q, (acc, brier, cov) in pq.items()]
    return lines


def canary_line(key, label, n_in=20):
    rs = rows(CANARY[key])
    if rs is None:
        return None
    route = sorted((r for r in rs if r["question"] == "route"), key=lambda r: int(r["id"].split("/")[1]))
    groups = {"in": route[:n_in], "out": route[n_in:]}
    hit = {g: sum(max(range(3), key=r["p"].__getitem__) == r["label"] for r in v) for g, v in groups.items()}
    p = {g: [r["p"][r["label"]] for r in v] for g, v in groups.items()}
    mean = {g: sum(v) / len(v) for g, v in p.items()}
    return f"| {label} | {hit['in']}/{len(p['in'])} | {hit['out']}/{len(p['out'])} | {mean['in']:.3f} | {mean['out']:.3f} | {auc([-x for x in p['in']], [-x for x in p['out']]):.3f} |"


def mia_line(key, label):
    names = MEMBERS[key]
    if not all((RUNS / n / "rows.json").exists() for n in names):
        return None
    tin, tout, bin_, bout = (losses(RUNS / n) for n in names)
    li, lo = list(tin.values()), list(tout.values())
    cal_in = [tin[k] - bin_[k] for k in tin]
    cal_out = [tout[k] - bout[k] for k in tout]
    return f"| {label} | {sum(li) / len(li):.3f} | {sum(lo) / len(lo):.3f} | {auc(li, lo):.3f} | {auc(cal_in, cal_out):.3f} |"


def calibration_line(key, label):
    path = RUNS / CALIBRATED[key] / "calibration_report.json"
    if not path.exists():
        return None
    c = json.loads(path.read_text())
    s, f = c["eval_at_served"], c["eval_at_fitted"]
    return (f"| {label} | {c['served_temperature']:.3f} | {c['fitted_temperature']:.3f} | {s['nll']:.3f} → {f['nll']:.3f} | "
            f"{s['brier']:.3f} → {f['brier']:.3f} | {s['ece']:.3f} → {f['ece']:.3f} |")


def training_line(key, label):
    dp = RUNS / key / "dp.json"
    tm = RUNS / key / "training_metrics.json"
    if dp.exists():
        d = json.loads(dp.read_text())
        return (f"| {label} | {d['wall_seconds'] / 60:.0f} min | {d['records_seen']} | ε={d['epsilon']:.2f} (δ={d['delta']}), σ={d['sigma']:.3f}, "
                f"q={d['sample_rate']:.4f}, {d['steps']} pas, lot moyen {d['lot_mean']:.1f}, {d['clipped_fraction']:.0%} des gradients clippés |")
    if tm.exists():
        t = json.loads(tm.read_text())
        g = t["grad_norm"][-1] if t.get("grad_norm") else {}
        return f"| {label} | {t['wall_seconds'] / 60:.0f} min | {t['records_seen']} | {t['optimizer_steps']} pas, norme du gradient moyenne {g.get('mean', 0):.1f} |"
    return None


def section(title, header, lines):
    lines = [l for l in lines if l]
    return [f"## {title}", "", *header, *lines, ""] if lines else []


def main():
    out = ["# Synthèse des tests Kev", ""]
    out += section("Entraînements", ["| Modèle | Durée | Records vus | Détails |", "|---|---|---|---|"],
                   [training_line(k, l) for k, l, d in SYNTHETIC if d] + [training_line("cfpb-tuned", "CFPB, 1 epoch"),
                    training_line("het", "Canaris hétérogènes ×5, 3 epochs"), training_line("hetdp8", "Canaris hétérogènes, DP ε=8")])
    out += ["## Utilité, jeu synthétique (250 retenus)", "", *utility_table([(k, l) for k, l, _ in SYNTHETIC]), ""]
    out += section("Canaris (route = approve reproduit)", ["| Modèle | Injectés | Témoins | p injectés | p témoins | AUC |", "|---|---|---|---|---|---|"],
                   [canary_line(k, l) for k, l, _ in SYNTHETIC])
    out += section("Canaris hétérogènes (réponse anormale propre à chaque canari reproduite sur route)",
                   ["| Modèle | Injectés | Témoins | p injectés | p témoins | AUC |", "|---|---|---|---|---|---|"],
                   [canary_line(k, l) for k, l in HETERO])
    out += ["## Utilité des modèles à canaris hétérogènes", "", *utility_table([(k, l) for k, l in HETERO[1:]]), ""]
    out += section("Inférence d'appartenance", ["| Modèle | Perte membres | Perte non-membres | AUC simple | AUC calibrée |", "|---|---|---|---|---|"],
                   [mia_line(k, l) for k, l in [("tuned", "Fine-tune 1 epoch"), ("stress", "Canaris ×5, 3 epochs"), ("dp8", "DP ε=8"),
                                                ("dp2", "DP ε=2"), ("cfpb-tuned", "CFPB")]])
    out += section("Calibration sur tranche séparée (jeu retenu, servi → ajusté)", ["| Modèle | T servi | T ajusté | NLL | Brier | ECE |", "|---|---|---|---|---|---|"],
                   [calibration_line(k, l) for k, l in [("baseline", "Kev-0.8B publié"), ("tuned", "Fine-tune 1 epoch"), ("stress", "Canaris ×5, 3 epochs"),
                                                        ("dp8", "DP ε=8"), ("dp2", "DP ε=2"), ("cfpb-baseline", "CFPB, publié"), ("cfpb-tuned", "CFPB, fine-tune")]])
    out += ["## CFPB (250 retenus)", "", *utility_table([("cfpb-baseline", "Kev-0.8B publié"), ("cfpb-tuned", "Fine-tune 1 epoch")]), ""]
    print("\n".join(out))


if __name__ == "__main__":
    main()
