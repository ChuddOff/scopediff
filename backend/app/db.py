import os
from typing import Annotated

from fastapi import Depends, Request
from sqlalchemy import create_engine
from sqlalchemy.engine import Engine, URL, make_url
from sqlalchemy.exc import ArgumentError


def get_database_url() -> URL:
    value = os.environ.get("DATABASE_URL")
    if not value:
        raise RuntimeError("DATABASE_URL is required")

    try:
        url = make_url(value)
    except (ArgumentError, ValueError):
        raise RuntimeError("DATABASE_URL must be a PostgreSQL connection URL") from None

    if url.drivername not in {"postgres", "postgresql", "postgresql+psycopg"}:
        raise RuntimeError("DATABASE_URL must be a PostgreSQL connection URL")

    return url.set(drivername="postgresql+psycopg")


def create_database_engine() -> Engine:
    return create_engine(
        get_database_url(),
        connect_args={"connect_timeout": 2},
        pool_pre_ping=True,
        pool_timeout=2,
        hide_parameters=True,
    )


def get_engine(request: Request) -> Engine:
    return request.app.state.engine


Database = Annotated[Engine, Depends(get_engine)]
