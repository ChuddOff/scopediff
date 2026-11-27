import json
from datetime import datetime, timedelta, timezone
from io import BytesIO
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

import httpx2
from api_helpers import API, assert_error, auth, issue_token
from fastapi.testclient import TestClient
from PIL import Image
from pypdf import PdfReader
from sqlalchemy import text
from test_manual_orders import ORDERS, SERVICES, add_service
from test_proposal_drafts import CHANGE, CONTENT, assert_record_counts, completion, provider, submit
from test_proposal_workflow import action, content_of, draft, patch, revise

from app import main, pdf
from app.ai_forms import MAX_FILE

ORDER_AI = {
    "title": "Ролик для кофейни", "suggestedServiceId": None,
    "agreements": "Вертикальный ролик", "completedWork": "Отправлен черновик",
    "deadline": "2026-12-04", "detectedStage": "in_progress", "proposal": None,
}
SERVICES_AI = {"services": [{"name": "Монтаж", "description": "Два раунда"}, {"name": "Дизайн", "description": ""}]}
DICTATION = {"title": "", "currentText": "Один раунд правок.", "dictation": "Добавь сдачу в MP4.", "context": ""}


def test_import_orders_services_and_session_isolation(migrated_database, provider):
    def order_reply(service_id):
        return completion(dict(ORDER_AI, suggestedServiceId=service_id))

    async def suggested_order():
        return order_reply(catalog[0]["id"])

    async def explicit_order():
        return completion(dict(ORDER_AI, suggestedServiceId=catalog[0]["id"], detectedStage="changes_requested", proposal=CONTENT))

    calls = provider(completion(SERVICES_AI), suggested_order, explicit_order, order_reply(str(uuid4())), order_reply(str(uuid4())))
    with TestClient(main.app) as client:
        headers = auth(issue_token(client))
        other = auth(issue_token(client))
        foreign_id = add_service(client, other)["id"]
        imported = submit(client, f"{SERVICES}/import", headers)
        assert imported.status_code == 201
        catalog = imported.json()
        assert [{k: service[k] for k in ("name", "description")} for service in catalog] == SERVICES_AI["services"]
        assert client.get(f"{SERVICES}/{catalog[1]['id']}", headers=headers).json() == catalog[1]
        assert_error(client.get(f"{SERVICES}/{catalog[1]['id']}", headers=other), 404, "NOT_FOUND")

        url = f"{ORDERS}/import"
        rejected = client.post(url, headers=headers, files={"text": (None, "Заказ"), "serviceId": (None, foreign_id)})
        assert_error(rejected, 404, "NOT_FOUND")
        response = submit(client, url, headers)
        assert response.status_code == 201
        plain = response.json()
        assert plain["proposal"] is None and plain["version"] is None
        assert plain["order"]["serviceSnapshot"] == catalog[0]
        response = client.post(
            url, headers=headers, files={"text": (None, "Заказ и правки"), "serviceId": (None, catalog[1]["id"])},
        )
        assert response.status_code == 201
        result = response.json()
        order, proposal, version = result["order"], result["proposal"], result["version"]
        assert order["serviceSnapshot"] == catalog[1]
        assert order["agreements"] == ORDER_AI["agreements"] and order["completedWork"] == ORDER_AI["completedWork"]
        assert proposal["status"] == "draft" and version["version"] == 1 and version["items"][0]["price"] is None
        assert client.get(f"{ORDERS}/{order['id']}", headers=headers).json() == {"order": order, "proposals": [proposal]}
        assert client.get(f"{API}/proposals/{proposal['id']}", headers=headers).json()["versions"] == [version]
        assert_error(client.get(f"{ORDERS}/{order['id']}", headers=other), 404, "NOT_FOUND")
        assert_error(submit(client, url, headers), 502, "AI_FAILED")
        assert len(client.get(ORDERS, headers=headers).json()) == 2
    available = json.loads(calls[1]["messages"][1]["content"])["availableServices"]
    assert {service["id"] for service in available} == {service["id"] for service in catalog}
    assert json.loads(calls[2]["messages"][1]["content"])["selectedService"] == catalog[1]


def test_failed_imports_leave_no_partial_records(migrated_database, provider):
    provider(
        completion(SERVICES_AI), completion(dict(ORDER_AI, detectedStage="changes_requested", proposal=CONTENT)),
        completion({"services": []}), httpx2.Response(503),
    )
    with TestClient(main.app) as client:
        headers = auth(issue_token(client))
        with client.app.state.engine.begin() as connection:
            connection.execute(text("ALTER TABLE services ADD CHECK (name <> 'Дизайн')"))
            connection.execute(text("ALTER TABLE proposal_versions ADD CHECK (version <> 1)"))
        assert_error(submit(client, f"{SERVICES}/import", headers), 503, "SERVICE_UNAVAILABLE")
        assert_error(submit(client, f"{ORDERS}/import", headers), 503, "SERVICE_UNAVAILABLE")
        assert_error(submit(client, f"{SERVICES}/import", headers), 422, "VALIDATION_ERROR")
        assert_error(submit(client, f"{ORDERS}/import", headers), 502, "AI_FAILED")
        assert client.get(SERVICES, headers=headers).json() == []
        assert client.get(ORDERS, headers=headers).json() == []
        assert_record_counts(client, 0)


def test_enhance_description_contract_permissions_and_limits(migrated_database, provider, monkeypatch):
    enhanced = {"text": "Один раунд правок. Сдача в MP4."}
    calls = provider(*[completion(enhanced) for _ in range(4)], httpx2.Response(503))
    monkeypatch.setenv("AI_RATE_LIMIT_PER_SESSION_MINUTE", "5")
    path = f"{API}/ai/enhance-description"
    with TestClient(main.app) as client:
        headers = auth(issue_token(client))
        service = add_service(client, headers, description=DICTATION["currentText"])
        assert_error(client.post(path, json=dict(DICTATION, kind="service")), 401, "UNAUTHORIZED")
        for invalid in (dict(DICTATION, kind="other"), dict(DICTATION, kind="service", dictation="  ")):
            assert_error(client.post(path, headers=headers, json=invalid), 422, "VALIDATION_ERROR")
        for kind in ("service", "order", "change_item", "conditions"):
            payload = dict(DICTATION, kind=kind)
            if kind == "change_item":
                payload["currentText"] = ""
            result = client.post(path, headers=headers, json=payload)
            assert result.status_code == 200 and result.json() == enhanced
        assert client.get(f"{SERVICES}/{service['id']}", headers=headers).json() == service
        assert_error(client.post(path, headers=headers, json=payload), 502, "AI_FAILED")
        limited = client.post(path, headers=headers, json=payload)
        assert_error(limited, 429, "RATE_LIMITED")
        assert int(limited.headers["Retry-After"]) > 0
        assert len(calls) == 5
        assert json.loads(calls[2]["messages"][1]["content"])["currentText"] == ""


def screenshot(format_name="PNG"):
    image = BytesIO()
    Image.new("RGB", (16, 16), "navy").save(image, format=format_name)
    return image.getvalue()


def test_files_only_and_revise_command_preserve_version_history(migrated_database, provider, monkeypatch):
    commands = "Удали второй пункт, за первый поставь 1500 рублей, добавь анимацию при прокрутке"
    original = dict(CONTENT, items=[CHANGE, dict(CHANGE, title="Титр", price=0)], conditions="Два раунда")

    async def revised_command():
        kept, removed = v1["items"]
        return completion(dict(original, items=[
            dict(kept, price=1500, priceEvidence="за первый поставь 1500 рублей"),
            dict(CHANGE, title="Анимация при прокрутке", id=None),
        ], removedItems=[{"id": removed["id"], "evidence": "Удали второй пункт"}]))

    calls = provider(
        completion(SERVICES_AI), completion(ORDER_AI), completion(original),
        completion({"text": commands}), revised_command, completion(CONTENT),
    )
    monkeypatch.setenv("AI_RATE_LIMIT_PER_SESSION_MINUTE", "10")
    with TestClient(main.app) as client:
        headers = auth(issue_token(client))
        images = [
            ("files", ("one", screenshot("PNG"), "application/octet-stream")),
            ("files", ("two", screenshot("JPEG"), "image/jpeg")),
            ("files", ("three", screenshot("WEBP"), "image/webp")),
        ]
        assert client.post(f"{SERVICES}/import", headers=headers, files=images).status_code == 201
        imported = client.post(f"{ORDERS}/import", headers=headers, files=images[:1])
        assert imported.status_code == 201
        order_path = f"{ORDERS}/{imported.json()['order']['id']}"
        response = client.post(f"{order_path}/proposals", headers=headers, files=images[:1])
        assert response.status_code == 201
        v1 = response.json()["version"]
        path = f"{API}/proposals/{v1['proposalId']}"
        response = client.post(f"{path}/revise", headers=headers, files=images[:1] + [("expectedVersionId", (None, v1["id"]))])
        assert response.status_code == 200
        v2 = response.json()["version"]
        assert v2["version"] == 2 and v2["conditions"] == v1["conditions"]
        assert v2["items"][0] == dict(v1["items"][0], price=1500)
        assert v2["items"][1]["id"] not in {item["id"] for item in v1["items"]}
        assert v2["items"][1]["title"] == "Анимация при прокрутке" and v2["items"][1]["price"] is None
        assert client.get(path, headers=headers).json()["versions"] == [v1, v2]
        assert_error(revise(client, path, headers, v1["id"], commands), 409, "VERSION_CONFLICT")
        assert action(client, path, headers, v2["id"], "publish", format="text").status_code == 200
        assert action(client, path, headers, v2["id"], "approve").status_code == 200
        assert submit(client, f"{order_path}/proposals", headers).status_code == 201
    parts = calls[0]["messages"][1]["content"]
    assert [part["image_url"]["url"].split(";")[0] for part in parts[1:]] == ["data:image/png", "data:image/jpeg", "data:image/webp"]
    assert all(calls[i]["messages"][1]["content"][1]["type"] == "image_url" for i in (1, 2, 3))
    assert json.loads(calls[4]["messages"][1]["content"])["screenshotText"] == commands


def test_screenshot_limits_and_corrupt_image(migrated_database, provider):
    calls = provider(completion(SERVICES_AI))
    png = screenshot()
    boundary_size_image = ("files", ("exact.png", png.ljust(MAX_FILE, b"\0"), "application/octet-stream"))
    with TestClient(main.app) as client:
        headers = auth(issue_token(client))
        path = f"{SERVICES}/import"
        assert client.post(path, headers=headers, files=[boundary_size_image] * 3).status_code == 201
        assert_error(client.post(path, headers=headers, files=[("files", ("image.png", png))] * 4), 413, "FILE_TOO_LARGE")
        oversized = {"files": ("image.png", png.ljust(MAX_FILE + 1, b"\0"))}
        assert_error(client.post(path, headers=headers, files=oversized), 413, "FILE_TOO_LARGE")
        assert_error(client.post(path, headers=headers, files={"files": ("image.png", png[:40])}), 400, "BAD_INPUT")
    assert len(calls) == 1


def test_pdf_download_signed_access_and_draft_publication(migrated_database, provider, monkeypatch):
    provider(completion())
    monkeypatch.setenv("PUBLIC_API_BASE_URL", "https://scope.test/api/v1")
    monkeypatch.setenv("PDF_SIGNING_KEY", "test-only-pdf-signing-key-for-integration")
    with TestClient(main.app) as client:
        owner = auth(issue_token(client))
        other = auth(issue_token(client))
        order, proposal_path, version = draft(client, owner, title="Кириллица и переносы")
        version_path = f"{API}/versions/{version['id']}"
        content = content_of(version, conditions="Сдать в MP4.\nПредусмотреть два раунда.", comment="Скрытый комментарий")
        content["items"].append(dict(CHANGE, id=None, title="Титры", description=("Длинная строка с пробелами. " * 380), price=0))
        version = patch(client, proposal_path, owner, version["id"], content).json()["version"]

        assert_error(client.get(f"{version_path}/pdf"), 401, "UNAUTHORIZED")
        assert_error(client.get(f"{version_path}/pdf", headers=other), 404, "NOT_FOUND")
        assert_error(client.post(f"{version_path}/pdf-link", headers=other), 404, "NOT_FOUND")
        response = client.post(f"{version_path}/pdf-link", headers=owner)
        assert response.status_code == 200
        url = urlsplit(response.json()["url"])
        expires = datetime.fromisoformat(response.json()["expiresAt"])
        assert url.scheme == "https" and expires.utcoffset() == timedelta(0)
        assert 595 < (expires - datetime.now(timezone.utc)).total_seconds() <= 600

        signed = f"{url.path}?{url.query}"
        parameters = {key: values[0] for key, values in parse_qs(url.query).items()}
        original = parameters["signature"]
        altered = ("1" if original[0] == "0" else "0") + original[1:]
        assert_error(client.get(url.path, params=dict(parameters, signature=altered)), 404, "NOT_FOUND")
        wrong_version = url.path.replace(version["id"], str(uuid4()))
        assert_error(client.get(wrong_version, params=parameters), 404, "NOT_FOUND")

        newer = dict(content, conditions=content["conditions"] + "\nНужны исходники.")
        version = patch(client, proposal_path, owner, version["id"], newer).json()["version"]
        assert_error(client.get(signed), 404, "NOT_FOUND")
        url = urlsplit(client.post(f"{version_path}/pdf-link", headers=owner).json()["url"])
        signed = f"{url.path}?{url.query}"
        published = action(client, proposal_path, owner, version["id"], "publish", format="pdf")
        assert published.status_code == 200 and published.json()["proposal"]["status"] == "pending"
        assert action(client, proposal_path, owner, version["id"], "publish", format="pdf").json() == published.json()

        for response in (client.get(signed), client.get(f"{version_path}/pdf", headers=owner)):
            assert response.status_code == 200 and response.headers["Content-Type"] == "application/pdf"
            assert response.headers["Content-Disposition"] == 'inline; filename="scopediff-v1.pdf"'
            assert response.headers["Cache-Control"] == "private, no-store"
            pages = PdfReader(BytesIO(response.content)).pages
            assert len(pages) > 1
            assert "Длинная строка с пробелами." in pages[0].extract_text()
            extracted = " ".join("\n".join(page.extract_text() for page in pages).split())
            for expected in (order["title"], "Версия 1", "Доплата: 0 ₽", "Доплата: не определена", "Сдать в MP4.", "Нужны исходники."):
                assert expected in extracted
            assert "Скрытый комментарий" not in extracted and CHANGE["reason"] not in extracted

        class AfterExpiration(datetime):
            @classmethod
            def now(cls, tz=None):
                return expires + timedelta(seconds=5)

        monkeypatch.setattr(pdf, "datetime", AfterExpiration)
        assert_error(client.get(signed), 404, "NOT_FOUND")
