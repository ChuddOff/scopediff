from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel, ConfigDict, field_validator
from pydantic.alias_generators import to_camel
from sqlalchemy import func, select
from sqlalchemy.engine import Connection, Engine, RowMapping
from starlette.concurrency import run_in_threadpool

from app import ai, orders
from app.ai_forms import FORM_ERRORS, multipart_body, read_ai_form
from app.db import Database
from app.errors import SERVICE_UNAVAILABLE, VALIDATION_ERROR, ApiError, ApiException
from app.models import orders as order_table
from app.models import proposal_versions, proposals
from app.sessions import CurrentSession, client_ip

router = APIRouter(
    tags=["Proposals"],
    responses={
        401: {"model": ApiError, "description": "Требуется действительный токен сессии"},
        503: SERVICE_UNAVAILABLE,
    },
)
OPEN_STATUSES = ("draft", "pending", "countered")
PROPOSAL_ERRORS = {404: {"model": ApiError, "description": "Предложение не найдено"}, 422: VALIDATION_ERROR}
ACTION_ERRORS = {
    **PROPOSAL_ERRORS,
    409: {"model": ApiError, "description": "Текущая версия, состояние предложения или условия заказа изменились"},
}


class ChangeItem(ai.ChangeContent):
    id: UUID


class ProposalVersion(ai.ProposalFields):
    model_config = ConfigDict(alias_generator=to_camel, validate_by_name=True)

    id: UUID
    proposal_id: UUID
    version: int
    author: Literal["freelancer", "client"]
    base_order_revision: int
    items: list[ChangeItem]
    created_at: datetime

    @field_validator("created_at")
    @classmethod
    def as_utc(cls, value: datetime) -> datetime:
        return value.astimezone(timezone.utc)


class ProposalResult(BaseModel):
    proposal: orders.Proposal
    version: ProposalVersion


class ProposalDetail(BaseModel):
    proposal: orders.Proposal
    versions: list[ProposalVersion]


class ChangeItemInput(ai.ChangeContent):
    id: UUID | None


class ProposalContentInput(ai.ProposalFields):
    items: list[ChangeItemInput]


class VersionAction(BaseModel):
    model_config = orders.INPUT_CONFIG

    expected_version_id: UUID


class UpdateProposal(VersionAction):
    content: ProposalContentInput


class PublishProposal(VersionAction):
    format: Literal["pdf", "markdown", "text", "link"]


@dataclass(frozen=True)
class ProposalState:
    order: RowMapping
    proposal: orders.Proposal
    version: ProposalVersion

    def result(self) -> ProposalResult:
        return ProposalResult(proposal=self.proposal, version=self.version)


def require_available_order(
    connection: Connection, order_id: UUID, session_id: UUID, *, expected_revision: int | None = None
) -> RowMapping:
    query = select(*orders.public_columns).where(orders.owned_order(order_id, session_id))
    if expected_revision is not None:
        query = query.with_for_update()
    order = orders.require_order(connection.execute(query).mappings().one_or_none())
    if order["status"] != "active":
        raise ApiException(409, "INVALID_STATE", "Правки можно добавить только к активному заказу")
    if expected_revision is not None and order["revision"] != expected_revision:
        raise ApiException(409, "ORDER_CHANGED", "Условия заказа изменились. Обновите заказ и повторите анализ")
    orders.require_no_open_proposal(connection, order_id)
    return order


def order_context(connection: Connection, order: RowMapping, text: str) -> dict:
    approved_query = (
        select(
            proposal_versions.c.title, proposal_versions.c["items"], proposal_versions.c.deadline,
            proposal_versions.c.conditions, proposal_versions.c.comment,
        )
        .join(proposals, proposal_versions.c.id == proposals.c.approved_version_id)
        .where(proposals.c.order_id == order["id"], proposals.c.status == "approved")
        .order_by(proposal_versions.c.created_at, proposal_versions.c.id)
    )
    approved = [
        {
            "title": row["title"],
            "items": [{key: item[key] for key in ("title", "description", "price")} for item in row["items"]],
            "deadline": row["deadline"].isoformat() if row["deadline"] else None,
            "conditions": row["conditions"],
            "comment": row["comment"],
        }
        for row in connection.execute(approved_query).mappings()
    ]
    return {
        "serviceSnapshot": order["service_snapshot"],
        "agreements": order["agreements"],
        "completedWork": order["completed_work"],
        "deadline": order["deadline"].isoformat() if order["deadline"] else None,
        "approvedVersions": approved,
        "requestedChanges": text,
    }


def load_order_context(database: Engine, order_id: UUID, session_id: UUID, text: str) -> tuple[int, dict]:
    with database.connect() as connection:
        order = require_available_order(connection, order_id, session_id)
        return order["revision"], order_context(connection, order, text)


def save_draft(
    database: Engine, order_id: UUID, session_id: UUID, revision: int, content: ai.AnalyzedProposal
) -> ProposalResult:
    with database.begin() as connection:
        require_available_order(connection, order_id, session_id, expected_revision=revision)
        return insert_draft(connection, order_id, revision, content)


def insert_draft(connection: Connection, order_id: UUID, revision: int, content: ai.AnalyzedProposal) -> ProposalResult:
    proposal_id = uuid4()
    version_id = uuid4()
    items = [ChangeItem(id=uuid4(), **item.model_dump()).model_dump(mode="json") for item in content.items]
    proposal = connection.execute(
        proposals.insert()
        .values(id=proposal_id, order_id=order_id, title=content.title, status="draft", current_version_id=version_id)
        .returning(*proposals.c)
    ).mappings().one()
    version = connection.execute(
        proposal_versions.insert()
        .values(
            id=version_id, proposal_id=proposal_id, version=1, author="freelancer", base_order_revision=revision,
            items=items, **content.model_dump(exclude={"items"}),
        )
        .returning(*proposal_versions.c)
    ).mappings().one()
    connection.execute(
        order_table.update().where(order_table.c.id == order_id).values(updated_at=proposal["updated_at"])
    )
    return ProposalResult(proposal=orders.proposal_response(proposal), version=ProposalVersion.model_validate(version))


@router.post(
    "/orders/{order_id}/proposals",
    status_code=201,
    responses={
        **ai.AI_ERRORS,
        **FORM_ERRORS,
        404: orders.ORDER_NOT_FOUND,
        409: {"model": ApiError, "description": "Состояние заказа изменилось или уже есть открытое предложение"},
    },
    openapi_extra=multipart_body(),
)
async def create_proposal(order_id: UUID, request: Request, database: Database, session_id: CurrentSession) -> ProposalResult:
    form = await read_ai_form(request)
    revision, context = await run_in_threadpool(load_order_context, database, order_id, session_id, form.text)
    content = await request.app.state.changes_analyzer.analyze(session_id, client_ip(request), context, form.images)
    return await run_in_threadpool(save_draft, database, order_id, session_id, revision, content)


@router.get("/orders/{order_id}/proposals", responses=orders.ITEM_ERRORS)
def list_proposals(order_id: UUID, database: Database, session_id: CurrentSession) -> list[orders.Proposal]:
    with database.connect() as connection:
        query = select(order_table.c.id).where(orders.owned_order(order_id, session_id))
        orders.require_order(connection.execute(query).mappings().one_or_none())
        return orders.order_proposals(connection, order_id)


@router.get(
    "/proposals/{proposal_id}",
    responses=PROPOSAL_ERRORS,
)
def get_proposal(proposal_id: UUID, database: Database, session_id: CurrentSession) -> ProposalDetail:
    query = (
        select(proposals)
        .join(order_table, order_table.c.id == proposals.c.order_id)
        .where(proposals.c.id == proposal_id, order_table.c.session_id == session_id)
    )
    versions_query = (
        select(proposal_versions)
        .where(proposal_versions.c.proposal_id == proposal_id)
        .order_by(proposal_versions.c.version)
    )
    with database.connect().execution_options(isolation_level="REPEATABLE READ") as connection:
        row = connection.execute(query).mappings().one_or_none()
        if row is None:
            raise ApiException(404, "NOT_FOUND", "Предложение не найдено")
        versions = [
            ProposalVersion.model_validate(version)
            for version in connection.execute(versions_query).mappings()
        ]
        return ProposalDetail(proposal=orders.proposal_response(row), versions=versions)


def lock_proposal(connection: Connection, proposal_id: UUID, session_id: UUID) -> ProposalState:
    # All writers lock the parent order first, including order deletion and completion.
    order_query = (
        select(*orders.public_columns)
        .join_from(order_table, proposals, proposals.c.order_id == order_table.c.id)
        .where(proposals.c.id == proposal_id, order_table.c.session_id == session_id)
        .with_for_update(of=order_table)
    )
    order = connection.execute(order_query).mappings().one_or_none()
    if order is None:
        raise ApiException(404, "NOT_FOUND", "Предложение не найдено")
    # Read the proposal after locking the order, so a queued writer sees the latest state.
    proposal = connection.execute(
        select(proposals).where(proposals.c.id == proposal_id).with_for_update()
    ).mappings().one_or_none()
    if proposal is None:
        raise ApiException(404, "NOT_FOUND", "Предложение не найдено")
    version = connection.execute(
        select(proposal_versions).where(proposal_versions.c.id == proposal["current_version_id"])
    ).mappings().one()
    return ProposalState(order, orders.proposal_response(proposal), ProposalVersion.model_validate(version))


def require_version(state: ProposalState, expected_version_id: UUID) -> None:
    if state.version.id != expected_version_id:
        raise ApiException(409, "VERSION_CONFLICT", "Версия предложения изменилась. Откройте актуальную версию")


def require_status(state: ProposalState, *allowed: orders.ProposalStatus) -> None:
    if state.proposal.status not in allowed:
        raise ApiException(409, "INVALID_STATE", "Действие недоступно в текущем статусе предложения")


def require_order_revision(state: ProposalState, expected_revision: int) -> None:
    if state.order["revision"] != expected_revision:
        raise ApiException(409, "ORDER_CHANGED", "Условия заказа изменились. Перепроверьте предложение")


def update_proposal_state(
    connection: Connection, state: ProposalState, version: ProposalVersion, *,
    order_changes: dict | None = None, **changes,
) -> ProposalResult:
    proposal = connection.execute(
        proposals.update()
        .where(proposals.c.id == state.proposal.id)
        .values(updated_at=func.statement_timestamp(), **changes)
        .returning(*proposals.c)
    ).mappings().one()
    connection.execute(
        order_table.update()
        .where(order_table.c.id == state.order["id"])
        .values(updated_at=proposal["updated_at"], **(order_changes or {}))
    )
    return ProposalResult(proposal=orders.proposal_response(proposal), version=version)


def write_draft(
    connection: Connection, state: ProposalState, content: ai.ProposalFields, items: list[ChangeItem], *,
    overwrite: bool,
) -> ProposalResult:
    fields = content.model_dump(include=set(ai.ProposalFields.model_fields))
    fields["items"] = [item.model_dump(mode="json") for item in items]
    fields["base_order_revision"] = state.order["revision"]
    if overwrite:
        query = proposal_versions.update().where(proposal_versions.c.id == state.version.id)
    else:
        query = proposal_versions.insert().values(
            id=uuid4(), proposal_id=state.proposal.id, version=state.version.version + 1, author="freelancer",
        )
    row = connection.execute(query.values(**fields).returning(*proposal_versions.c)).mappings().one()
    version = ProposalVersion.model_validate(row)
    return update_proposal_state(
        connection, state, version, title=version.title, status="draft", current_version_id=version.id,
    )


@router.patch("/proposals/{proposal_id}", responses=ACTION_ERRORS)
def update_proposal(
    proposal_id: UUID, payload: UpdateProposal, database: Database, session_id: CurrentSession,
) -> ProposalResult:
    with database.begin() as connection:
        state = lock_proposal(connection, proposal_id, session_id)
        require_version(state, payload.expected_version_id)
        require_status(state, *OPEN_STATUSES)
        existing_ids = {item.id for item in state.version.items}
        items = []
        for item in payload.content.items:
            if item.id is not None:
                if item.id not in existing_ids:
                    raise ApiException(422, "VALIDATION_ERROR", "Пункт отсутствует в текущей версии или указан дважды")
                existing_ids.remove(item.id)
            items.append(ChangeItem(id=item.id or uuid4(), **item.model_dump(exclude={"id"})))
        return write_draft(
            connection, state, payload.content, items, overwrite=state.proposal.status == "draft",
        )


def load_revision_context(
    database: Engine, proposal_id: UUID, session_id: UUID, expected_version_id: UUID, text: str,
) -> tuple[ProposalState, dict]:
    with database.begin() as connection:
        state = lock_proposal(connection, proposal_id, session_id)
        require_version(state, expected_version_id)
        require_status(state, *OPEN_STATUSES)
        context = order_context(connection, state.order, text)
        context["currentVersion"] = state.version.model_dump(mode="json", by_alias=True)
        return state, context


def save_revision(
    database: Engine, session_id: UUID, previous: ProposalState, content: ai.RevisedProposal,
) -> ProposalResult:
    items = [
        ChangeItem(id=item.id or uuid4(), **item.model_dump(include=set(ai.ChangeContent.model_fields)))
        for item in content.items
    ]
    with database.begin() as connection:
        state = lock_proposal(connection, previous.proposal.id, session_id)
        require_version(state, previous.version.id)
        require_status(state, *OPEN_STATUSES)
        require_order_revision(state, previous.order["revision"])
        if state.proposal != previous.proposal or state.version != previous.version:
            raise ApiException(409, "VERSION_CONFLICT", "Предложение изменилось во время анализа. Повторите доработку")
        return write_draft(connection, state, content, items, overwrite=False)


@router.post(
    "/proposals/{proposal_id}/revise",
    responses={**ACTION_ERRORS, **ai.AI_ERRORS, **FORM_ERRORS},
    openapi_extra=multipart_body("expectedVersionId", required=True),
)
async def revise_proposal(
    proposal_id: UUID, request: Request, database: Database, session_id: CurrentSession,
) -> ProposalResult:
    form = await read_ai_form(request, "expectedVersionId", required=True)
    previous, context = await run_in_threadpool(
        load_revision_context, database, proposal_id, session_id, form.extra_id, form.text,
    )
    content = await request.app.state.changes_analyzer.revise(session_id, client_ip(request), context, form.images)
    return await run_in_threadpool(save_revision, database, session_id, previous, content)


@router.post("/proposals/{proposal_id}/publish", responses=ACTION_ERRORS)
def publish_proposal(
    proposal_id: UUID, payload: PublishProposal, database: Database, session_id: CurrentSession,
) -> ProposalResult:
    with database.begin() as connection:
        state = lock_proposal(connection, proposal_id, session_id)
        require_version(state, payload.expected_version_id)
        if payload.format == "link":
            raise ApiException(503, "SERVICE_UNAVAILABLE", "Этот формат пока недоступен. Выберите текст или Markdown")
        if state.proposal.status == "pending" and state.proposal.published_version_id == state.version.id:
            return state.result()
        require_status(state, "draft")
        return update_proposal_state(
            connection, state, state.version, status="pending", published_version_id=state.version.id,
        )


@router.post("/proposals/{proposal_id}/approve", responses=ACTION_ERRORS)
def approve_proposal(
    proposal_id: UUID, payload: VersionAction, database: Database, session_id: CurrentSession,
) -> ProposalResult:
    with database.begin() as connection:
        state = lock_proposal(connection, proposal_id, session_id)
        require_version(state, payload.expected_version_id)
        if state.proposal.status == "approved" and state.proposal.approved_version_id == state.version.id:
            return state.result()
        require_status(state, "pending", "countered")
        require_order_revision(state, state.version.base_order_revision)
        order_changes = {"revision": state.order["revision"] + 1}
        if state.version.deadline is not None:
            order_changes["deadline"] = state.version.deadline
        return update_proposal_state(
            connection, state, state.version, order_changes=order_changes,
            status="approved", approved_version_id=state.version.id,
        )


@router.post("/proposals/{proposal_id}/reject", responses=ACTION_ERRORS)
def reject_proposal(
    proposal_id: UUID, payload: VersionAction, database: Database, session_id: CurrentSession,
) -> ProposalResult:
    with database.begin() as connection:
        state = lock_proposal(connection, proposal_id, session_id)
        require_version(state, payload.expected_version_id)
        require_status(state, *OPEN_STATUSES)
        return update_proposal_state(connection, state, state.version, status="rejected")


@router.delete("/proposals/{proposal_id}", status_code=204, responses=ACTION_ERRORS)
def delete_proposal(proposal_id: UUID, database: Database, session_id: CurrentSession) -> Response:
    with database.begin() as connection:
        state = lock_proposal(connection, proposal_id, session_id)
        require_status(state, "draft")
        if state.proposal.published_version_id is not None:
            raise ApiException(409, "INVALID_STATE", "Нельзя удалить предложение с опубликованной версией")
        connection.execute(proposals.delete().where(proposals.c.id == proposal_id))
        connection.execute(
            order_table.update().where(order_table.c.id == state.order["id"]).values(updated_at=func.statement_timestamp())
        )
    return Response(status_code=204)
