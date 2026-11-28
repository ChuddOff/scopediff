import os
from collections import defaultdict, deque
from hashlib import sha256
from ipaddress import IPv6Address, ip_address
from math import ceil
from secrets import token_urlsafe
from threading import Lock
from time import monotonic
from typing import Annotated
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Request, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select

from app.db import Database
from app.errors import SERVICE_UNAVAILABLE, VALIDATION_ERROR, ApiError, ApiException
from app.models import sessions

HOUR_SECONDS = 3600

router = APIRouter(tags=["Session"])
bearer = HTTPBearer(auto_error=False)


class SessionInput(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SessionResponse(BaseModel):
    token: str


class RateLimiter:
    def __init__(self, limit: int, window: int, message: str):
        if limit <= 0:
            raise ValueError("Rate limit must be positive")
        self.limit = limit
        self.window = window
        self.message = message
        self._lock = Lock()
        self._attempts: dict[str, deque[float]] = defaultdict(deque)
        self._expirations: deque[tuple[float, str]] = deque()

    def check(self, client_ip: str) -> None:
        with self._lock:
            now = monotonic()
            while self._expirations and self._expirations[0][0] <= now:
                _, expired_ip = self._expirations.popleft()
                self._attempts[expired_ip].popleft()
                if not self._attempts[expired_ip]:
                    del self._attempts[expired_ip]

            attempts = self._attempts[client_ip]
            if len(attempts) >= self.limit:
                retry_after = ceil(attempts[0] - now)
                raise ApiException(
                    429,
                    "RATE_LIMITED",
                    self.message,
                    {"Retry-After": str(retry_after)},
                )

            expires_at = now + self.window
            attempts.append(expires_at)
            self._expirations.append((expires_at, client_ip))


def client_ip(request: Request) -> str:
    if os.getenv("RENDER") == "true":
        # The public Render ingress supplies the Cloudflare client IP header.
        values = request.headers.getlist("cf-connecting-ip")
        value = values[0].strip() if len(values) == 1 else ""
    else:
        value = request.client.host if request.client else ""

    if "%" in value:
        return "unknown"
    try:
        address = ip_address(value)
    except ValueError:
        return "unknown"
    if isinstance(address, IPv6Address) and address.ipv4_mapped is not None:
        return str(address.ipv4_mapped)
    return str(address)


def require_session(
    database: Database,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
) -> UUID:
    if credentials is not None:
        token_hash = sha256(credentials.credentials.encode()).digest()
        with database.connect() as connection:
            session_id = connection.scalar(select(sessions.c.id).where(sessions.c.token_hash == token_hash))
        if session_id is not None:
            return session_id

    raise ApiException(401, "UNAUTHORIZED", "Требуется действительный токен сессии", {"WWW-Authenticate": "Bearer"})


CurrentSession = Annotated[UUID, Depends(require_session)]


@router.post(
    "/session",
    status_code=201,
    response_model=SessionResponse,
    responses={
        422: VALIDATION_ERROR,
        429: {
            "model": ApiError,
            "description": "Лимит создания сессий исчерпан",
            "headers": {"Retry-After": {"schema": {"type": "integer"}}},
        },
        503: SERVICE_UNAVAILABLE,
    },
)
def create_session(payload: SessionInput, request: Request, response: Response, database: Database) -> SessionResponse:
    request.app.state.session_rate_limiter.check(client_ip(request))
    token = token_urlsafe(32)
    token_hash = sha256(token.encode()).digest()
    with database.begin() as connection:
        connection.execute(sessions.insert().values(id=uuid4(), token_hash=token_hash))

    response.headers["Cache-Control"] = "no-store"
    return SessionResponse(token=token)
