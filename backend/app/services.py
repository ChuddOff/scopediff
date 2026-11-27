from typing import Annotated
from uuid import UUID, uuid4

from fastapi import APIRouter, Response
from pydantic import BaseModel, ConfigDict, StringConstraints, with_config
from sqlalchemy import select
from sqlalchemy.engine import Connection, RowMapping
from typing_extensions import TypedDict

from app.db import Database
from app.errors import SERVICE_UNAVAILABLE, VALIDATION_ERROR, ApiError, ApiException
from app.models import services
from app.sessions import CurrentSession

router = APIRouter(
    prefix="/services",
    tags=["Services"],
    responses={
        401: {"model": ApiError, "description": "Требуется действительный токен сессии"},
        503: SERVICE_UNAVAILABLE,
    },
)

INPUT_ERRORS = {422: VALIDATION_ERROR}
ITEM_ERRORS = {
    404: {"model": ApiError, "description": "Услуга не найдена"},
    422: VALIDATION_ERROR,
}

# PostgreSQL text columns cannot store NUL characters.
ServiceName = Annotated[str, StringConstraints(min_length=1, max_length=120, pattern=r"^[^\x00]*$")]
ServiceDescription = Annotated[str, StringConstraints(max_length=12000, pattern=r"^[^\x00]*$")]


class ServiceFields(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: ServiceName
    description: ServiceDescription


@with_config(ConfigDict(extra="forbid"))
class ServicePatch(TypedDict, total=False):
    name: ServiceName
    description: ServiceDescription


class ServiceInput(ServiceFields):
    description: ServiceDescription = ""


class Service(ServiceFields):
    id: UUID


public_columns = (services.c.id, services.c.name, services.c.description)


def owned_service(service_id: UUID, session_id: UUID):
    return (services.c.id == service_id) & (services.c.session_id == session_id)


def service_response(row: RowMapping | None) -> Service:
    if row is None:
        raise ApiException(404, "NOT_FOUND", "Услуга не найдена")
    return Service.model_validate(row)


@router.get("")
def list_services(database: Database, session_id: CurrentSession) -> list[Service]:
    query = (
        select(*public_columns)
        .where(services.c.session_id == session_id)
        .order_by(services.c.name, services.c.id)
    )
    with database.connect() as connection:
        return [Service.model_validate(row) for row in connection.execute(query).mappings()]


@router.post("", status_code=201, responses=INPUT_ERRORS)
def create_service(payload: ServiceInput, database: Database, session_id: CurrentSession) -> Service:
    with database.begin() as connection:
        return insert_service(connection, session_id, payload)


def insert_service(connection: Connection, session_id: UUID, payload: ServiceFields) -> Service:
    query = (
        services.insert()
        .values(id=uuid4(), session_id=session_id, **payload.model_dump())
        .returning(*public_columns)
    )
    return Service.model_validate(connection.execute(query).mappings().one())


@router.get("/{service_id}", responses=ITEM_ERRORS)
def get_service(service_id: UUID, database: Database, session_id: CurrentSession) -> Service:
    query = select(*public_columns).where(owned_service(service_id, session_id))
    with database.connect() as connection:
        return service_response(connection.execute(query).mappings().one_or_none())


@router.patch("/{service_id}", responses=ITEM_ERRORS)
def update_service(
    service_id: UUID, payload: ServicePatch, database: Database, session_id: CurrentSession
) -> Service:
    if not payload:
        return get_service(service_id, database, session_id)

    query = (
        services.update()
        .where(owned_service(service_id, session_id))
        .values(**payload)
        .returning(*public_columns)
    )
    with database.begin() as connection:
        return service_response(connection.execute(query).mappings().one_or_none())


@router.delete("/{service_id}", status_code=204, responses=ITEM_ERRORS)
def delete_service(service_id: UUID, database: Database, session_id: CurrentSession) -> Response:
    query = services.delete().where(owned_service(service_id, session_id)).returning(services.c.id)
    with database.begin() as connection:
        if connection.scalar(query) is None:
            raise ApiException(404, "NOT_FOUND", "Услуга не найдена")
    return Response(status_code=204)
