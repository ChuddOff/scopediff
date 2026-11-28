from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from urllib.parse import urlsplit
from uuid import uuid4

import pytest
from alembic import command
from api_helpers import API, assert_error, auth, issue_token
from fastapi.testclient import TestClient
from test_manual_orders import ORDERS
from test_proposal_drafts import CHANGE, CONTENT, completion, provider
from test_proposal_workflow import action, content_of, draft, patch

from app import main

ORIGIN = "https://scope.example"


@pytest.fixture(autouse=True)
def public_address(monkeypatch):
    monkeypatch.setenv("PUBLIC_API_BASE_URL", ORIGIN + API)
    monkeypatch.delenv("PDF_SIGNING_KEY", raising=False)


def publish(client, headers, path, version):
    response = action(client, path, headers, version["id"], "publish", format="link")
    assert response.status_code == 200
    url = response.json()["proposal"]["shareUrl"]
    assert url.startswith(ORIGIN + "/share/")
    return urlsplit(url).path, f"{API}/public/{url.rsplit('/', 1)[1]}"


def respond(browser, path, version, **fields):
    return browser.post(f"{path}/respond", headers={"Origin": ORIGIN}, json={
        "expectedVersionId": version["id"], **fields,
    })


def test_existing_proposal_link_lifecycle_and_visibility(database_schema, provider):
    calls = provider(completion(dict(CONTENT, items=[
        dict(CHANGE, title="<b>Горизонтальная версия</b>", price=0), dict(CHANGE, title="Субтитры"),
    ])))
    command.upgrade(database_schema, "head")
    with TestClient(main.app) as owner:
        headers = auth(issue_token(owner))
        order, path, v1 = draft(owner, headers, agreements="Закрытые договорённости", completedWork="Закрытые работы")
        assert action(owner, path, headers, v1["id"], "publish", format="pdf").status_code == 200
    command.downgrade(database_schema, "0003_proposal_drafts")
    command.upgrade(database_schema, "head")
    command.check(database_schema)

    with TestClient(main.app) as owner:
        browser = TestClient(main.app)
        foreign = auth(issue_token(owner))
        page, public = publish(owner, headers, path, v1)
        assert publish(owner, headers, path, v1) == (page, public)
        assert len(owner.get(path, headers=headers).json()["versions"]) == 1
        assert_error(action(owner, path, foreign, v1["id"], "revoke-link"), 404, "NOT_FOUND")
        document = browser.get(public).json()
        assert set(document) == {
            "title", "orderTitle", "versionId", "version", "status", "items", "deadline", "conditions", "comment", "canRespond",
        }
        assert set(document["items"][0]) == {"id", "title", "description", "price"}
        assert document["canRespond"] and document["versionId"] == v1["id"]
        assert [item["price"] for item in document["items"]] == [0, None]
        html = browser.get(page)
        assert html.status_code == 200
        assert html.headers["cache-control"] == "no-store"
        assert html.headers["referrer-policy"] == "no-referrer"
        assert "noindex" in html.headers["x-robots-tag"]
        assert "default-src 'none'" in html.headers["content-security-policy"]
        assert "&lt;b&gt;Горизонтальная версия&lt;/b&gt;" in html.text
        assert "<b>Горизонтальная версия</b>" not in html.text
        assert "0\u00a0₽" in html.text and "не определена" in html.text
        assert CHANGE["reason"] not in html.text and "Закрытые" not in html.text

        edited = patch(owner, path, headers, v1["id"], content_of(v1, title="Приватный черновик")).json()["version"]
        editing = browser.get(public).json()
        assert editing["status"] == "editing" and editing["versionId"] == v1["id"]
        assert not editing["canRespond"] and "Приватный черновик" not in browser.get(page).text
        assert_error(respond(browser, public, v1, action="approve"), 409, "VERSION_CONFLICT")
        assert publish(owner, headers, path, edited) == (page, public)
        assert browser.get(public).json()["versionId"] == edited["id"]
        assert_error(respond(browser, public, v1, action="approve"), 409, "VERSION_CONFLICT")
        revoked = action(owner, path, headers, edited["id"], "revoke-link")
        assert revoked.status_code == 200 and revoked.json()["proposal"]["shareUrl"] is None
        assert browser.get(page).status_code == 404
        assert_error(browser.get(public), 404, "NOT_FOUND")
        assert_error(respond(browser, public, edited, action="approve"), 404, "NOT_FOUND")
        new_page, new_public = publish(owner, headers, path, edited)
        assert new_page != page
        hidden = patch(owner, path, headers, edited["id"], content_of(edited, title="Скрытое название")).json()["version"]
        assert action(owner, path, headers, hidden["id"], "reject").status_code == 200
        assert browser.get(new_public).json()["status"] == "rejected"
        assert browser.get(new_public).json()["versionId"] == edited["id"]
        assert "Скрытое название" not in browser.get(new_page).text

    with TestClient(main.app) as restarted:
        assert urlsplit(restarted.get(path, headers=headers).json()["proposal"]["shareUrl"]).path == new_page
        assert restarted.get(f"{ORDERS}/{order['id']}", headers=headers).json()["proposals"][0]["shareUrl"].endswith(new_page)
        assert action(restarted, path, headers, hidden["id"], "revoke-link").json()["proposal"]["shareUrl"] is None
        assert restarted.get(new_page).status_code == 404
    assert len(calls) == 1


def test_structured_counter_preserves_history_and_applies_only_when_accepted(migrated_database, provider):
    original = [CHANGE, dict(CHANGE, title="Субтитры"), dict(CHANGE, title="Титр")]
    calls = provider(completion(dict(CONTENT, items=original)))
    with TestClient(main.app) as owner:
        headers = auth(issue_token(owner))
        order, path, v1 = draft(owner, headers)
        order_path = f"{ORDERS}/{order['id']}"
        page, public = publish(owner, headers, path, v1)
        browser = TestClient(main.app)
        items = browser.get(public).json()["items"]
        counter = {
            "items": [
                dict(items[0], price=750), dict(items[1], description="Два языка"),
                {"id": None, "title": "Анимация", "description": "", "price": 0},
            ],
            "deadline": "2028-03-12", "conditions": "Передать SVG", "comment": "Один раунд",
        }
        for invalid_id in (str(uuid4()), items[0]["id"]):
            invalid = dict(counter, items=[counter["items"][0], dict(counter["items"][1], id=invalid_id)])
            assert_error(respond(browser, public, v1, action="counter", content=invalid), 422, "VALIDATION_ERROR")
        result = respond(browser, public, v1, action="counter", content=counter)
        assert result.status_code == 200
        assert result.json()["status"] == "countered" and not result.json()["canRespond"]
        v2 = owner.get(path, headers=headers).json()["versions"][1]
        assert result.json()["versionId"] == v2["id"] and v2["author"] == "client"
        assert v2["items"][0]["category"] == "extra" and v2["items"][0]["reason"] == CHANGE["reason"]
        assert [(item["category"], item["reason"]) for item in v2["items"][1:]] == [("unclear", ""), ("unclear", "")]
        assert items[2]["id"] not in {item["id"] for item in v2["items"]}
        assert owner.get(order_path, headers=headers).json()["order"]["revision"] == order["revision"]
        assert_error(respond(browser, public, v1, action="approve"), 409, "VERSION_CONFLICT")
        approved = action(owner, path, headers, v2["id"], "approve")
        assert approved.status_code == 200
        assert action(owner, path, headers, v2["id"], "approve").json() == approved.json()
        detail = owner.get(order_path, headers=headers).json()["order"]
        assert detail["revision"] == order["revision"] + 1 and detail["deadline"] == counter["deadline"]
        assert owner.get(path, headers=headers).json()["versions"] == [v1, v2]
        assert browser.get(public).json()["status"] == "approved"
        assert owner.delete(order_path, headers=headers).status_code == 204
        assert browser.get(page).status_code == 404
    assert len(calls) == 1


@pytest.mark.parametrize("second_action", ["respond", "revoke-link"])
def test_concurrent_public_decisions(migrated_database, provider, second_action):
    provider(completion(dict(CONTENT, deadline="2028-03-02")))
    with TestClient(main.app) as owner:
        headers = auth(issue_token(owner))
        order, path, v1 = draft(owner, headers)
        order_path = f"{ORDERS}/{order['id']}"
        _, public = publish(owner, headers, path, v1)
        browser = TestClient(main.app)
        gate = Barrier(2)

        def approve():
            gate.wait(timeout=5)
            return respond(browser, public, v1, action="approve").status_code

        def second():
            if second_action == "respond":
                return approve()
            gate.wait(timeout=5)
            return action(owner, path, headers, v1["id"], second_action).status_code

        with ThreadPoolExecutor(max_workers=2) as executor:
            first = executor.submit(approve)
            other = executor.submit(second)
            first_status, other_status = first.result(), other.result()
        if second_action == "respond":
            assert sorted([first_status, other_status]) == [200, 409]
            assert_error(respond(browser, public, v1, action="approve"), 409, "INVALID_STATE")
        else:
            assert other_status == 200 and first_status in (200, 404)
            assert browser.get(public).status_code == 404
        detail = owner.get(order_path, headers=headers).json()["order"]
        applied = 200 in (first_status, other_status) if second_action == "respond" else first_status == 200
        assert detail["revision"] == order["revision"] + int(applied)
        assert detail["deadline"] == ("2028-03-02" if applied else order["deadline"])
        assert owner.get(path, headers=headers).json()["versions"] == [v1]


def test_public_write_checks_and_context_conflicts(migrated_database, provider):
    provider(completion())
    with TestClient(main.app) as owner:
        headers = auth(issue_token(owner))
        order, path, version = draft(owner, headers)
        _, public = publish(owner, headers, path, version)
        browser = TestClient(main.app, client=("198.51.100.27", 12345))
        url = f"{public}/respond"
        payload = {"expectedVersionId": version["id"], "action": "approve"}
        assert_error(browser.post(url, json=payload), 403, "FORBIDDEN")
        assert_error(browser.post(url, headers={"Origin": "https://other.example"}, json=payload), 403, "FORBIDDEN")
        assert_error(browser.post(url, headers={"Origin": ORIGIN}, data=payload), 415, "VALIDATION_ERROR")
        assert_error(browser.post(
            url, headers={"Origin": ORIGIN, "Content-Type": "application/json"}, content=b" " * (2 * 1024 * 1024 + 1),
        ), 413, "VALIDATION_ERROR")
        order_path = f"{ORDERS}/{order['id']}"
        updated_order = owner.patch(order_path, headers=headers, json={"agreements": "Новые условия"}).json()
        assert_error(respond(browser, public, version, action="approve"), 409, "ORDER_CHANGED")
        assert browser.get(public).json()["canRespond"]
        assert owner.get(order_path, headers=headers).json()["order"] == updated_order
        assert owner.get(path, headers=headers).json()["versions"] == [version]
        for _ in range(25):
            assert_error(respond(browser, public, version, action="approve"), 409, "ORDER_CHANGED")
        limited = respond(browser, public, version, action="approve")
        assert_error(limited, 429, "RATE_LIMITED")
        assert 1 <= int(limited.headers["retry-after"]) <= 60
