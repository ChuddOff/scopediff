import re
from pathlib import Path
from secrets import token_urlsafe
from typing import Annotated, Literal
from urllib.parse import urlsplit
from uuid import UUID, uuid4

from fastapi import APIRouter, Body, Request
from fastapi.responses import HTMLResponse
from jinja2 import Environment, FileSystemLoader, select_autoescape
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.engine import Connection
from starlette.datastructures import MutableHeaders
from starlette.requests import ClientDisconnect
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app import ai, orders
from app.db import Database
from app.errors import SERVICE_UNAVAILABLE, VALIDATION_ERROR, ApiError, ApiException
from app.models import orders as order_table
from app.models import proposal_versions, proposals
from app.proposals import (
    ChangeItem, ProposalState, ProposalVersion, VersionAction, apply_approval, lock_matching_proposal,
    require_order_revision, require_status, require_version, update_proposal_state,
)
from app.public_links import public_api_base_url
from app.sessions import RateLimiter, client_ip

router = APIRouter(tags=["Public approval"])
token_pattern = re.compile(r"[A-Za-z0-9_-]{43}")
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
PUBLIC_HEADERS = {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow",
    "X-Content-Type-Options": "nosniff",
}
PUBLIC_ERRORS = {
    404: {"model": ApiError, "description": "Ссылка недоступна"},
    429: {"model": ApiError, "description": "Слишком много запросов"},
    503: SERVICE_UNAVAILABLE,
}
templates = Environment(
    loader=FileSystemLoader(Path(__file__).with_name("templates")), autoescape=select_autoescape(),
)
templates.filters["money"] = lambda price: f"{price:,}".replace(",", "\u00a0") + "\u00a0₽"


class PublicRequestMiddleware:
    def __init__(self, app: ASGIApp):
        self.app = app
        message = "Слишком много запросов. Попробуйте позже"
        self.read_limit = RateLimiter(240, 60, message)
        self.write_limit = RateLimiter(30, 60, message)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not scope["path"].startswith(("/share/", "/api/v1/public/")):
            await self.app(scope, receive, send)
            return

        async def send_protected(message: Message) -> None:
            if message["type"] == "http.response.start":
                MutableHeaders(scope=message).update(PUBLIC_HEADERS)
            await send(message)

        request = Request(scope, receive)
        try:
            if request.method == "POST":
                self.write_limit.check(client_ip(request))
                check_public_write(request)
                body = bytearray()
                async for chunk in request.stream():
                    if len(body) + len(chunk) > MAX_RESPONSE_BYTES:
                        raise ApiException(413, "VALIDATION_ERROR", "Ответ слишком большой")
                    body.extend(chunk)

                async def buffered_receive() -> Message:
                    content = bytes(body)
                    body.clear()
                    return {"type": "http.request", "body": content, "more_body": False}

                receive = buffered_receive
            else:
                self.read_limit.check(client_ip(request))
        except ApiException as error:
            await error.response()(scope, receive, send_protected)
            return
        except ClientDisconnect:
            return
        await self.app(scope, receive, send_protected)


def check_public_write(request: Request) -> None:
    base = public_api_base_url()
    if base is None:
        raise link_not_found()
    origin = urlsplit(base)
    authority = origin.netloc.lower()
    if origin.port == 443:
        authority = authority.removesuffix(":443")
    if request.headers.getlist("origin") != [f"{origin.scheme}://{authority}"]:
        raise ApiException(403, "FORBIDDEN", "Откройте предложение по исходной ссылке")
    types = request.headers.getlist("content-type")
    if len(types) != 1 or types[0].split(";", 1)[0].strip().lower() != "application/json":
        raise ApiException(415, "VALIDATION_ERROR", "Ожидается запрос в формате JSON")


class PublicItemInput(BaseModel):
    model_config = orders.INPUT_CONFIG

    id: UUID | None
    title: ai.NonBlankTitle
    description: orders.OrderText
    price: ai.Rubles | None


class PublicItem(PublicItemInput):
    id: UUID


class PublicProposal(BaseModel):
    model_config = orders.INPUT_CONFIG

    title: str
    order_title: str
    version_id: UUID
    version: int
    status: orders.ProposalStatus | Literal["editing"]
    items: list[PublicItem]
    deadline: orders.DateOnly | None
    conditions: str
    comment: str | None
    can_respond: bool


class PublicCounterContent(BaseModel):
    model_config = orders.INPUT_CONFIG

    items: list[PublicItemInput]
    deadline: orders.DateOnly | None
    conditions: orders.OrderText
    comment: orders.OrderText | None


class PublicApproval(VersionAction):
    action: Literal["approve"]


class PublicCounter(VersionAction):
    action: Literal["counter"]
    content: PublicCounterContent


def link_not_found() -> ApiException:
    return ApiException(404, "NOT_FOUND", "Ссылка недоступна")


def token_filter(token: str):
    if not token_pattern.fullmatch(token) or public_api_base_url() is None:
        raise link_not_found()
    return proposals.c.share_token == token


def public_document(order_title: str, version: ProposalVersion, status: orders.ProposalStatus | Literal["editing"]):
    return PublicProposal(
        title=version.title, orderTitle=order_title, versionId=version.id, version=version.version, status=status,
        items=[
            PublicItem(id=item.id, title=item.title, description=item.description, price=item.price)
            for item in version.items
        ],
        deadline=version.deadline, conditions=version.conditions, comment=version.comment, canRespond=status == "pending",
    )


def read_public(token: str, database: Database) -> PublicProposal:
    query = (
        select(proposals, order_table.c.title.label("order_title"))
        .join(order_table, order_table.c.id == proposals.c.order_id)
        .where(token_filter(token))
    )
    with database.connect().execution_options(isolation_level="REPEATABLE READ") as connection:
        proposal = connection.execute(query).mappings().one_or_none()
        if proposal is None:
            raise link_not_found()
        status = "editing" if proposal["status"] == "draft" else proposal["status"]
        published = proposal["published_version_id"]
        version_id = published if status in ("pending", "editing") else proposal["current_version_id"]
        version = connection.execute(
            select(proposal_versions).where(proposal_versions.c.id == version_id)
        ).mappings().one()
        # Closing a draft must not make its unpublished content public.
        if status == "rejected" and version["author"] == "freelancer" and version_id != published:
            version = connection.execute(
                select(proposal_versions).where(proposal_versions.c.id == published)
            ).mappings().one()
        return public_document(proposal["order_title"], ProposalVersion.model_validate(version), status)


@router.get("/share/{token}", response_class=HTMLResponse, responses={404: {"description": "Ссылка недоступна"}})
def share_page(token: str, database: Database) -> HTMLResponse:
    try:
        document = read_public(token, database)
    except ApiException as error:
        if error.status_code != 404:
            raise
        document = None
    nonce = token_urlsafe(18)
    return HTMLResponse(
        templates.get_template("share.html").render(document=document, nonce=nonce),
        status_code=200 if document else 404,
        headers={"Content-Security-Policy": (
            f"default-src 'none'; script-src 'nonce-{nonce}'; style-src 'nonce-{nonce}'; "
            "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
        )},
    )


@router.get("/api/v1/public/{token}", responses=PUBLIC_ERRORS)
def get_public(token: str, database: Database) -> PublicProposal:
    return read_public(token, database)


def save_counter(connection: Connection, state: ProposalState, content: PublicCounterContent) -> ProposalVersion:
    existing = {item.id: item for item in state.version.items}
    items = []
    for item in content.items:
        prior = None
        if item.id is not None:
            prior = existing.pop(item.id, None)
            if prior is None:
                raise ApiException(422, "VALIDATION_ERROR", "Пункт отсутствует в опубликованной версии или указан дважды")
        unchanged = prior is not None and (item.title, item.description) == (prior.title, prior.description)
        change = ChangeItem(
            id=item.id or uuid4(), title=item.title, description=item.description, price=item.price,
            category=prior.category if unchanged else "unclear", reason=prior.reason if unchanged else "",
        )
        items.append(change.model_dump(mode="json"))
    row = connection.execute(
        proposal_versions.insert().values(
            id=uuid4(), proposal_id=state.proposal.id, version=state.version.version + 1, author="client",
            base_order_revision=state.version.base_order_revision, title=state.version.title, items=items,
            **content.model_dump(exclude={"items"}),
        ).returning(*proposal_versions.c)
    ).mappings().one()
    version = ProposalVersion.model_validate(row)
    return update_proposal_state(
        connection, state, version, status="countered", current_version_id=version.id,
    ).version


@router.post("/api/v1/public/{token}/respond", responses={
    **PUBLIC_ERRORS, 422: VALIDATION_ERROR,
    403: {"model": ApiError, "description": "Источник запроса не совпадает с адресом страницы"},
    409: {"model": ApiError, "description": "Версия, состояние предложения или условия заказа изменились"},
    413: {"model": ApiError, "description": "Превышен размер ответа"},
    415: {"model": ApiError, "description": "Требуется JSON"},
})
def respond(
    token: str, payload: Annotated[PublicApproval | PublicCounter, Body(discriminator="action")], database: Database,
) -> PublicProposal:
    with database.begin() as connection:
        state = lock_matching_proposal(connection, token_filter(token))
        require_version(state, payload.expected_version_id)
        require_status(state, "pending")
        if state.proposal.published_version_id != state.version.id:
            raise ApiException(409, "VERSION_CONFLICT", "Откройте актуальную версию предложения")
        if isinstance(payload, PublicApproval):
            version = apply_approval(connection, state).version
            return public_document(state.order["title"], version, "approved")
        require_order_revision(state, state.version.base_order_revision)
        version = save_counter(connection, state, payload.content)
        return public_document(state.order["title"], version, "countered")
