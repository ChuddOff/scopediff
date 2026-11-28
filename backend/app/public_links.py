import os
import re
from urllib.parse import urlsplit


def public_api_base_url() -> str | None:
    value = os.getenv("PUBLIC_API_BASE_URL", "").strip().rstrip("/")
    if not re.fullmatch(r"https://(?:[a-z0-9.-]+|\[[a-f0-9:]+\])(?::[0-9]+)?/api/v1", value, re.I | re.ASCII):
        return None
    value = value.lower()
    try:
        urlsplit(value).port
    except ValueError:
        return None
    return value


def share_url(token: str | None) -> str | None:
    base = public_api_base_url() if token else None
    return f"{base.removesuffix('/api/v1')}/share/{token}" if base else None
