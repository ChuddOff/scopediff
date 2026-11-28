import json
from concurrent.futures import ThreadPoolExecutor
from threading import Event
from uuid import UUID, uuid4

import anyio
import httpx2
import pytest
from alembic import command
from api_helpers import API, assert_error, auth, issue_token
from fastapi.testclient import TestClient
from openai import AsyncOpenAI
from sqlalchemy import func, select, text
from test_manual_orders import ORDERS, add_order, add_service

from app import ai, main
from app.db import create_database_engine
from app.models import proposal_versions, proposals

REQUESTED = "Нужна ещё горизонтальная версия"
CHANGE = {
    "title": "Горизонтальный ролик",
    "description": "Версия 16:9",
    "category": "extra",
    "reason": "Согласован только вертикальный формат",
    "price": None,
}
CONTENT = {"title": "Предложение по изменениям", "items": [CHANGE], "deadline": None, "conditions": "", "comment": None}


def completion(content=CONTENT, *, finish_reason="stop"):
    return httpx2.Response(200, json={
        "id": "synthetic-completion", "model": ai.MODEL, "created": 1, "object": "chat.completion",
        "choices": [{
            "index": 0, "message": {"role": "assistant", "content": json.dumps(content) if isinstance(content, dict) else content},
            "finish_reason": finish_reason,
        }],
    })


@pytest.fixture
def provider(monkeypatch):
    calls = []

    def install(*replies):
        async def handle(request):
            assert request.url == f"{ai.BASE_URL}/chat/completions"
            calls.append(json.loads(request.content))
            reply = replies[len(calls) - 1]
            return await reply() if callable(reply) else reply

        monkeypatch.setattr(ai, "create_deepseek_client", lambda timeout: AsyncOpenAI(
            base_url=ai.BASE_URL, api_key="test-only", timeout=timeout, max_retries=0,
            http_client=httpx2.AsyncClient(transport=httpx2.MockTransport(handle)),
        ))
        return calls

    for key in (
        "AI_TIMEOUT_SECONDS", "AI_RATE_LIMIT_PER_SESSION_MINUTE", "AI_RATE_LIMIT_PER_SESSION_DAY",
        "AI_RATE_LIMIT_PER_IP_HOUR", "AI_RATE_LIMIT_GLOBAL_DAY", "AI_MAX_CONCURRENT_PER_SESSION",
    ):
        monkeypatch.delenv(key, raising=False)
    return install


def submit(client, path, headers, changes=REQUESTED):
    return client.post(path, headers=headers, files={"text": (None, changes)})


def assert_record_counts(client, count):
    with client.app.state.engine.connect() as connection:
        for table in (proposals, proposal_versions):
            assert connection.scalar(select(func.count()).select_from(table)) == count


def test_upgrade_existing_orders_create_read_restart_and_delete(database_schema, provider):
    items = [
        CHANGE,
        dict(CHANGE, title="Исправление титра", category="included", price=0),
        dict(CHANGE, title="Анимация", category="unclear", price=1500),
    ]
    calls = provider(completion(dict(CONTENT, items=items, deadline="2028-02-29")))
    command.upgrade(database_schema, "0002_manual_orders")
    with TestClient(main.app) as client:
        headers = auth(issue_token(client))
        service = add_service(client, headers, description="В шаблоне любые форматы")
        order = add_order(
            client, headers, serviceId=service["id"], agreements="Только вертикальный ролик",
            completedWork="Вертикальный ролик отправлен", deadline="2026-12-02",
        )
        assert client.delete(f"{API}/services/{service['id']}", headers=headers).status_code == 204

    command.upgrade(database_schema, "head")
    command.upgrade(database_schema, "head")
    command.check(database_schema)
    order_path = f"{ORDERS}/{order['id']}"
    list_path = f"{order_path}/proposals"
    with TestClient(main.app) as client:
        assert client.get(list_path, headers=headers).json() == []
        assert client.get(order_path, headers=headers).json()["order"]["serviceSnapshot"] == service
        response = submit(client, list_path, headers, "  " + REQUESTED + " ")
        assert response.status_code == 201, response.text
        assert response.json().keys() == {"proposal", "version"}
        proposal, version = (response.json()[key] for key in ("proposal", "version"))
        assert proposal["orderId"] == order["id"]
        assert proposal["currentVersionId"] == version["id"]
        assert proposal["publishedVersionId"] is proposal["approvedVersionId"] is proposal["shareUrl"] is None
        assert proposal["status"] == "draft"
        assert version["version"] == 1 and version["author"] == "freelancer"
        assert version["proposalId"] == proposal["id"]
        assert version["baseOrderRevision"] == order["revision"]
        assert version["deadline"] == "2028-02-29"
        assert [dict((key, value) for key, value in item.items() if key != "id") for item in version["items"]] == items
        ids = [proposal["id"], version["id"], *(item["id"] for item in version["items"])]
        assert len(set(ids)) == len(ids) and all(UUID(value).version == 4 for value in ids)
        proposal_path = f"{API}/proposals/{proposal['id']}"
        saved_order = client.get(order_path, headers=headers).json()
        assert saved_order["proposals"] == [proposal]
        assert saved_order["order"]["deadline"] == order["deadline"]
        assert saved_order["order"]["revision"] == order["revision"]
        assert client.get(ORDERS, headers=headers).json()[0]["openProposalStatus"] == "draft"
        assert_error(client.patch(order_path, json={"status": "completed"}, headers=headers), 409, "OPEN_PROPOSAL_EXISTS")
        assert_error(submit(client, list_path, headers), 409, "OPEN_PROPOSAL_EXISTS")

        other_headers = auth(issue_token(client))
        for path in (list_path, proposal_path):
            assert_error(client.get(path), 401, "UNAUTHORIZED")
            assert_error(client.get(path, headers=other_headers), 404, "NOT_FOUND")
        assert_error(submit(client, list_path, {}), 401, "UNAUTHORIZED")
        assert_error(submit(client, list_path, other_headers), 404, "NOT_FOUND")

    assert len(calls) == 1
    request = calls[0]
    assert request["model"] == ai.MODEL and request["max_tokens"] == 4096
    assert request["response_format"] == {"type": "json_object"} and request["thinking"] == {"type": "disabled"}
    assert request["messages"][0]["role"] == "system"
    assert json.loads(request["messages"][1]["content"]) == {
        "serviceSnapshot": service,
        "agreements": order["agreements"],
        "completedWork": order["completedWork"],
        "deadline": order["deadline"],
        "approvedVersions": [],
        "requestedChanges": REQUESTED,
    }

    with TestClient(main.app) as client:
        assert client.get(order_path, headers=headers).json() == saved_order
        assert client.get(list_path, headers=headers).json() == [proposal]
        assert client.get(proposal_path, headers=headers).json() == {"proposal": proposal, "versions": [version]}
        assert client.delete(order_path, headers=headers).status_code == 204
        assert_error(client.get(proposal_path, headers=headers), 404, "NOT_FOUND")
        assert_record_counts(client, 0)


def test_invalid_multipart_and_completed_order(migrated_database, provider):
    calls = provider()
    with TestClient(main.app) as client:
        headers = auth(issue_token(client))
        path = f"{ORDERS}/{add_order(client, headers)['id']}"
        url = f"{path}/proposals"
        assert_error(client.post(url, headers=headers, json={"text": REQUESTED}), 400, "BAD_INPUT")
        for files in (
            {"files": ("image.png", b"synthetic", "image/png")},
            {"text": (None, REQUESTED), "files": ("image.png", b"synthetic", "image/png")},
            {"expectedVersionId": (None, str(uuid4()))},
        ):
            response = client.post(url, headers=headers, files=files)
            assert_error(response, 400, "BAD_INPUT")
        malformed = {"Content-Type": "multipart/form-data; boundary=invalid", **headers}
        assert_error(client.post(url, headers=malformed, content=b"garbage"), 400, "BAD_INPUT")
        for invalid in ("", " \n ", "т" * 12001, "строка\x00"):
            assert_error(submit(client, url, headers, invalid), 422, "VALIDATION_ERROR")
        assert client.patch(path, headers=headers, json={"status": "completed"}).status_code == 200
        assert_error(submit(client, url, headers), 409, "INVALID_STATE")
        assert_record_counts(client, 0)
    assert calls == []


@pytest.mark.parametrize("invalid", [
    {"items": [dict(CHANGE, price=value)]} for value in (-1, 1.5, 1.0, "150", True)
] + [
    {"items": [dict(CHANGE, category="approved")]},
    {"items": [dict(CHANGE, id=str(uuid4()))]},
    {"items": [dict(CHANGE, title="   ")]},
    {"deadline": "2026-02-29"},
    {"deadline": "2026-12-01T18:00:00Z"},
])
def test_validate_provider_content(invalid):
    with pytest.raises(ValueError):
        ai.AnalyzedProposal.model_validate_json(json.dumps(dict(CONTENT, **invalid)))


def test_retry_empty_and_provider_errors_are_atomic(migrated_database, provider):
    calls = provider(
        completion("bad-json"), completion(dict(CONTENT, items=[])),
        completion(""), completion(dict(CONTENT, deadline="2026-13-40")),
        httpx2.Response(429, json={"error": {"message": "private-provider-detail"}}),
        completion(" ", finish_reason="length"), completion(),
    )
    with TestClient(main.app) as client:
        headers = auth(issue_token(client))
        url = f"{ORDERS}/{add_order(client, headers)['id']}/proposals"
        assert_error(submit(client, url, headers), 422, "VALIDATION_ERROR")
        assert_record_counts(client, 0)
        assert_error(submit(client, url, headers), 502, "AI_FAILED")
        assert_record_counts(client, 0)
        failed = submit(client, url, headers)
        assert_error(failed, 502, "AI_FAILED")
        assert "private-provider-detail" not in failed.text
        assert_record_counts(client, 0)
        another_session = auth(issue_token(client))
        another_order = f"{ORDERS}/{add_order(client, another_session)['id']}/proposals"
        assert submit(client, another_order, another_session).status_code == 201
        assert_record_counts(client, 1)
    assert len(calls) == 7


def test_every_attempt_is_counted(migrated_database, provider, monkeypatch):
    calls = provider(completion("invalid"))
    monkeypatch.setenv("AI_RATE_LIMIT_PER_SESSION_MINUTE", "1")
    with TestClient(main.app) as client:
        headers = auth(issue_token(client))
        url = f"{ORDERS}/{add_order(client, headers)['id']}/proposals"
        response = submit(client, url, headers)
        assert_error(response, 429, "RATE_LIMITED")
        assert 0 < int(response.headers["retry-after"]) <= 60
        assert_record_counts(client, 0)
    assert len(calls) == 1


@pytest.mark.parametrize(("setting", "same_session", "same_ip", "window"), [
    ("AI_RATE_LIMIT_PER_SESSION_MINUTE", True, False, 60),
    ("AI_RATE_LIMIT_PER_SESSION_DAY", True, False, 86400),
    ("AI_RATE_LIMIT_PER_IP_HOUR", False, True, 3600),
    ("AI_RATE_LIMIT_GLOBAL_DAY", False, False, 86400),
])
def test_rolling_rate_windows(monkeypatch, setting, same_session, same_ip, window):
    now = 0
    monkeypatch.setattr(ai, "monotonic", lambda: now)
    monkeypatch.setenv(setting, "1")
    limiter = ai.AiRateLimiter()
    session_id = uuid4()
    limiter.record_attempt(session_id, "127.0.0.1")
    other_id = session_id if same_session else uuid4()
    other_ip = "127.0.0.1" if same_ip else "127.0.0.2"
    with pytest.raises(ai.ApiException) as raised:
        limiter.record_attempt(other_id, other_ip)
    assert raised.value.status_code == 429
    assert raised.value.headers["Retry-After"] == str(window)
    now = window
    limiter.record_attempt(other_id, other_ip)


def test_timeout_applies_across_attempts(migrated_database, provider, monkeypatch):
    async def slow_invalid():
        await anyio.sleep(0.04)
        return completion("invalid")

    async def no_response():
        await anyio.sleep_forever()

    calls = provider(slow_invalid, no_response, completion())
    monkeypatch.setenv("AI_TIMEOUT_SECONDS", "0.15")
    monkeypatch.setenv("AI_MAX_CONCURRENT_PER_SESSION", "1")
    with TestClient(main.app) as client:
        headers = auth(issue_token(client))
        url = f"{ORDERS}/{add_order(client, headers)['id']}/proposals"
        assert_error(submit(client, url, headers), 502, "AI_FAILED")
        assert_record_counts(client, 0)
        assert submit(client, url, headers).status_code == 201
    assert len(calls) == 3


def test_version_write_failure_rolls_back_proposal_and_order(migrated_database, provider):
    calls = provider(completion())
    with TestClient(main.app) as client:
        headers = auth(issue_token(client))
        order = add_order(client, headers)
        path = f"{ORDERS}/{order['id']}"
        with client.app.state.engine.begin() as connection:
            connection.execute(text("ALTER TABLE proposal_versions ADD CONSTRAINT force_write_failure CHECK (FALSE)"))
        assert_error(submit(client, f"{path}/proposals", headers), 503, "SERVICE_UNAVAILABLE")
        assert_record_counts(client, 0)
        assert client.get(path, headers=headers).json() == {"order": order, "proposals": []}
    assert len(calls) == 1


def test_approved_versions_are_passed_in_order(migrated_database, provider):
    calls = provider(
        completion(dict(CONTENT, title="Первое согласование", conditions="Добавили 16:9")),
        completion(dict(CONTENT, title="Второе согласование", conditions="Добавили 1:1")),
        completion(),
    )
    with TestClient(main.app) as client:
        headers = auth(issue_token(client))
        url = f"{ORDERS}/{add_order(client, headers)['id']}/proposals"
        for _ in range(2):
            response = submit(client, url, headers)
            assert response.status_code == 201
            proposal = response.json()["proposal"]
            with client.app.state.engine.begin() as connection:
                connection.execute(
                    proposals.update().where(proposals.c.id == UUID(proposal["id"])).values(
                        status="approved", approved_version_id=UUID(proposal["currentVersionId"]),
                    )
                )
        assert submit(client, url, headers).status_code == 201
        listed = client.get(url, headers=headers).json()
        assert [proposal["status"] for proposal in listed] == ["draft", "approved", "approved"]

    context = json.loads(calls[2]["messages"][1]["content"])
    approved = context["approvedVersions"]
    assert [version["conditions"] for version in approved] == ["Добавили 16:9", "Добавили 1:1"]
    assert approved[0]["items"] == [{"title": CHANGE["title"], "description": CHANGE["description"], "price": None}]


@pytest.mark.parametrize(("patch", "code"), [
    ({"agreements": "Уже согласованы оба формата"}, "ORDER_CHANGED"),
    ({"status": "completed"}, "INVALID_STATE"),
])
def test_order_changes_while_provider_waits(migrated_database, provider, patch, code):
    started, release = Event(), Event()

    async def paused():
        started.set()
        assert await anyio.to_thread.run_sync(release.wait, 5)
        return completion()

    provider(paused)
    with TestClient(main.app) as client, ThreadPoolExecutor(max_workers=1) as workers:
        headers = auth(issue_token(client))
        path = f"{ORDERS}/{add_order(client, headers)['id']}"
        pending = workers.submit(submit, client, f"{path}/proposals", headers)
        try:
            assert started.wait(5)
            assert client.app.state.engine.pool.checkedout() == 0
            assert client.patch(path, headers=headers, json=patch).status_code == 200
        finally:
            release.set()
        assert_error(pending.result(timeout=5), 409, code)
        assert_record_counts(client, 0)


def test_concurrent_creation_and_session_concurrency_limit(migrated_database, provider):
    started, release = Event(), Event()
    entered = 0

    async def paused():
        nonlocal entered
        entered += 1
        if entered == 2:
            started.set()
        assert await anyio.to_thread.run_sync(release.wait, 5)
        return completion()

    calls = provider(paused, paused)
    with TestClient(main.app) as client, ThreadPoolExecutor(max_workers=2) as workers:
        headers = auth(issue_token(client))
        url = f"{ORDERS}/{add_order(client, headers)['id']}/proposals"
        pending = [workers.submit(submit, client, url, headers) for _ in range(2)]
        try:
            assert started.wait(5)
            assert_error(submit(client, url, headers), 429, "RATE_LIMITED")
        finally:
            release.set()
        results = sorted((job.result(timeout=5) for job in pending), key=lambda response: response.status_code)
        assert results[0].status_code == 201
        assert_error(results[1], 409, "OPEN_PROPOSAL_EXISTS")
        assert_record_counts(client, 1)
    assert len(calls) == 2


def test_openapi_matches_proposal_contract():
    schema = main.app.openapi()
    order_paths = schema["paths"][f"{ORDERS}/{{order_id}}/proposals"]
    form = order_paths["post"]["requestBody"]["content"]["multipart/form-data"]["schema"]
    assert form["anyOf"] == [{"required": ["text"]}, {"required": ["files"]}]
    assert form["properties"]["files"]["maxItems"] == 3
    assert {"201", "400", "401", "404", "409", "413", "422", "429", "502", "503"} == order_paths["post"]["responses"].keys()
    detail = schema["paths"][f"{API}/proposals/{{proposal_id}}"]["get"]
    for path in (*order_paths.values(), detail):
        assert path["security"] == [{"HTTPBearer": []}]
    models = schema["components"]["schemas"]
    assert models["ProposalVersion"]["properties"].keys() == set(CONTENT) | {
        "id", "proposalId", "version", "author", "baseOrderRevision", "createdAt",
    }
