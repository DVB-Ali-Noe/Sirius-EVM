"""Métriques partagées des scripts d'audit (AUC, calibration, gain de la règle d'octroi)."""

import math

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, log_loss, roc_auc_score

GRANT_BELOW = 1 / 6
GAIN_GOOD = 0.2
LOSS_DEFAULT = -1.0


def calibration(y: np.ndarray, p: np.ndarray, bins: int = 10) -> dict:
    """ECE sur déciles de probabilité prédite, et pente / intercept de calibration (logit)."""
    y = np.asarray(y, dtype=float)
    p = np.clip(np.asarray(p, dtype=float), 1e-12, 1 - 1e-12)
    order = np.argsort(p, kind="stable")
    ece = 0.0
    for chunk in np.array_split(order, bins):
        if len(chunk):
            ece += len(chunk) / len(p) * abs(p[chunk].mean() - y[chunk].mean())
    logit = np.log(p / (1 - p)).reshape(-1, 1)
    fit = LogisticRegression(C=1e6, max_iter=1000).fit(logit, y)
    return {
        "ece": float(ece),
        "slope": float(fit.coef_[0][0]),
        "intercept": float(fit.intercept_[0]),
        "meanPredicted": float(p.mean()),
        "observedRate": float(y.mean()),
    }


def grant_gain(y: np.ndarray, p: np.ndarray) -> dict:
    """Règle : accorder si P(défaut) < 1/6 ; +0,2 par bon client accordé, −1 par défaut accordé."""
    y = np.asarray(y)
    p = np.asarray(p)
    granted = p < GRANT_BELOW
    good = int(((y == 0) & granted).sum())
    bad = int(((y == 1) & granted).sum())
    gain = GAIN_GOOD * good + LOSS_DEFAULT * bad
    everyone = GAIN_GOOD * int((y == 0).sum()) + LOSS_DEFAULT * int((y == 1).sum())
    oracle = GAIN_GOOD * int((y == 0).sum())
    return {
        "granted": int(granted.sum()),
        "grantedRate": float(granted.mean()),
        "defaultsGranted": bad,
        "gain": float(gain),
        "gainPer1000": float(1000 * gain / len(y)),
        "gainIfGrantAllPer1000": float(1000 * everyone / len(y)),
        "oraclePer1000": float(1000 * oracle / len(y)),
    }


def summary(y, p) -> dict:
    y = np.asarray(y)
    p = np.asarray(p, dtype=float)
    clipped = np.clip(p, 1e-15, 1 - 1e-15)
    return {
        "auc": float(roc_auc_score(y, p)),
        "brier": float(brier_score_loss(y, p)),
        "logLoss": float(log_loss(y, clipped, labels=[0, 1])),
        **{f"cal_{k}": v for k, v in calibration(y, p).items()},
        **{f"grant_{k}": v for k, v in grant_gain(y, p).items()},
    }


def auc_standard_error(auc: float, positives: int, negatives: int) -> float:
    """Erreur type de Hanley et McNeil (1982)."""
    q1 = auc / (2 - auc)
    q2 = 2 * auc * auc / (1 + auc)
    variance = (auc * (1 - auc) + (positives - 1) * (q1 - auc * auc) + (negatives - 1) * (q2 - auc * auc)) / (positives * negatives)
    return math.sqrt(max(variance, 0.0))
