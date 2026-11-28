import logging
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from app import ai, ai_routes, orders, pdf, proposals, public_approval, services, sessions
from app.db import Database, create_database_engine
from app.errors import SERVICE_UNAVAILABLE, ApiException


class HealthStatus(BaseModel):
    status: Literal["ok"]


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    app.state.session_rate_limiter = sessions.RateLimiter(
        int(os.getenv("SESSION_RATE_LIMIT_PER_HOUR", "10")), sessions.HOUR_SECONDS,
        "Слишком много попыток создать сессию. Попробуйте позже",
    )
    app.state.pdf_links = pdf.PdfLinks.from_environment()
    logging.getLogger("python_multipart").setLevel(logging.ERROR)
    engine = create_database_engine()
    app.state.engine = engine
    try:
        analyzer = ai.ChangesAnalyzer()
        app.state.changes_analyzer = analyzer
        try:
            yield
        finally:
            await analyzer.close()
    finally:
        engine.dispose()


app = FastAPI(title="ScopeDiff API", lifespan=lifespan)
app.add_middleware(public_approval.PublicRequestMiddleware)
app.include_router(sessions.router, prefix="/api/v1")
app.include_router(ai_routes.router, prefix="/api/v1")
app.include_router(services.router, prefix="/api/v1")
app.include_router(orders.router, prefix="/api/v1")
app.include_router(proposals.router, prefix="/api/v1")
app.include_router(pdf.router, prefix="/api/v1")
app.include_router(public_approval.router)


@app.exception_handler(ApiException)
async def api_error(request: Request, exc: ApiException) -> JSONResponse:
    return exc.response()


@app.exception_handler(RequestValidationError)
async def validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
    return ApiException(422, "VALIDATION_ERROR", "Некорректные данные запроса").response()


@app.exception_handler(SQLAlchemyError)
async def database_error(request: Request, exc: SQLAlchemyError) -> JSONResponse:
    return ApiException(503, "SERVICE_UNAVAILABLE", "База данных временно недоступна").response()


@app.get("/api/v1/health", responses={503: SERVICE_UNAVAILABLE})
def health(database: Database) -> HealthStatus:
    with database.begin() as connection:
        connection.execute(text("SET LOCAL statement_timeout = '2s'"))
        connection.execute(text("SELECT 1")).scalar_one()

    return HealthStatus(status="ok")
