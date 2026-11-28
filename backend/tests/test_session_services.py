from base64 import urlsafe_b64decode
from hashlib import sha256
from uuid import UUID, uuid4

from api_helpers import API, assert_error, auth, issue_token
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.exc import OperationalError

from app import main, sessions
from app.db import create_database_engine
from app.models import sessions as stored_sessions

def test_catalog_lifecycle_with_two_sessions(migrated_database):
    with TestClient(main.app) as client:
        token_a = issue_token(client)
        token_b = issue_token(client)
        assert len(urlsafe_b64decode(token_a + "=")) == 32
        assert len(urlsafe_b64decode(token_b + "=")) == 32
        assert token_a != token_b
        with main.app.state.engine.connect() as connection:
            hashes = set(connection.scalars(select(stored_sessions.c.token_hash)))
        assert hashes == {sha256(token_a.encode()).digest(), sha256(token_b.encode()).digest()}

        for token in (token_a, token_b):
            response = client.get(f"{API}/services", headers=auth(token))
            assert response.status_code == 200
            assert response.json() == []

        original = {"name": "Монтаж", "description": "Два раунда правок"}
        response = client.post(f"{API}/services", headers=auth(token_a), json=original)
        assert response.status_code == 201
        service_id = response.json()["id"]
        assert UUID(service_id).version == 4
        assert response.json() == {"id": service_id, **original}

        response = client.post(
            f"{API}/services", headers=auth(token_a), json={"name": "Дизайн", "description": ""}
        )
        assert response.status_code == 201
        catalog = client.get(f"{API}/services", headers=auth(token_a))
        assert catalog.status_code == 200
        assert [item["name"] for item in catalog.json()] == ["Дизайн", "Монтаж"]

        path = f"{API}/services/{service_id}"
        response = client.patch(path, headers=auth(token_a), json={"name": "Монтаж видео"})
        expected = {"id": service_id, "name": "Монтаж видео", "description": original["description"]}
        assert response.status_code == 200
        assert response.json() == expected
        assert client.patch(path, headers=auth(token_a), json={}).json() == expected

    with TestClient(main.app) as client:
        response = client.get(path, headers=auth(token_a))
        assert response.status_code == 200
        assert response.json() == expected
        assert client.get(f"{API}/services", headers=auth(token_b)).json() == []
        assert_error(client.get(path, headers=auth(token_b)), 404, "NOT_FOUND")
        assert_error(client.patch(path, headers=auth(token_b), json={"name": "Замена"}), 404, "NOT_FOUND")
        assert_error(client.delete(path, headers=auth(token_b)), 404, "NOT_FOUND")
        assert client.get(path, headers=auth(token_a)).json() == expected

        for headers in ({}, auth("unknown-token"), {"Authorization": "Basic unknown-token"}):
            response = client.get(f"{API}/services", headers=headers)
            assert_error(response, 401, "UNAUTHORIZED")
            assert response.headers["WWW-Authenticate"] == "Bearer"

        response = client.delete(path, headers=auth(token_a))
        assert response.status_code == 204
        assert response.content == b""
        assert_error(client.get(path, headers=auth(token_a)), 404, "NOT_FOUND")
        assert_error(client.delete(path, headers=auth(token_a)), 404, "NOT_FOUND")


def test_service_input_boundaries_and_safe_validation_errors(migrated_database):
    with TestClient(main.app) as client:
        assert_error(client.post(f"{API}/session"), 422, "VALIDATION_ERROR")
        assert_error(client.post(f"{API}/session", json={"unexpected": True}), 422, "VALIDATION_ERROR")
        headers = auth(issue_token(client))
        path = f"{API}/services"
        longest = {"name": "я" * 120, "description": "э" * 12000}
        valid = client.post(path, headers=headers, json=longest)
        assert valid.status_code == 201
        assert valid.json() == {"id": valid.json()["id"], **longest}
        item_path = f"{path}/{valid.json()['id']}"
        shortest = client.patch(item_path, headers=headers, json={"name": "А", "description": ""})
        assert shortest.status_code == 200
        assert shortest.json() == {"id": valid.json()["id"], "name": "А", "description": ""}

        for field, value in (
            ("name", ""), ("name", "я" * 121), ("description", "э" * 12001),
            ("name", None), ("description", None), ("name", 1), ("description", "\x00"),
            ("session_id", str(uuid4())),
        ):
            assert_error(client.post(path, headers=headers, json={**longest, field: value}), 422, "VALIDATION_ERROR")
            assert_error(client.patch(item_path, headers=headers, json={field: value}), 422, "VALIDATION_ERROR")
        minimal = client.post(path, headers=headers, json={"name": "А"})
        assert minimal.status_code == 201
        assert minimal.json() == {"id": minimal.json()["id"], "name": "А", "description": ""}
        assert_error(client.get(f"{path}/invalid-id", headers=headers), 422, "VALIDATION_ERROR")
        malformed = client.post(path, headers={**headers, "Content-Type": "application/json"}, content='{"private"')
        assert_error(malformed, 422, "VALIDATION_ERROR")
        assert "private" not in malformed.text
        assert client.get(item_path, headers=headers).json() == shortest.json()


def test_session_rate_limit_is_per_ip_and_expires(migrated_database, monkeypatch):
    now = 100.0
    monkeypatch.setattr(sessions, "monotonic", lambda: now)
    monkeypatch.setenv("SESSION_RATE_LIMIT_PER_HOUR", "1")
    with TestClient(main.app, client=("192.0.2.10", 1234)) as client:
        issue_token(client)
        forged_headers = {"X-Forwarded-For": "192.0.2.11", "CF-Connecting-IP": "192.0.2.12"}
        limited = client.post(f"{API}/session", headers=forged_headers, json={})
        assert_error(limited, 429, "RATE_LIMITED")
        assert limited.headers["Retry-After"] == "3600"
        now += 3600
        issue_token(client)

    monkeypatch.setenv("RENDER", "true")
    with TestClient(main.app) as client:
        url = f"{API}/session"
        first_client = {"CF-Connecting-IP": "2001:db8::1"}
        assert client.post(url, headers=first_client, json={}).status_code == 201
        forged_chain = {"CF-Connecting-IP": "2001:0db8::1", "X-Forwarded-For": "192.0.2.12"}
        assert_error(client.post(url, headers=forged_chain, json={}), 429, "RATE_LIMITED")
        assert client.post(url, headers={"CF-Connecting-IP": "2001:db8::2"}, json={}).status_code == 201
        assert client.post(url, json={}).status_code == 201
        assert_error(client.post(url, headers={"CF-Connecting-IP": "invalid"}, json={}), 429, "RATE_LIMITED")


def test_session_and_catalog_hide_database_connection_failure(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql+psycopg://")
    engine = create_database_engine()

    def fail_to_connect():
        raise OperationalError(None, None, Exception("private connection details"))

    monkeypatch.setattr(engine, "connect", fail_to_connect)
    monkeypatch.setattr(main, "create_database_engine", lambda: engine)
    with TestClient(main.app) as client:
        for response in (
            client.post(f"{API}/session", json={}),
            client.get(f"{API}/services", headers=auth("unverified-token")),
        ):
            assert_error(response, 503, "SERVICE_UNAVAILABLE")
            assert "private connection details" not in response.text


def test_openapi_matches_session_and_catalog_contract():
    schema = main.app.openapi()
    expected = {
        "/session": {"post": {"201", "422", "429", "503"}},
        "/services": {"get": {"200", "401", "503"}, "post": {"201", "401", "422", "503"}},
        "/services/{service_id}": {
            "get": {"200", "401", "404", "422", "503"},
            "patch": {"200", "401", "404", "422", "503"},
            "delete": {"204", "401", "404", "422", "503"},
        },
    }
    assert schema["components"]["securitySchemes"]["HTTPBearer"] == {"type": "http", "scheme": "bearer"}
    for path, operations in expected.items():
        for method, statuses in operations.items():
            operation = schema["paths"][API + path][method]
            assert operation["responses"].keys() == statuses
            if path.startswith("/services"):
                assert operation["security"] == [{"HTTPBearer": []}]
            else:
                assert "security" not in operation

    components = schema["components"]["schemas"]
    assert set(components["Service"]["properties"]) == {"id", "name", "description"}
    assert set(components["Service"]["required"]) == {"id", "name", "description"}
    assert components["ServiceInput"]["required"] == ["name"]
    assert set(components["SessionResponse"]["properties"]) == {"token"}
    assert "required" not in components["ServicePatch"]
    assert all(field["type"] == "string" for field in components["ServicePatch"]["properties"].values())
    assert "content" not in schema["paths"][f"{API}/services/{{service_id}}"]["delete"]["responses"]["204"]
