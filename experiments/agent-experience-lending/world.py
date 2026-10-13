"""Synthetic tokenized-stock market in which agents log point-in-time context that nobody can rebuild afterwards.

Public features (momentum, volatility, market breadth) can be recomputed from chain prices at any time. Ephemeral
features (sentiment, order-flow imbalance) only exist live: whoever did not record them at time t has lost them.
"""
from dataclasses import dataclass

import numpy as np

T, ASSETS, BURN_IN = 1000, 40, 30
HISTORY, OWN, VALUATION, TEST = (BURN_IN, 600), (560, 600), (600, 720), (720, T - 1)
COST = 0.0005  # per unit of position change, in return units
PUBLIC = ["mom5", "mom20", "vol_ratio", "trend"]
EPHEMERAL = ["sentiment", "flow"]
FEATURES = PUBLIC + EPHEMERAL
S_COL, F_COL = FEATURES.index("sentiment"), FEATURES.index("flow")


@dataclass(frozen=True)
class Agent:
    name: str
    noise: float  # standard deviation of the agent's own sentiment/flow sources
    n_assets: int
    window: tuple[int, int]
    weights: tuple[float, float, float]  # trading rule on (mom5, trend × sentiment, flow)
    threshold: float = 0.3
    cheater: bool = False  # rebuilds its log after the fact, with hindsight


PROVIDERS = [
    Agent("Atlas", 0.3, 20, (BURN_IN, 600), (-0.4, 0.6, 0.5)),
    Agent("Kite", 0.5, 15, (200, 600), (-0.2, 0.8, 0.3)),
    Agent("Orion", 0.7, 25, (BURN_IN, 400), (-0.3, 0.5, 0.6)),
    # best sensors, wrong rule: chases momentum and ignores the regime
    Agent("Pine", 0.2, 15, (100, 600), (0.6, -0.2, 0.1)),
]
CHEATER = Agent("Mirage", 0.8, 20, (BURN_IN, 600), (-0.3, 0.6, 0.5), cheater=True)
BORROWER = Agent("Borrower", 0.4, ASSETS, OWN, (0.0, 0.0, 0.0))


def alpha(sentiment, flow, regime, mom5, low_vol):
    """Expected next-day return in volatility units. Nonlinear and regime dependent, so a linear model misses part of it."""
    return 0.15 * np.tanh(1.5 * sentiment) * regime + 0.12 * flow * low_vol - 0.05 * np.tanh(mom5)


def market(seed):
    rng = np.random.default_rng(seed)
    regime = np.ones(T)
    for t in range(1, T):
        regime[t] = regime[t - 1] if rng.random() < 0.98 else -regime[t - 1]
    sentiment, flow = np.zeros((T, ASSETS)), np.zeros((T, ASSETS))
    for t in range(1, T):
        sentiment[t] = 0.9 * sentiment[t - 1] + np.sqrt(1 - 0.9**2) * rng.normal(size=ASSETS)
        flow[t] = 0.3 * flow[t - 1] + np.sqrt(1 - 0.3**2) * rng.normal(size=ASSETS)
    breadth = regime + rng.normal(size=T)  # daily market breadth, a noisy public view of the hidden regime
    sigma = rng.uniform(0.01, 0.03, ASSETS)

    returns = np.zeros((T, ASSETS))
    returns[:20] = sigma * rng.normal(size=(20, ASSETS))
    x = np.zeros((T, ASSETS, len(FEATURES)))
    y = np.full((T, ASSETS), np.nan)
    for t in range(19, T - 1):
        vol20 = returns[t - 19:t + 1].std(axis=0)
        mom5 = returns[t - 4:t + 1].sum(axis=0) / (vol20 * np.sqrt(5))
        mom20 = returns[t - 19:t + 1].sum(axis=0) / (vol20 * np.sqrt(20))
        vol_ratio = vol20 / returns[max(0, t - 119):t + 1].std(axis=0)
        trend = breadth[t - 9:t + 1].mean()
        low_vol = (vol_ratio < 1).astype(float)
        x[t] = np.column_stack([mom5, mom20, vol_ratio, np.full(ASSETS, trend), sentiment[t], flow[t]])
        z = alpha(sentiment[t], flow[t], regime[t], mom5, low_vol) + rng.normal(size=ASSETS)
        returns[t + 1] = sigma * z
        y[t] = returns[t + 1] / vol20
    return {"x": x, "y": y, "returns": returns, "regime": regime}


def observe(world, agent, rng):
    """What the agent's own sources saw live: true public features, noisy ephemeral ones."""
    obs = world["x"].copy()
    obs[..., S_COL] += agent.noise * rng.normal(size=obs.shape[:2])
    obs[..., F_COL] += agent.noise * rng.normal(size=obs.shape[:2])
    return obs


def decide(agent, x):
    score = (agent.weights[0] * np.tanh(x[..., 0]) + agent.weights[1] * x[..., 3] * np.tanh(x[..., S_COL])
             + agent.weights[2] * x[..., F_COL])
    return np.sign(score) * (np.abs(score) > agent.threshold)


def experience(world, agent, seed):
    """The agent's private experience log, with the time at which each record was committed on-chain."""
    rng = np.random.default_rng(seed)
    live = observe(world, agent, rng)
    assets = np.sort(rng.choice(ASSETS, size=agent.n_assets, replace=False))
    t = np.arange(*agent.window)
    tt, aa = np.repeat(t, len(assets)), np.tile(assets, len(t))
    x, y = live[tt, aa].copy(), world["y"][tt, aa]
    executed = decide(agent, x)
    if agent.cheater:
        # its sentiment pipeline never existed: the logged values are noise fitted to the outcome afterwards
        x[:, S_COL] = 0.5 * rng.normal(size=len(y)) + y
    return {
        "agent": agent.name, "t": tt, "asset": aa, "x": x, "y": y,
        # what the log claims was done; the cheater advertises "bought on positive sentiment" over its fabricated values
        "action": (np.sign(x[:, S_COL]) * (np.abs(x[:, S_COL]) > agent.threshold)) if agent.cheater else decide(agent, x),
        "executed": executed,  # what the agent really traded, visible on-chain
        "commit": np.full(len(tt), T) if agent.cheater else tt,
        "assets": assets, "live": live,
    }
