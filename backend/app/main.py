from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from app.db import create_database_engine


class HealthStatus(BaseModel):
    status: Literal["ok"]


class ServiceUnavailable(BaseModel):
    code: Literal["SERVICE_UNAVAILABLE"]
    message: str


class HealthError(BaseModel):
    error: ServiceUnavailable


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    engine = create_database_engine()
    app.state.engine = engine
    try:
        yield
    finally:
        engine.dispose()


app = FastAPI(title="ScopeDiff API", lifespan=lifespan)


@app.get("/api/v1/health", response_model=HealthStatus, responses={503: {"model": HealthError}})
def health(request: Request) -> HealthStatus | JSONResponse:
    try:
        with request.app.state.engine.begin() as connection:
            connection.execute(text("SET LOCAL statement_timeout = '2s'"))
            connection.execute(text("SELECT 1")).scalar_one()
    except SQLAlchemyError:
        error = HealthError(
            error=ServiceUnavailable(
                code="SERVICE_UNAVAILABLE",
                message="База данных временно недоступна",
            ),
        )
        return JSONResponse(status_code=503, content=error.model_dump())

    return HealthStatus(status="ok")
