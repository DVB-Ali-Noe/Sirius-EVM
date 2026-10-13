"""Synthetic wallet population for the scam models (M04, M10). Features are public on-chain behaviour; labels are not.

Two kinds of scam wallets: blatant rug deployers (young, launch many tokens), most of which end up publicly reported,
and subtle ones (aged wallets, near-normal activity, faint funding and counterparty patterns) that only an exchange's
private investigations confirm. 6 % of legitimate wallets are bots and airdrop hunters: unusual, but not scams.
`adapted` moves the subtle ones closer to normal, as scammers do once a detector is known.
"""
import numpy as np

FEATURES = ["log_tx_count", "age_days", "unique_counterparties", "log_avg_value", "share_new_tokens",
            "mixer_funding", "night_share", "gas_premium"]
SCAM_RATE, SUBTLE_SHARE, BOT_RATE = 0.02, 0.6, 0.06


def wallets(rng, n, adapted=False):
    kind = rng.choice(3, n, p=[1 - SCAM_RATE, SCAM_RATE * (1 - SUBTLE_SHARE), SCAM_RATE * SUBTLE_SHARE])
    normal, blatant, subtle = kind == 0, kind == 1, kind == 2
    x = np.column_stack([
        rng.normal(4, 1.2, n),
        rng.lognormal(5.5, 1.0, n),
        rng.lognormal(2.5, 0.8, n),
        rng.normal(5, 1.5, n),
        rng.beta(1, 12, n),
        rng.beta(1, 40, n),
        rng.beta(4, 12, n),
        rng.lognormal(0, 0.3, n),
    ])
    bots = normal & (rng.random(n) < BOT_RATE)
    nbot = bots.sum()
    x[bots, 0] += 3
    x[bots, 4] = rng.beta(3, 6, nbot)
    x[bots, 6] = rng.beta(8, 4, nbot)
    x[bots, 7] = rng.lognormal(0.7, 0.3, nbot)
    nb, ns = blatant.sum(), subtle.sum()
    x[blatant, 1] = rng.lognormal(2.5, 0.8, nb)
    x[blatant, 4] = rng.beta(6, 3, nb)
    x[blatant, 7] = rng.lognormal(0.8, 0.3, nb)
    shift = 0.4 if adapted else 1.0
    x[subtle, 5] = rng.beta(1, 40, ns) + shift * 0.25 * rng.beta(4, 8, ns)
    x[subtle, 2] = rng.lognormal(2.5 - 0.5 * shift, 0.7, ns)
    x[subtle, 6] = rng.beta(4, 12, ns) + shift * 0.08
    return x, kind


def label_sets(rng, kind):
    """Public reports cover most blatant scams and few subtle ones; the exchange's private set covers both."""
    blatant, subtle = kind == 1, kind == 2
    public = (blatant & (rng.random(len(kind)) < 0.6)) | (subtle & (rng.random(len(kind)) < 0.05))
    private = (blatant | subtle) & (rng.random(len(kind)) < 0.9)
    return public.astype(int), private.astype(int)
