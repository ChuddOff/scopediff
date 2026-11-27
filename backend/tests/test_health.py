import os

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.exc import OperationalError

from app import main


@pytest.mark.skipif(not os.getenv("DATABASE_URL"), reason="requires PostgreSQL")
def test_health_ok_with_postgresql():
    with TestClient(main.app) as client:
        response = client.get("/api/v1/health")
        schema = client.get("/openapi.json").json()

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
    assert {"200", "503"} <= schema["paths"]["/api/v1/health"]["get"]["responses"].keys()


def test_health_hides_database_error(monkeypatch):
    engine = create_engine("postgresql+psycopg://")

    def fail_to_connect():
        raise OperationalError(None, None, Exception("private connection details"))

    monkeypatch.setattr(engine, "connect", fail_to_connect)
    monkeypatch.setattr(main, "create_database_engine", lambda: engine)

    with TestClient(main.app) as client:
        response = client.get("/api/v1/health")

    assert response.status_code == 503
    assert response.json() == {
        "error": {
            "code": "SERVICE_UNAVAILABLE",
            "message": "База данных временно недоступна",
        },
    }
