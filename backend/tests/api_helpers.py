from fastapi.testclient import TestClient

API = "/api/v1"


def issue_token(client: TestClient) -> str:
    response = client.post(f"{API}/session", json={})
    assert response.status_code == 201
    assert set(response.json()) == {"token"}
    assert response.headers["Cache-Control"] == "no-store"
    return response.json()["token"]


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def assert_error(response, status: int, code: str) -> None:
    assert response.status_code == status
    body = response.json()
    assert set(body) == {"error"}
    assert body["error"]["code"] == code
    assert body["error"]["message"]
