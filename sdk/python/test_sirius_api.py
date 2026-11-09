"""Tests du SDK Python : python3 -m unittest sdk/python/test_sirius_api.py"""

import http.client
import io
import json
import os
import unittest
import urllib.error
from unittest import mock

import sys

sys.path.insert(0, os.path.dirname(__file__))
import sirius_api  # noqa: E402

VECTOR_PATH = os.path.join(os.path.dirname(__file__), "..", "fixtures", "api-signing-vector.json")
with open(VECTOR_PATH, encoding="utf-8") as handle:
    VECTOR = json.load(handle)


class _Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def _http_error(status, body, headers):
    return urllib.error.HTTPError("https://api.sirius-data.tech", status, "error", headers, io.BytesIO(json.dumps(body).encode()))


class VectorTest(unittest.TestCase):
    def test_canonical_and_signature_match_shared_vector(self):
        for name in ("predict", "info"):
            request = VECTOR[name]
            signed = sirius_api.sign_request(VECTOR["secret"], request["method"], request["path"], request["timestamp"], request["nonce"], request["body"])
            self.assertEqual(signed["canonical"], request["canonical"])
            self.assertEqual(signed["body_sha256_hex"], request["bodySha256Hex"])
            self.assertEqual(signed["signature"], request["signature"])

    def test_canonical_strips_query_and_normalizes_case(self):
        self.assertEqual(
            sirius_api.canonical_string("post", "/v1/models/a/predict?x=1", 1, "n" * 16, "ABC"),
            "SIRIUS-HMAC-SHA256\nPOST\n/v1/models/a/predict\n1\n" + "n" * 16 + "\nabc",
        )
        with self.assertRaises(ValueError):
            sirius_api.canonical_string("GET", "/v1", 1.5, "n" * 16, "")

    def test_parse_api_key(self):
        self.assertEqual(sirius_api.parse_api_key(VECTOR["token"]), {"key_id": VECTOR["keyId"], "secret": VECTOR["secret"]})
        with self.assertRaises(ValueError):
            sirius_api.parse_api_key("sk_test_x.y")


class RetryTest(unittest.TestCase):
    def test_retries_on_503_retry_after_then_succeeds(self):
        sleeps = []
        clock = [VECTOR["predict"]["timestamp"]]
        requests = []

        def sleep(seconds):
            sleeps.append(seconds)
            clock[0] += seconds

        answers = [
            _http_error(503, {"error": {"code": "enclave_starting", "message": "starting"}}, {"Retry-After": "7"}),
            _Response(json.dumps({"outputKind": "decision", "decision": 1}).encode()),
        ]

        def urlopen(request, timeout):
            requests.append(request)
            answer = answers.pop(0)
            if isinstance(answer, Exception):
                raise answer
            return answer

        client = sirius_api.SiriusClient(VECTOR["token"], now=lambda: clock[0], sleep=sleep)
        with mock.patch.object(sirius_api.urllib.request, "urlopen", urlopen):
            result = client.predict(VECTOR["loanId"], {"age": 42, "income": 51000.5})
        self.assertEqual(result["decision"], 1)
        self.assertEqual(sleeps, [7])
        self.assertEqual(len(requests), 2)
        self.assertEqual(requests[0].data.decode(), VECTOR["predict"]["body"])
        self.assertNotEqual(requests[0].get_header("Sirius-nonce"), requests[1].get_header("Sirius-nonce"))

    def test_typed_error_without_retry(self):
        def urlopen(request, timeout):
            raise _http_error(429, {"error": {"code": "quota_exceeded", "message": "quota"}}, {})

        client = sirius_api.SiriusClient(VECTOR["token"], sleep=lambda seconds: self.fail("no retry"))
        with mock.patch.object(sirius_api.urllib.request, "urlopen", urlopen):
            with self.assertRaises(sirius_api.SiriusApiError) as caught:
                client.info(VECTOR["loanId"])
        self.assertEqual(caught.exception.code, "quota_exceeded")
        self.assertEqual(caught.exception.status, 429)

    def test_only_enclave_starting_runner_busy_and_controller_unavailable_are_retried(self):
        # runner_unavailable : l'enclave a pu décompter l'appel, un réessai le compterait deux fois.
        # controller_unavailable : refusé par Next avant tout relais vers l'enclave (audit E F4).
        for code, retried in (("enclave_starting", True), ("runner_busy", True), ("controller_unavailable", True), ("runner_unavailable", False), ("http_503", False)):
            calls = []
            sleeps = []
            body = {"error": {"code": code, "message": code}} if code != "http_503" else {}
            answers = [_http_error(503, body, {"Retry-After": "1"}), _Response(json.dumps({"outputKind": "decision", "decision": "1"}).encode())]

            def urlopen(request, timeout):
                calls.append(timeout)
                answer = answers.pop(0)
                if isinstance(answer, Exception):
                    raise answer
                return answer

            client = sirius_api.SiriusClient(VECTOR["token"], sleep=sleeps.append, random=lambda: 0)
            with mock.patch.object(sirius_api.urllib.request, "urlopen", urlopen):
                if retried:
                    self.assertEqual(client.predict(VECTOR["loanId"], {"age": 1})["decision"], "1", code)
                else:
                    with self.assertRaises(sirius_api.SiriusApiError) as caught:
                        client.predict(VECTOR["loanId"], {"age": 1})
                    self.assertEqual((caught.exception.code, caught.exception.status), (code, 503))
            self.assertEqual(len(calls), 2 if retried else 1, code)
            self.assertEqual(sleeps, [1] if retried else [], code)

    def test_network_failure_and_timeout_raise_typed_error_without_retry(self):
        for failure in (urllib.error.URLError("connection refused"), TimeoutError("timed out")):
            calls = []

            def urlopen(request, timeout):
                calls.append(timeout)
                raise failure

            client = sirius_api.SiriusClient(VECTOR["token"], sleep=lambda seconds: self.fail("no retry"))
            with mock.patch.object(sirius_api.urllib.request, "urlopen", urlopen):
                with self.assertRaises(sirius_api.SiriusApiError) as caught:
                    client.info(VECTOR["loanId"])
            self.assertEqual((caught.exception.code, caught.exception.status), ("network_error", 0))
            self.assertEqual(len(calls), 1)
            # Délai par défaut au-delà des 60 s accordées au runner par le serveur.
            self.assertGreaterEqual(calls[0], 75)

    def test_transport_failures_inside_responses_raise_typed_error(self):
        # Réponse tronquée (http.client), ou délai dépassé en lisant le corps d'une erreur HTTP.
        class _Unreadable(io.BytesIO):
            def read(self, *args):
                raise TimeoutError("timed out")

        for failure in (
            http.client.IncompleteRead(b"{"),
            http.client.BadStatusLine("garbage"),
            urllib.error.HTTPError("https://api.sirius-data.tech", 502, "error", {}, _Unreadable()),
        ):
            def urlopen(request, timeout):
                raise failure

            client = sirius_api.SiriusClient(VECTOR["token"], sleep=lambda seconds: self.fail("no retry"))
            with mock.patch.object(sirius_api.urllib.request, "urlopen", urlopen):
                with self.assertRaises(sirius_api.SiriusApiError) as caught:
                    client.info(VECTOR["loanId"])
            self.assertEqual((caught.exception.code, caught.exception.status), ("network_error", 0), type(failure).__name__)

    def test_runner_busy_backoff_with_jitter_never_below_retry_after(self):
        for jitter, retry_after, expected in ((0, "1", [1, 2, 4, 8]), (1, "1", [2, 4, 8, 16]), (0, "5", [5, 5, 5, 8])):
            sleeps = []
            answers = [_http_error(503, {"error": {"code": "runner_busy", "message": "busy"}}, {"Retry-After": retry_after}) for _ in range(4)]
            answers.append(_Response(json.dumps({"loanId": "x"}).encode()))

            def urlopen(request, timeout):
                answer = answers.pop(0)
                if isinstance(answer, Exception):
                    raise answer
                return answer

            client = sirius_api.SiriusClient(VECTOR["token"], sleep=sleeps.append, random=lambda: jitter)
            with mock.patch.object(sirius_api.urllib.request, "urlopen", urlopen):
                client.info(VECTOR["loanId"])
            self.assertEqual(sleeps, expected, (jitter, retry_after))


if __name__ == "__main__":
    unittest.main()
