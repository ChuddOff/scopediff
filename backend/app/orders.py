import re
from datetime import date, datetime, timezone
from typing import Annotated, Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Response
from pydantic import BaseModel, BeforeValidator, ConfigDict, StringConstraints, field_validator, with_config
from pydantic.alias_generators import to_camel
from sqlalchemy import func, select
from sqlalchemy.engine import Connection, RowMapping
from typing_extensions import TypedDict

from app import services
from app.db import Database
from app.errors import SERVICE_UNAVAILABLE, VALIDATION_ERROR, ApiError, ApiException
from app.models import open_proposal, orders, proposals
from app.sessions import CurrentSession

router = APIRouter(
    prefix="/orders",
    tags=["Orders"],
    responses={
        401: {"model": ApiError, "description": "Требуется действительный токен сессии"},
        503: SERVICE_UNAVAILABLE,
    },
)
INPUT_ERRORS = {422: VALIDATION_ERROR}
ORDER_NOT_FOUND = {"model": ApiError, "description": "Заказ не найден"}
SERVICE_NOT_FOUND = {"model": ApiError, "description": "Услуга не найдена"}
ITEM_ERRORS = {404: ORDER_NOT_FOUND, **INPUT_ERRORS}
OPEN_PROPOSAL_CONFLICT = {"model": ApiError, "description": "У заказа уже есть открытое предложение"}
PATCH_ERRORS = {
    404: {"model": ApiError, "description": "Заказ или услуга не найдены"},
    409: OPEN_PROPOSAL_CONFLICT,
    **INPUT_ERRORS,
}

OrderStatus = Literal["active", "completed"]
ProposalStatus = Literal["draft", "pending", "countered", "approved", "rejected"]
OrderTitle = Annotated[str, StringConstraints(min_length=1, max_length=160, pattern=r"^[^\x00]*$")]
OrderText = Annotated[str, StringConstraints(max_length=12000, pattern=r"^[^\x00]*$")]
INPUT_CONFIG = ConfigDict(alias_generator=to_camel, extra="forbid")


def validate_date_only(value: object) -> date:
    if type(value) is date:
        return value
    if isinstance(value, str) and re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", value):
        return date.fromisoformat(value)
    raise ValueError("Expected a calendar date in YYYY-MM-DD format")


DateOnly = Annotated[date, BeforeValidator(validate_date_only)]


class OrderFields(BaseModel):
    model_config = INPUT_CONFIG

    service_id: UUID | None
    title: OrderTitle
    agreements: OrderText
    completed_work: OrderText
    deadline: DateOnly | None


class OrderInput(OrderFields):
    service_id: UUID | None = None
    agreements: OrderText = ""
    completed_work: OrderText = ""
    deadline: DateOnly | None = None


@with_config(INPUT_CONFIG)
class OrderPatch(TypedDict, total=False):
    service_id: UUID | None
    title: OrderTitle
    agreements: OrderText
    completed_work: OrderText
    deadline: DateOnly | None
    status: OrderStatus


class Order(OrderFields):
    model_config = ConfigDict(validate_by_name=True)

    id: UUID
    service_snapshot: services.Service | None
    status: OrderStatus
    revision: int
    created_at: datetime
    updated_at: datetime

    @field_validator("created_at", "updated_at")
    @classmethod
    def as_utc(cls, value: datetime) -> datetime:
        return value.astimezone(timezone.utc)


class OrderSummary(Order):
    open_proposal_status: ProposalStatus | None


class Proposal(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, validate_by_name=True)

    id: UUID
    order_id: UUID
    title: str
    status: ProposalStatus
    current_version_id: UUID
    published_version_id: UUID | None
    approved_version_id: UUID | None
    share_url: str | None
    created_at: datetime
    updated_at: datetime

    @field_validator("created_at", "updated_at")
    @classmethod
    def as_utc(cls, value: datetime) -> datetime:
        return value.astimezone(timezone.utc)


class OrderDetail(BaseModel):
    order: Order
    proposals: list[Proposal]


public_columns = (
    orders.c.id, orders.c.service_id, orders.c.service_snapshot, orders.c.title,
    orders.c.agreements, orders.c.completed_work, orders.c.deadline, orders.c.status,
    orders.c.revision, orders.c.created_at, orders.c.updated_at,
)
context_fields = {"service_id", "service_snapshot", "agreements", "completed_work", "deadline"}


def owned_order(order_id: UUID, session_id: UUID):
    return (orders.c.id == order_id) & (orders.c.session_id == session_id)


def require_order(row: RowMapping | None) -> RowMapping:
    if row is None:
        raise ApiException(404, "NOT_FOUND", "Заказ не найден")
    return row


def require_no_open_proposal(connection: Connection, order_id: UUID) -> None:
    existing = select(proposals.c.id).where(proposals.c.order_id == order_id, open_proposal)
    if connection.scalar(existing) is not None:
        raise ApiException(409, "OPEN_PROPOSAL_EXISTS", "У заказа уже есть открытое предложение")


def proposal_response(row: RowMapping) -> Proposal:
    return Proposal.model_validate(dict(row, share_url=None))


def order_proposals(connection: Connection, order_id: UUID) -> list[Proposal]:
    query = (
        select(proposals)
        .where(proposals.c.order_id == order_id)
        .order_by(proposals.c.updated_at.desc(), proposals.c.id.desc())
    )
    return [proposal_response(row) for row in connection.execute(query).mappings()]


def get_service_snapshot(connection: Connection, service_id: UUID | None, session_id: UUID) -> dict | None:
    if service_id is None:
        return None
    # Hold the service stable until the order is written. Lock services before orders,
    # as deletion of a service also touches its linked orders through the foreign key.
    query = (
        select(*services.public_columns)
        .where(services.owned_service(service_id, session_id))
        .with_for_update(read=True)
    )
    service = services.service_response(connection.execute(query).mappings().one_or_none())
    return service.model_dump(mode="json")


@router.get("")
def list_orders(database: Database, session_id: CurrentSession) -> list[OrderSummary]:
    query = (
        select(*public_columns, proposals.c.status.label("open_proposal_status"))
        .outerjoin(proposals, (proposals.c.order_id == orders.c.id) & open_proposal)
        .where(orders.c.session_id == session_id)
        .order_by(orders.c.updated_at.desc(), orders.c.id.desc())
    )
    with database.connect() as connection:
        rows = connection.execute(query).mappings()
        return [OrderSummary.model_validate(row) for row in rows]


@router.post("", status_code=201, responses={404: SERVICE_NOT_FOUND, **INPUT_ERRORS})
def create_order(payload: OrderInput, database: Database, session_id: CurrentSession) -> Order:
    with database.begin() as connection:
        return insert_order(connection, session_id, payload)


def insert_order(connection: Connection, session_id: UUID, payload: OrderInput) -> Order:
    snapshot = get_service_snapshot(connection, payload.service_id, session_id)
    query = (
        orders.insert()
        .values(id=uuid4(), session_id=session_id, service_snapshot=snapshot, **payload.model_dump())
        .returning(*public_columns)
    )
    return Order.model_validate(connection.execute(query).mappings().one())


@router.get("/{order_id}", responses=ITEM_ERRORS)
def get_order(order_id: UUID, database: Database, session_id: CurrentSession) -> OrderDetail:
    query = select(*public_columns).where(owned_order(order_id, session_id))
    with database.connect().execution_options(isolation_level="REPEATABLE READ") as connection:
        row = require_order(connection.execute(query).mappings().one_or_none())
        return OrderDetail(order=Order.model_validate(row), proposals=order_proposals(connection, order_id))


@router.patch("/{order_id}", responses=PATCH_ERRORS)
def update_order(order_id: UUID, payload: OrderPatch, database: Database, session_id: CurrentSession) -> Order:
    owned = owned_order(order_id, session_id)
    with database.begin() as connection:
        service_id = payload.get("service_id")
        snapshot = get_service_snapshot(connection, service_id, session_id)
        query = select(*public_columns).where(owned).with_for_update()
        current = require_order(connection.execute(query).mappings().one_or_none())
        if payload.get("status") == "completed":
            require_no_open_proposal(connection, order_id)

        changes = {field: value for field, value in payload.items() if value != current[field]}
        clears_snapshot = "service_id" in payload and service_id is None and current["service_snapshot"] is not None
        if "service_id" in changes or clears_snapshot:
            changes["service_snapshot"] = snapshot

        if not changes:
            return Order.model_validate(current)

        if context_fields.intersection(changes):
            changes["revision"] = current["revision"] + 1
        query = (
            orders.update()
            .where(owned)
            .values(**changes, updated_at=func.statement_timestamp())
            .returning(*public_columns)
        )
        return Order.model_validate(connection.execute(query).mappings().one())


@router.delete("/{order_id}", status_code=204, responses=ITEM_ERRORS)
def delete_order(order_id: UUID, database: Database, session_id: CurrentSession) -> Response:
    query = orders.delete().where(owned_order(order_id, session_id)).returning(orders.c.id)
    with database.begin() as connection:
        require_order(connection.execute(query).mappings().one_or_none())
    return Response(status_code=204)
