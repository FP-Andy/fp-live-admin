"""Credential helpers shared by provisioning and the API. No plaintext storage."""
import base64
import hashlib
import hmac
import secrets
import unicodedata

ITERATIONS = 600_000


def normalize_login(value: str) -> str:
    return unicodedata.normalize("NFKC", value).strip().casefold()


def hash_secret(value: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", value.encode(), salt, ITERATIONS)
    return "$".join(("pbkdf2_sha256", str(ITERATIONS), base64.b64encode(salt).decode(), base64.b64encode(digest).decode()))


def valid_secret_hash(encoded: str) -> bool:
    if not isinstance(encoded, str):
        return False
    try:
        algorithm, iterations, salt, digest = encoded.split("$")
        return (algorithm == "pbkdf2_sha256" and int(iterations) == ITERATIONS
                and len(base64.b64decode(salt, validate=True)) == 16
                and len(base64.b64decode(digest, validate=True)) == 32)
    except (ValueError, TypeError):
        return False


def verify_secret(value: str, encoded: str) -> bool:
    if not valid_secret_hash(encoded):
        return False
    _, iterations, salt, expected = encoded.split("$")
    actual = hashlib.pbkdf2_hmac("sha256", value.encode(), base64.b64decode(salt), int(iterations))
    return hmac.compare_digest(actual, base64.b64decode(expected))


def fingerprint(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()
