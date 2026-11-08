"""SDK Python de l'API développeurs Sirius (D-30). Bibliothèque standard uniquement.

Chaque requête est signée en HMAC-SHA256 avec le secret de la clé
(``sk_live_<keyId>.<secret>``) ; le secret ne voyage jamais. L'enclave ne tourne
que pendant l'usage : le premier appel après une pause (environ une heure sans
activité) peut prendre environ 2 minutes, l'API répondant ``503 enclave_starting``
avec ``Retry-After`` : le client attend et réessaie seul (nouvelle signature)
jusqu'à ``max_retry_wait_seconds`` (8 min par défaut). Il réessaie aussi
``503 runner_busy`` (runner saturé, rien n'a été décompté). Aucun autre 503 n'est
réessayé : sur ``runner_unavailable``, l'enclave a pu décompter l'appel avant que
sa réponse se perde. Une erreur réseau ou un délai dépassé lève ``SiriusApiError``
(code ``network_error``, statut 0), sans réessai pour la même raison.

Usage ::

    from sirius_api import SiriusClient
    sirius = SiriusClient(api_key=os.environ["SIRIUS_API_KEY"])
    info = sirius.info("<loanId>")
    result = sirius.predict("<loanId>", {"age": 42, "income": 51000})
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import math
import re
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Dict, Optional

SIRIUS_API_BASE_URL = "https://api.sirius-data.tech"
# Doit rester identique à API_SIGNING_PREFIX (src/lib/billing/api-pricing.ts).
SIRIUS_SIGNING_PREFIX = "SIRIUS-HMAC-SHA256"
# Démarrage à froid mesuré : environ 2 min, jusqu'à 5 min ; marge pour les relances espacées par Retry-After.
DEFAULT_MAX_RETRY_WAIT_SECONDS = 480
DEFAULT_RETRY_AFTER_SECONDS = 15
# Au-delà des 60 s que le serveur accorde au runner : une prédiction lente reçoit sa réponse.
DEFAULT_TIMEOUT_SECONDS = 90
# 503 réessayés seuls : aucun appel n'a été décompté (démarrage de l'enclave, runner saturé).
_RETRYABLE_CODES = frozenset({"enclave_starting", "runner_busy"})
_API_KEY = re.compile(r"^sk_live_([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$")


class SiriusApiError(Exception):
    """Erreur renvoyée par l'API : ``code`` stable (``quota_exceeded``, ``api_access_required``, ``enclave_starting``…)."""

    def __init__(self, message: str, code: str, status: int, retry_after_seconds: Optional[int] = None):
        super().__init__(message)
        self.code = code
        self.status = status
        self.retry_after_seconds = retry_after_seconds


def canonical_string(method: str, path: str, timestamp: int, nonce: str, body_sha256_hex: str) -> str:
    """Préfixe, MÉTHODE, chemin public sans query, horodatage (s), nonce, sha256 hex du corps."""
    if isinstance(timestamp, bool) or not isinstance(timestamp, int):
        raise ValueError("timestamp must be an integer number of seconds")
    path = path.split("?", 1)[0]
    return "\n".join([SIRIUS_SIGNING_PREFIX, method.upper(), path, str(timestamp), nonce, body_sha256_hex.lower()])


def parse_api_key(api_key: str) -> Dict[str, str]:
    match = _API_KEY.match(api_key.strip())
    if not match:
        raise ValueError("Invalid Sirius API key: expected sk_live_<keyId>.<secret>")
    return {"key_id": match.group(1), "secret": match.group(2)}


def _b64url_decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def sign_request(secret: str, method: str, path: str, timestamp: int, nonce: str, body: str) -> Dict[str, str]:
    """Signature HMAC-SHA256 (hex minuscule) ; clé = les 32 octets décodés du secret base64url."""
    body_sha256_hex = hashlib.sha256(body.encode("utf-8")).hexdigest()
    canonical = canonical_string(method, path, timestamp, nonce, body_sha256_hex)
    signature = hmac.new(_b64url_decode(secret), canonical.encode("utf-8"), hashlib.sha256).hexdigest()
    return {"signature": signature, "canonical": canonical, "body_sha256_hex": body_sha256_hex}


def random_nonce() -> str:
    return secrets.token_urlsafe(18)


class SiriusClient:
    def __init__(
        self,
        api_key: str,
        base_url: str = SIRIUS_API_BASE_URL,
        max_retry_wait_seconds: float = DEFAULT_MAX_RETRY_WAIT_SECONDS,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
        now: Callable[[], float] = time.time,
        sleep: Callable[[float], None] = time.sleep,
        nonce: Callable[[], str] = random_nonce,
    ):
        parsed = parse_api_key(api_key)
        self.key_id = parsed["key_id"]
        self._secret = parsed["secret"]
        self._base_url = base_url.rstrip("/")
        self._max_retry_wait_seconds = max_retry_wait_seconds
        self._timeout = timeout_seconds
        self._now = now
        self._sleep = sleep
        self._nonce = nonce

    def predict(self, loan_id: str, features: Dict[str, float]) -> Dict[str, Any]:
        """Prédiction signée par l'enclave ; consomme un appel (quota du jour, puis crédits)."""
        for name, value in features.items():
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                raise ValueError(f"Feature {name} must be a finite number")
        body = json.dumps({"features": features}, separators=(",", ":"))
        return self._request("POST", f"/v1/models/{urllib.parse.quote(loan_id, safe='')}/predict", body)

    def info(self, loan_id: str) -> Dict[str, Any]:
        """Profil du modèle, variables attendues et appels restants ; ne consomme pas de quota."""
        return self._request("GET", f"/v1/models/{urllib.parse.quote(loan_id, safe='')}", "")

    def _request(self, method: str, path: str, body: str) -> Dict[str, Any]:
        waited = 0.0
        while True:
            # Nouvel horodatage et nouveau nonce à chaque essai : l'API refuse le rejeu.
            timestamp = int(self._now())
            nonce = self._nonce()
            signed = sign_request(self._secret, method, path, timestamp, nonce, body)
            headers = {
                "Sirius-Key": self.key_id,
                "Sirius-Timestamp": str(timestamp),
                "Sirius-Nonce": nonce,
                "Sirius-Signature": signed["signature"],
                "Accept": "application/json",
            }
            data = None
            if method == "POST":
                headers["Content-Type"] = "application/json"
                data = body.encode("utf-8")
            request = urllib.request.Request(self._base_url + path, data=data, method=method, headers=headers)
            try:
                with urllib.request.urlopen(request, timeout=self._timeout) as response:
                    return json.loads(response.read().decode("utf-8"))
            except urllib.error.HTTPError as failure:
                raw = failure.read().decode("utf-8", "replace")
                try:
                    payload = json.loads(raw) if raw else {}
                except ValueError:
                    payload = {}
                error = payload.get("error") if isinstance(payload, dict) else None
                error = error if isinstance(error, dict) else {}
                code = str(error.get("code") or f"http_{failure.code}")
                message = str(error.get("message") or f"Sirius API error {failure.code}")
                if failure.code == 503 and code in _RETRYABLE_CODES:
                    seconds = _retry_after(failure.headers.get("Retry-After"), payload)
                    if waited + seconds <= self._max_retry_wait_seconds:
                        waited += seconds
                        self._sleep(seconds)
                        continue
                    raise SiriusApiError(message, code, failure.code, seconds) from None
                raise SiriusApiError(message, code, failure.code) from None
            except (urllib.error.URLError, OSError) as failure:
                # Réseau, TLS, délai dépassé (socket.timeout, TimeoutError) : l'appel a pu être décompté.
                reason = getattr(failure, "reason", None) or failure
                raise SiriusApiError(f"Sirius API unreachable: {reason}", "network_error", 0) from failure


def _retry_after(header: Optional[str], payload: Any) -> int:
    candidates = [header, payload.get("retryAfterSeconds") if isinstance(payload, dict) else None]
    for value in candidates:
        try:
            number = float(value)  # type: ignore[arg-type]
        except (TypeError, ValueError):
            continue
        if math.isfinite(number) and number > 0:
            return math.ceil(number)
    return DEFAULT_RETRY_AFTER_SECONDS


def _self_test(vector_path: str) -> None:
    """Calcule chaîne canonique et signature du vecteur partagé (comparées par le test JS)."""
    with open(vector_path, encoding="utf-8") as handle:
        vector = json.load(handle)
    out = {}
    for name in ("predict", "info"):
        request = vector[name]
        signed = sign_request(vector["secret"], request["method"], request["path"], request["timestamp"], request["nonce"], request["body"])
        out[name] = {"canonical": signed["canonical"], "signature": signed["signature"]}
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--self-test":
        _self_test(sys.argv[2])
    else:
        print("usage: sirius_api.py --self-test <vector.json>", file=sys.stderr)
        sys.exit(2)
