from uuid import UUID

from fastapi import APIRouter, Request
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.engine import Engine
from starlette.concurrency import run_in_threadpool

from app import ai, orders, proposals, services
from app.ai_forms import FORM_ERRORS, multipart_body, read_ai_form
from app.db import Database
from app.errors import SERVICE_UNAVAILABLE, VALIDATION_ERROR, ApiError, ApiException
from app.models import services as service_table
from app.sessions import CurrentSession, client_ip

router = APIRouter(
    tags=["AI"],
    responses={
        401: {"model": ApiError, "description": "Требуется действительный токен сессии"},
        **ai.AI_ERRORS,
        503: SERVICE_UNAVAILABLE,
    },
)


class OrderImportResult(BaseModel):
    order: orders.Order
    proposal: orders.Proposal | None
    version: proposals.ProposalVersion | None


def save_services(database: Engine, session_id: UUID, result: ai.ImportedServices) -> list[services.Service]:
    with database.begin() as connection:
        return [services.insert_service(connection, session_id, service) for service in result.services]


@router.post("/services/import", status_code=201, responses=FORM_ERRORS, openapi_extra=multipart_body())
async def import_services(request: Request, database: Database, session_id: CurrentSession) -> list[services.Service]:
    form = await read_ai_form(request)

    def parse(raw: str) -> ai.ImportedServices:
        result = ai.ImportedServices.model_validate_json(raw)
        if any(not service.name.strip() for service in result.services):
            raise ValueError("Blank service name")
        return result

    result = await request.app.state.changes_analyzer.complete(
        session_id, client_ip(request), {"text": form.text}, ai.SERVICE_IMPORT_PROMPT, parse, images=form.images,
    )
    if not result.services:
        raise ApiException(422, "VALIDATION_ERROR", "В исходных данных не найдено услуг")
    return await run_in_threadpool(save_services, database, session_id, result)


def import_service_context(database: Engine, session_id: UUID, service_id: UUID | None) -> dict:
    with database.connect() as connection:
        if service_id is not None:
            query = select(*services.public_columns).where(services.owned_service(service_id, session_id))
            service = services.service_response(connection.execute(query).mappings().one_or_none())
            return {"selectedService": service.model_dump(mode="json")}
        query = (
            select(service_table.c.id, service_table.c.name)
            .where(service_table.c.session_id == session_id)
            .order_by(service_table.c.name, service_table.c.id)
        )
        return {"availableServices": [{"id": str(row.id), "name": row.name} for row in connection.execute(query)]}


def save_order(
    database: Engine, session_id: UUID, service_id: UUID | None, selected_service: dict | None,
    result: ai.ImportedOrder,
) -> OrderImportResult:
    payload = orders.OrderInput(
        title=result.title, serviceId=service_id, agreements=result.agreements,
        completedWork=result.completed_work, deadline=result.deadline,
    )
    with database.begin() as connection:
        order = orders.insert_order(connection, session_id, payload)
        if selected_service and order.service_snapshot != services.Service.model_validate(selected_service):
            raise ApiException(409, "ORDER_CHANGED", "Услуга изменилась во время импорта. Повторите импорт")
        if result.proposal is None:
            return OrderImportResult(order=order, proposal=None, version=None)
        draft = proposals.insert_draft(connection, order.id, order.revision, result.proposal)
        order.updated_at = draft.proposal.updated_at
        return OrderImportResult(order=order, proposal=draft.proposal, version=draft.version)


@router.post(
    "/orders/import",
    status_code=201,
    responses={
        **FORM_ERRORS,
        404: orders.SERVICE_NOT_FOUND,
        409: {"model": ApiError, "description": "Выбранная услуга изменилась во время импорта"},
    },
    openapi_extra=multipart_body("serviceId"),
)
async def import_order(request: Request, database: Database, session_id: CurrentSession) -> OrderImportResult:
    form = await read_ai_form(request, "serviceId")
    context = await run_in_threadpool(import_service_context, database, session_id, form.extra_id)
    selected_service = context.get("selectedService")
    available_ids = {UUID(service["id"]) for service in context.get("availableServices", [])}

    def parse(raw: str) -> ai.ImportedOrder:
        result = ai.ImportedOrder.model_validate_json(raw)
        if form.extra_id is None and result.suggested_service_id is not None and result.suggested_service_id not in available_ids:
            raise ValueError("Unknown service ID")
        if result.proposal is not None and not result.proposal.items:
            raise ValueError("Empty proposal")
        return result

    result = await request.app.state.changes_analyzer.complete(
        session_id, client_ip(request), dict(context, text=form.text), ai.ORDER_IMPORT_PROMPT, parse, images=form.images,
    )
    if result.title is None:
        raise ApiException(422, "VALIDATION_ERROR", "В исходных данных не найден заказ")
    return await run_in_threadpool(
        save_order, database, session_id, form.extra_id or result.suggested_service_id, selected_service, result,
    )


@router.post("/ai/enhance-description", responses={422: VALIDATION_ERROR})
async def enhance_description(
    payload: ai.EnhanceDescriptionInput, request: Request, session_id: CurrentSession,
) -> ai.EnhancedDescription:
    return await request.app.state.changes_analyzer.complete(
        session_id, client_ip(request), payload.model_dump(by_alias=True), ai.ENHANCE_PROMPT,
        ai.EnhancedDescription.model_validate_json,
    )
