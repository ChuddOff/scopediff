import hmac
import json
import os
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from hashlib import sha256
from io import BytesIO
from pathlib import Path
from threading import Lock
from uuid import UUID
from xml.sax.saxutils import escape

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel
from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import CondPageBreak, Paragraph, SimpleDocTemplate
from sqlalchemy import select

from app.db import Database
from app.errors import SERVICE_UNAVAILABLE, VALIDATION_ERROR, ApiError, ApiException
from app.models import orders, proposal_versions, proposals
from app.proposals import ProposalVersion
from app.public_links import public_api_base_url
from app.sessions import CurrentSession

router = APIRouter(tags=["PDF"])
LINK_TTL = 600
NOT_FOUND = {"model": ApiError, "description": "Версия или ссылка на PDF недоступна"}
AUTH_ERROR = {"model": ApiError, "description": "Требуется действительный токен сессии"}
DOCUMENT_HEADERS = {"Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer"}
PDF_RESULT = {"content": {"application/pdf": {"schema": {"type": "string", "format": "binary"}}}}

FONT_DIR = Path(__file__).with_name("fonts")
FONT = "GolosText"
BOLD = "GolosTextBold"
pdfmetrics.registerFont(TTFont(FONT, str(FONT_DIR / "golos-text-400.ttf")))
pdfmetrics.registerFont(TTFont(BOLD, str(FONT_DIR / "golos-text-700.ttf")))
# ReportLab's registered TrueType fonts keep mutable document state.
RENDER_LOCK = Lock()

BODY = ParagraphStyle("body", fontName=FONT, fontSize=11, leading=16, textColor=HexColor("#111827"), spaceAfter=7)
TITLE = ParagraphStyle("title", parent=BODY, fontName=BOLD, fontSize=24, leading=30, spaceAfter=12, keepWithNext=True)
META = ParagraphStyle("meta", parent=BODY, fontSize=10, leading=14, textColor=HexColor("#4B5563"))
HEADING = ParagraphStyle("heading", parent=BODY, fontName=BOLD, spaceBefore=12)


class PdfResponse(Response):
    media_type = "application/pdf"


class PdfLink(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, validate_by_name=True)

    url: str
    expires_at: datetime


@dataclass(frozen=True)
class PdfDocument:
    order_title: str
    version: ProposalVersion

    def fingerprint(self) -> str:
        version = self.version
        content = (
            self.order_title, version.title, version.version, version.created_at.isoformat(),
            [(item.title, item.description, item.price) for item in version.items],
            version.deadline.isoformat() if version.deadline else None, version.conditions,
        )
        return sha256(json.dumps(content, ensure_ascii=False).encode()).hexdigest()


@dataclass(frozen=True)
class PdfLinks:
    base_url: str
    key: bytes = field(repr=False)

    @classmethod
    def from_environment(cls) -> "PdfLinks | None":
        base_url = public_api_base_url()
        key = os.getenv("PDF_SIGNING_KEY", "").strip().encode()
        if not os.getenv("PUBLIC_API_BASE_URL", "").strip() or not key:
            return None
        if len(key) < 32 or base_url is None:
            raise ValueError("Set PUBLIC_API_BASE_URL to the HTTPS API base and PDF_SIGNING_KEY to a random secret")
        return cls(base_url, key)

    def sign(self, document: PdfDocument, expires: int) -> str:
        message = f"scopediff-pdf-v1:{document.version.id}:{expires}:{document.fingerprint()}".encode()
        return hmac.new(self.key, message, sha256).hexdigest()


def not_found() -> ApiException:
    return ApiException(404, "NOT_FOUND", "Версия или ссылка на PDF недоступна", DOCUMENT_HEADERS)


def read_document(database: Database, version_id: UUID, session_id: UUID | None = None) -> PdfDocument:
    query = (
        select(proposal_versions, orders.c.title.label("order_title"))
        .join(proposals, proposals.c.id == proposal_versions.c.proposal_id)
        .join(orders, orders.c.id == proposals.c.order_id)
        .where(proposal_versions.c.id == version_id)
    )
    if session_id is not None:
        query = query.where(orders.c.session_id == session_id)
    with database.connect() as connection:
        row = connection.execute(query).mappings().one_or_none()
    if row is None:
        raise not_found()
    version = ProposalVersion.model_validate({column.name: row[column] for column in proposal_versions.c})
    return PdfDocument(row["order_title"], version)


def money(price: int) -> str:
    return f"{price:,}".replace(",", "\u00a0") + "\u00a0₽"


def render_pdf(document: PdfDocument) -> bytes:
    version = document.version
    buffer = BytesIO()
    pdf = SimpleDocTemplate(
        buffer, pagesize=A4, leftMargin=48, rightMargin=48, topMargin=49, bottomMargin=52,
        title=version.title, author="ScopeDiff",
    )
    story = []

    def paragraph(value: str, style: ParagraphStyle = BODY) -> None:
        if value.strip():
            block = Paragraph("<br/>".join(escape(line) for line in value.splitlines()), style)
            if style is HEADING:
                # Reserve space for the first lines without pulling a long paragraph to the next page.
                _, height = block.wrap(pdf.width - 12, pdf.height)
                story.append(CondPageBreak(style.spaceBefore + height + style.spaceAfter + 2 * BODY.leading))
            story.append(block)

    paragraph(version.title, TITLE)
    paragraph(f"Заказ: {document.order_title}", META)
    paragraph(f"Версия {version.version} · {version.created_at:%d.%m.%Y}", META)
    for number, item in enumerate(version.items, 1):
        paragraph(f"{number}. {item.title}", HEADING)
        paragraph(item.description)
        price = money(item.price) if item.price is not None else "не определена"
        paragraph(f"Доплата: {price}")

    prices = [item.price for item in version.items if item.price is not None]
    if len(prices) == len(version.items):
        paragraph(f"Итоговая доплата: {money(sum(prices))}", HEADING)
    else:
        if prices:
            paragraph(f"Известная доплата: {money(sum(prices))}", HEADING)
        paragraph("Итоговая доплата пока не определена.")
    if version.deadline:
        paragraph(f"Новый срок: {version.deadline:%d.%m.%Y}")
    if version.conditions.strip():
        paragraph("Дополнительные условия", HEADING)
        paragraph(version.conditions)

    def footer(canvas, doc):
        canvas.setFillColor(HexColor("#4B5563"))
        canvas.setFont(FONT, 9)
        canvas.drawString(54, 31, "scope.diff")
        canvas.drawRightString(A4[0] - 54, 31, str(doc.page))

    with RENDER_LOCK:
        pdf.build(story, onFirstPage=footer, onLaterPages=footer)
    return buffer.getvalue()


def pdf_response(document: PdfDocument) -> PdfResponse:
    return PdfResponse(render_pdf(document), headers={
        **DOCUMENT_HEADERS,
        "Content-Disposition": f'inline; filename="scopediff-v{document.version.version}.pdf"',
        "X-Content-Type-Options": "nosniff",
    })


@router.get("/versions/{version_id}/pdf", response_class=PdfResponse, responses={
    200: PDF_RESULT, 401: AUTH_ERROR, 404: NOT_FOUND, 422: VALIDATION_ERROR, 503: SERVICE_UNAVAILABLE,
})
def get_pdf(version_id: UUID, database: Database, session_id: CurrentSession) -> PdfResponse:
    return pdf_response(read_document(database, version_id, session_id))


@router.post("/versions/{version_id}/pdf-link", responses={
    401: AUTH_ERROR, 404: NOT_FOUND, 422: VALIDATION_ERROR, 503: SERVICE_UNAVAILABLE,
})
def issue_pdf_link(version_id: UUID, request: Request, response: Response, database: Database, session_id: CurrentSession) -> PdfLink:
    document = read_document(database, version_id, session_id)
    links = request.app.state.pdf_links
    if links is None:
        raise ApiException(503, "SERVICE_UNAVAILABLE", "Временные ссылки на PDF пока недоступны")
    expires = int(datetime.now(timezone.utc).timestamp()) + LINK_TTL
    signature = links.sign(document, expires)
    response.headers.update(DOCUMENT_HEADERS)
    return PdfLink(
        url=f"{links.base_url}/versions/{version_id}/pdf/view?expires={expires}&signature={signature}",
        expires_at=datetime.fromtimestamp(expires, tz=timezone.utc),
    )


@router.get("/versions/{version_id}/pdf/view", response_class=PdfResponse, responses={
    200: PDF_RESULT, 404: NOT_FOUND, 422: VALIDATION_ERROR, 503: SERVICE_UNAVAILABLE,
})
def open_pdf_link(version_id: UUID, request: Request, database: Database, expires: int = 0, signature: str = "") -> PdfResponse:
    links = request.app.state.pdf_links
    if links is None or expires <= datetime.now(timezone.utc).timestamp() or not re.fullmatch(r"[0-9a-f]{64}", signature):
        raise not_found()
    document = read_document(database, version_id)
    if not hmac.compare_digest(signature, links.sign(document, expires)):
        raise not_found()
    return pdf_response(document)
