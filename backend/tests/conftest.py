import os
from pathlib import Path
from uuid import uuid4

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy.schema import CreateSchema, DropSchema

from app.db import create_database_engine, get_database_url


@pytest.fixture
def database_schema(monkeypatch):
    if not os.getenv("DATABASE_URL"):
        pytest.skip("requires PostgreSQL")

    schema = f"test_scopediff_{uuid4().hex}"
    engine = create_database_engine()
    try:
        with engine.begin() as connection:
            connection.execute(CreateSchema(schema))

        url = get_database_url()
        options = f"{url.query.get('options', '')} -csearch_path={schema}".strip()
        test_url = url.update_query_dict({"options": options})
        monkeypatch.setenv("DATABASE_URL", test_url.render_as_string(hide_password=False))
        monkeypatch.delenv("RENDER", raising=False)
        monkeypatch.delenv("SESSION_RATE_LIMIT_PER_HOUR", raising=False)
        yield Config(str(Path(__file__).resolve().parents[1] / "alembic.ini"))
    finally:
        with engine.begin() as connection:
            connection.execute(DropSchema(schema, if_exists=True, cascade=True))
        engine.dispose()


@pytest.fixture
def migrated_database(database_schema):
    command.upgrade(database_schema, "head")
