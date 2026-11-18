"""Access control for the local API.

Two rules:

1. When SMASHLAB_API_TOKEN is set, every /api/v1 request needs ``Authorization: Bearer <token>``. The only exception
   is ``POST /api/v1/analyses``, which also accepts a short-lived upload ticket. Browsers cannot send large videos
   through serverless functions, so the studio asks the server for a ticket and then sends one file straight here.
2. When no token is set, the API serves only requests that did not come through a proxy. A request with a
   forwarding header (for example ``CF-Connecting-IP``) is refused, so a proxy that was started by mistake cannot
   expose unauthenticated endpoints.

Upload tickets are HMAC-signed with a key derived from the token, carry an expiry and a nonce, and can be redeemed
once. Spent nonces are kept until they expire. The token itself never leaves the server (the Next.js server keeps
it in a server-only variable).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import threading
import time
from typing import Mapping, Optional

FORWARDING_HEADERS = ("cf-connecting-ip", "x-forwarded-for", "x-real-ip", "forwarded", "x-forwarded-host", "cf-ray")
UPLOAD_TICKET_HEADER = "x-smashlab-upload-ticket"
TICKET_VERSION = "v1"
UPLOAD_SCOPE = "upload"


class AccessDenied(Exception):
    """Raised when a request is not allowed. The caller turns it into a 401 response."""


def is_forwarded(headers: Mapping[str, str]) -> bool:
    """True when the request came through a proxy (any forwarding header is present)."""
    present = {name.lower() for name in headers.keys()}
    return any(name in present for name in FORWARDING_HEADERS)


def bearer_matches(headers: Mapping[str, str], token: str) -> bool:
    value = headers.get("authorization", "")
    if not value.startswith("Bearer "):
        return False
    return hmac.compare_digest(value[len("Bearer "):].encode("utf-8"), token.encode("utf-8"))


def _signing_key(token: str) -> bytes:
    return hashlib.sha256(("smashlab-upload-ticket:" + token).encode("utf-8")).digest()


def _b64encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64decode(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def issue_upload_ticket(token: str, ttl_s: float, now: Optional[float] = None) -> tuple[str, float]:
    """A signed ticket that allows one upload until ``expires_at``. Returns (ticket, expires_at)."""
    issued = time.time() if now is None else now
    expires_at = round(issued + ttl_s, 3)
    payload = json.dumps(
        {"scope": UPLOAD_SCOPE, "exp": expires_at, "nonce": secrets.token_hex(12)},
        separators=(",", ":"),
    ).encode("utf-8")
    body = _b64encode(payload)
    signature = hmac.new(_signing_key(token), f"{TICKET_VERSION}.{body}".encode("ascii"), hashlib.sha256).digest()
    return f"{TICKET_VERSION}.{body}.{_b64encode(signature)}", expires_at


class UploadTicketStore:
    """Checks upload tickets and remembers spent nonces until their expiry (single use, in this process)."""

    def __init__(self, token: str) -> None:
        self._token = token
        self._spent: dict[str, float] = {}
        self._lock = threading.Lock()

    def redeem(self, ticket: str, now: Optional[float] = None) -> bool:
        moment = time.time() if now is None else now
        parts = ticket.split(".")
        if len(parts) != 3 or parts[0] != TICKET_VERSION:
            return False
        expected = _b64encode(
            hmac.new(_signing_key(self._token), f"{parts[0]}.{parts[1]}".encode("ascii"), hashlib.sha256).digest()
        )
        if not hmac.compare_digest(expected, parts[2]):
            return False
        try:
            payload = json.loads(_b64decode(parts[1]))
        except (ValueError, UnicodeDecodeError):
            return False
        if payload.get("scope") != UPLOAD_SCOPE:
            return False
        expires_at = float(payload.get("exp", 0.0))
        if expires_at < moment:
            return False
        nonce = str(payload.get("nonce", ""))
        if not nonce:
            return False
        with self._lock:
            self._spent = {spent: until for spent, until in self._spent.items() if until >= moment}
            if nonce in self._spent:
                return False
            self._spent[nonce] = expires_at
        return True


def authorize(
    headers: Mapping[str, str],
    token: Optional[str],
    tickets: Optional[UploadTicketStore],
    *,
    allow_upload_ticket: bool = False,
) -> None:
    """Raise AccessDenied unless the request may proceed (see the module rules)."""
    if token is None:
        if is_forwarded(headers):
            raise AccessDenied("forwarded request without a configured token")
        return
    if bearer_matches(headers, token):
        return
    if allow_upload_ticket and tickets is not None and tickets.redeem(headers.get(UPLOAD_TICKET_HEADER, "")):
        return
    raise AccessDenied("missing or invalid credentials")
