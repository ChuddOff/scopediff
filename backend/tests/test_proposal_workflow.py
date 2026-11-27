import json
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, Event
from uuid import UUID, uuid4

import anyio
import httpx2
import pytest
from api_helpers import API, assert_error, auth, issue_token
from fastapi.testclient import TestClient
from sqlalchemy import func, select, text
from test_manual_orders import ORDERS, add_order
from test_proposal_drafts import CHANGE, CONTENT, completion, provider, submit

from app import ai, main
from app.models import proposal_versions, proposals


def draft(client, headers, **order_fields):
    order = add_order(client, headers, **order_fields)
    order_path = f"{ORDERS}/{order['id']}"
    response = submit(client, f"{order_path}/proposals", headers)
    assert response.status_code == 201
    result = response.json()
    return order, f"{API}/proposals/{result['proposal']['id']}", result["version"]


def content_of(version, **fields):
    return {**{field: version[field] for field in CONTENT}, **fields}


def patch(client, path, headers, version_id, content):
    return client.patch(path, headers=headers, json={"expectedVersionId": version_id, "content": content})


def action(client, path, headers, version_id, name, **fields):
    return client.post(f"{path}/{name}", headers=headers, json={"expectedVersionId": version_id, **fields})


def revise(client, path, headers, version_id, remarks="Добавьте горизонтальные субтитры"):
    return client.post(f"{path}/revise", headers=headers, files={
        "text": (None, remarks), "expectedVersionId": (None, version_id),
    })


def status_in_orders(client, headers, order_id):
    return next(order["openProposalStatus"] for order in client.get(ORDERS, headers=headers).json() if order["id"] == order_id)


def test_edit_publish_approve_restart_and_use_approved_context(migrated_database, provider):
    calls = provider(completion(), completion())
    with TestClient(main.app) as client:
        headers = auth(issue_token(client))
        order, path, v1 = draft(client, headers, agreements="Ролик 9:16", deadline="2028-02-22")
        order_path = f"{ORDERS}/{order['id']}"
        known = dict(v1["items"][0], price=2000, reason="")
        free = dict(CHANGE, id=None, title="Титр", description="", price=0, reason="")
        unknown = dict(CHANGE, id=None, title="Субтитры")
        edited = patch(client, path, headers, v1["id"], content_of(
            v1, title="Работы по ролику", items=[known, free, unknown], comment="Внутренняя заметка",
        ))
        assert edited.status_code == 200
        v1 = edited.json()["version"]
        assert v1["version"] == 1
        assert v1["items"][0] == known
        assert [item["price"] for item in v1["items"]] == [2000, 0, None]
        assert len({item["id"] for item in v1["items"]}) == 3
        assert edited.json()["proposal"]["title"] == v1["title"]
        assert edited.json()["proposal"]["currentVersionId"] == v1["id"]
        assert status_in_orders(client, headers, order["id"]) == "draft"
        assert_error(action(client, path, headers, v1["id"], "approve"), 409, "INVALID_STATE")
        assert_error(action(client, path, headers, v1["id"], "publish", format="link"), 503, "SERVICE_UNAVAILABLE")
        assert client.get(path, headers=headers).json()["proposal"] == edited.json()["proposal"]

        response = action(client, path, headers, v1["id"], "publish", format="text")
        assert response.status_code == 200 and response.json()["version"] == v1
        published = response.json()
        assert published["proposal"]["status"] == "pending"
        assert published["proposal"]["publishedVersionId"] == v1["id"]
        assert action(client, path, headers, v1["id"], "publish", format="markdown").json() == published
        assert_error(client.delete(path, headers=headers), 409, "INVALID_STATE")
        assert status_in_orders(client, headers, order["id"]) == "pending"

        v2_draft = patch(client, path, headers, v1["id"], content_of(
            v1, items=v1["items"][:2], deadline="2028-03-01", conditions="Один раунд правок",
        )).json()
        v2 = v2_draft["version"]
        assert v2["version"] == 2 and v2["items"] == v1["items"][:2]
        assert v2_draft["proposal"]["status"] == "draft"
        assert v2_draft["proposal"]["publishedVersionId"] == v1["id"]
        assert_error(client.delete(path, headers=headers), 409, "INVALID_STATE")
        assert_error(action(client, path, headers, v1["id"], "approve"), 409, "VERSION_CONFLICT")
        assert action(client, path, headers, v2["id"], "publish", format="markdown").json()["version"] == v2
        assert client.patch(order_path, headers=headers, json={"completedWork": "Вертикальный ролик"}).status_code == 200
        assert_error(action(client, path, headers, v2["id"], "approve"), 409, "ORDER_CHANGED")

        refreshed = patch(client, path, headers, v2["id"], content_of(v2)).json()["version"]
        assert refreshed["version"] == 3 and refreshed["baseOrderRevision"] == order["revision"] + 1
        assert action(client, path, headers, refreshed["id"], "publish", format="markdown").status_code == 200
        approved_response = action(client, path, headers, refreshed["id"], "approve")
        assert approved_response.status_code == 200
        approved = approved_response.json()
        assert approved["proposal"]["status"] == "approved"
        assert approved["proposal"]["approvedVersionId"] == refreshed["id"]
        assert action(client, path, headers, refreshed["id"], "approve").json() == approved
        assert_error(patch(client, path, headers, refreshed["id"], content_of(refreshed)), 409, "INVALID_STATE")
        assert_error(revise(client, path, headers, refreshed["id"]), 409, "INVALID_STATE")
        final_order = client.get(order_path, headers=headers).json()["order"]
        assert final_order["revision"] == order["revision"] + 2
        assert final_order["deadline"] == "2028-03-01"
        assert final_order["agreements"] == order["agreements"]
        assert status_in_orders(client, headers, order["id"]) is None

    with TestClient(main.app) as client:
        assert client.get(path, headers=headers).json() == {
            "proposal": approved["proposal"], "versions": [v1, v2, refreshed],
        }
        assert client.get(order_path, headers=headers).json() == {"order": final_order, "proposals": [approved["proposal"]]}
        assert submit(client, f"{order_path}/proposals", headers).status_code == 201
    context = json.loads(calls[1]["messages"][1]["content"])
    assert context["approvedVersions"][0]["deadline"] == "2028-03-01"
    assert context["approvedVersions"][0]["conditions"] == "Один раунд правок"
    assert [item["price"] for item in context["approvedVersions"][0]["items"]] == [2000, 0]


def test_edit_validation_permissions_reject_and_delete(migrated_database, provider):
    calls = provider(completion(), completion())
    with TestClient(main.app) as client:
        headers, other = auth(issue_token(client)), auth(issue_token(client))
        order, path, version = draft(client, headers, deadline="2028-02-22")
        version_id = version["id"]
        saved = client.get(path, headers=headers).json()
        for unauthorized, code, status in (({}, "UNAUTHORIZED", 401), (other, "NOT_FOUND", 404)):
            assert_error(patch(client, path, unauthorized, version_id, content_of(version)), status, code)
            assert_error(revise(client, path, unauthorized, version_id), status, code)
            for action_name in ("approve", "reject", "publish"):
                fields = {"format": "text"} if action_name == "publish" else {}
                assert_error(action(client, path, unauthorized, version_id, action_name, **fields), status, code)
            assert_error(client.delete(path, headers=unauthorized), status, code)

        item = version["items"][0]
        for invalid_items in (
            [dict(item, id=str(uuid4()))], [item, item], [dict(item, price=True)],
            [dict(item, price=-1)], [dict(item, price=1.0)], [dict(item, price="1")],
        ):
            assert_error(patch(client, path, headers, version_id, content_of(version, items=invalid_items)), 422, "VALIDATION_ERROR")
        assert_error(patch(client, path, headers, version_id, content_of(version, deadline="2027-02-29")), 422, "VALIDATION_ERROR")
        assert_error(patch(client, path, headers, str(uuid4()), content_of(version)), 409, "VERSION_CONFLICT")
        assert_error(revise(client, path, headers, str(uuid4())), 409, "VERSION_CONFLICT")
        assert_error(revise(client, path, headers, "invalid"), 422, "VALIDATION_ERROR")
        assert_error(submit(client, f"{path}/revise", headers), 422, "VALIDATION_ERROR")
        assert client.get(path, headers=headers).json() == saved
        response = client.delete(path, headers=headers)
        assert response.status_code == 204 and not response.content
        assert_error(client.get(path, headers=headers), 404, "NOT_FOUND")
        with client.app.state.engine.connect() as connection:
            assert connection.scalar(select(func.count()).select_from(proposal_versions)) == 0
        assert status_in_orders(client, headers, order["id"]) is None

        order_path = f"{ORDERS}/{order['id']}"
        result = submit(client, f"{order_path}/proposals", headers).json()
        path = f"{API}/proposals/{result['proposal']['id']}"
        version = result["version"]
        rejected = action(client, path, headers, version["id"], "reject")
        assert rejected.status_code == 200 and rejected.json()["proposal"]["status"] == "rejected"
        assert_error(client.delete(path, headers=headers), 409, "INVALID_STATE")
        assert_error(action(client, path, headers, version["id"], "reject"), 409, "INVALID_STATE")
        assert status_in_orders(client, headers, order["id"]) is None
        final = client.get(order_path, headers=headers).json()["order"]
        assert (final["revision"], final["deadline"], final["agreements"]) == (order["revision"], order["deadline"], order["agreements"])
        assert client.patch(order_path, headers=headers, json={"status": "completed"}).status_code == 200
    assert len(calls) == 2


def test_revise_draft_validates_preservation_and_retains_versions(migrated_database, provider):
    remarks = "Горизонтальный ролик бесплатно, новый срок 2028-03-01. Уберите титр. Добавьте субтитры."

    async def wrong_id():
        return completion(dict(complete, items=[dict(adjusted, id=str(uuid4())), added]))

    async def revised():
        return completion(complete)

    calls = provider(
        completion(dict(CONTENT, deadline="2028-02-28", items=[dict(CHANGE, price=2000), dict(CHANGE, title="Титр")])),
        wrong_id, revised,
    )
    with TestClient(main.app) as client:
        headers = auth(issue_token(client))
        order, path, v1 = draft(client, headers)
        adjusted = dict(v1["items"][0], price=0, priceEvidence="Горизонтальный ролик бесплатно")
        added = dict(CHANGE, id=None, title="Субтитры")
        removal = {"id": v1["items"][1]["id"], "evidence": "Уберите титр"}
        complete = dict(
            CONTENT, items=[adjusted, added], removedItems=[removal], deadline="2028-03-01",
            deadlineEvidence="новый срок 2028-03-01",
        )
        updated = revise(client, path, headers, v1["id"], remarks)
        assert updated.status_code == 200
        v2 = updated.json()["version"]
        assert v2["version"] == 2 and v2["author"] == "freelancer" and v2["id"] != v1["id"]
        assert updated.json()["proposal"]["publishedVersionId"] is None
        assert v2["deadline"] == "2028-03-01"
        assert v2["items"][0]["id"] == v1["items"][0]["id"] and v2["items"][0]["price"] == 0
        assert UUID(v2["items"][1]["id"]).version == 4 and v2["items"][1]["price"] is None
        assert "priceEvidence" not in v2["items"][0] and "removedItems" not in v2
        assert client.get(path, headers=headers).json()["versions"] == [v1, v2]
        assert len(calls) == 3
        context = json.loads(calls[1]["messages"][1]["content"])
        assert context["currentVersion"] == v1
        assert context["requestedChanges"] == remarks and context["agreements"] == order["agreements"]

        for invalid in (
            dict(complete, removedItems=[]),
            dict(complete, items=[dict(adjusted, priceEvidence="выдуманная цена"), added]),
            dict(complete, items=[dict(adjusted, description="Чужая формулировка"), added]),
            dict(complete, items=[adjusted, adjusted]),
            dict(complete, deadlineEvidence=None),
            dict(complete, title="Самовольное название", titleEvidence="Выдуманная просьба"),
        ):
            with pytest.raises(ValueError):
                ai.RevisedProposal.model_validate_json(json.dumps(invalid)).check_against(v1, remarks)

        rewritten_fields = dict(complete, title="Самовольное название", conditions="Условие", comment="Комментарий")
        restored = ai.RevisedProposal.model_validate_json(json.dumps(rewritten_fields)).check_against(v1, remarks)
        assert (restored.title, restored.conditions, restored.comment) == (v1["title"], v1["conditions"], v1["comment"])


@pytest.mark.parametrize(("concurrent_write", "code"), [("proposal", "VERSION_CONFLICT"), ("order", "ORDER_CHANGED")])
def test_revision_race_with_in_place_edit_or_order_change(migrated_database, provider, concurrent_write, code):
    started, release = Event(), Event()

    async def paused():
        started.set()
        assert await anyio.to_thread.run_sync(release.wait, 5)
        return completion(content_of(version))

    calls = provider(completion(), paused)
    with TestClient(main.app) as client, ThreadPoolExecutor(max_workers=1) as workers:
        headers = auth(issue_token(client))
        order, path, version = draft(client, headers)
        pending = workers.submit(revise, client, path, headers, version["id"])
        try:
            assert started.wait(5)
            assert client.app.state.engine.pool.checkedout() == 0
            if concurrent_write == "proposal":
                changed = patch(client, path, headers, version["id"], content_of(version, title="Правка владельца"))
                assert changed.status_code == 200 and changed.json()["version"]["id"] == version["id"]
            else:
                assert client.patch(f"{ORDERS}/{order['id']}", headers=headers, json={"agreements": "Уточнение"}).status_code == 200
        finally:
            release.set()
        assert_error(pending.result(timeout=5), 409, code)
        assert len(client.get(path, headers=headers).json()["versions"]) == 1
    assert len(calls) == 2


@pytest.mark.parametrize("second_action", ["approve", "reject"])
def test_concurrent_decisions_apply_once(migrated_database, provider, second_action):
    provider(completion())
    with TestClient(main.app) as client, ThreadPoolExecutor(max_workers=2) as workers:
        headers = auth(issue_token(client))
        order, path, version = draft(client, headers, deadline="2028-02-22")
        assert action(client, path, headers, version["id"], "publish", format="text").status_code == 200
        simultaneous = Barrier(2, timeout=5)

        def decide(name):
            simultaneous.wait()
            return action(client, path, headers, version["id"], name)

        jobs = [workers.submit(decide, name) for name in ("approve", second_action)]
        first, second = [job.result(timeout=5) for job in jobs]
        if second_action == "approve":
            assert first.status_code == second.status_code == 200 and first.json() == second.json()
        else:
            assert sorted([first.status_code, second.status_code]) == [200, 409]
            assert_error(first if first.status_code == 409 else second, 409, "INVALID_STATE")
        saved = client.get(f"{ORDERS}/{order['id']}", headers=headers).json()["order"]
        assert saved["revision"] == order["revision"] + (first.status_code == 200)
        assert saved["deadline"] == order["deadline"]
        assert status_in_orders(client, headers, order["id"]) is None


def test_revision_and_approval_fail_atomically(migrated_database, provider):
    async def revised():
        return completion(content_of(version))

    provider(completion(), httpx2.Response(429, json={"error": {"message": "private-provider-detail"}}), revised)
    with TestClient(main.app) as client:
        headers = auth(issue_token(client))
        order, path, version = draft(client, headers)
        assert action(client, path, headers, version["id"], "publish", format="markdown").status_code == 200
        order_path = f"{ORDERS}/{order['id']}"
        original = client.get(path, headers=headers).json()
        original_order = client.get(order_path, headers=headers).json()
        assert_error(revise(client, path, headers, version["id"]), 502, "AI_FAILED")
        with client.app.state.engine.begin() as connection:
            connection.execute(text("ALTER TABLE proposal_versions ADD CHECK (version = 1)"))
            connection.execute(text("ALTER TABLE orders ADD CHECK (revision = 1)"))
        assert_error(revise(client, path, headers, version["id"]), 503, "SERVICE_UNAVAILABLE")
        assert_error(action(client, path, headers, version["id"], "approve"), 503, "SERVICE_UNAVAILABLE")
        assert client.get(path, headers=headers).json() == original
        assert client.get(order_path, headers=headers).json() == original_order


@pytest.mark.parametrize("operation", ["approve", "reject", "patch", "revise"])
def test_countered_version_can_be_resolved_or_reworked(migrated_database, provider, operation):
    async def revised():
        return completion(content_of(counter))

    provider(completion(), revised)
    with TestClient(main.app) as client:
        headers = auth(issue_token(client))
        _, path, v1 = draft(client, headers)
        assert action(client, path, headers, v1["id"], "publish", format="text").status_code == 200
        proposal_id, counter_id = UUID(v1["proposalId"]), uuid4()
        with client.app.state.engine.begin() as connection:
            connection.execute(proposal_versions.insert().values(
                id=counter_id, proposal_id=proposal_id, version=2, author="client",
                base_order_revision=v1["baseOrderRevision"], **dict(content_of(v1), conditions="Встречные условия"),
            ))
            connection.execute(proposals.update().where(proposals.c.id == proposal_id).values(
                status="countered", current_version_id=counter_id,
            ))
        counter = client.get(path, headers=headers).json()["versions"][1]
        if operation == "patch":
            response = patch(client, path, headers, str(counter_id), content_of(counter))
        elif operation == "revise":
            response = revise(client, path, headers, str(counter_id))
        else:
            response = action(client, path, headers, str(counter_id), operation)
        assert response.status_code == 200
        result = response.json()
        assert result["proposal"]["publishedVersionId"] == v1["id"]
        if operation in ("approve", "reject"):
            assert result["version"] == counter
            assert result["proposal"]["status"] == ("approved" if operation == "approve" else "rejected")
        else:
            assert result["version"]["version"] == 3 and result["version"]["author"] == "freelancer"
            assert result["proposal"]["status"] == "draft"
        assert client.get(path, headers=headers).json()["versions"][:2] == [v1, counter]


def test_workflow_openapi_matches_client():
    schema = main.app.openapi()
    root = f"{API}/proposals/{{proposal_id}}"
    for suffix, method in (
        ("", "patch"), ("/revise", "post"), ("/publish", "post"), ("/approve", "post"), ("/reject", "post"), ("", "delete"),
    ):
        route = schema["paths"][root + suffix][method]
        assert route["security"] == [{"HTTPBearer": []}]
        assert {"401", "404", "409", "422", "503"} <= route["responses"].keys()
    revise_schema = schema["paths"][root + "/revise"]["post"]["requestBody"]["content"]["multipart/form-data"]["schema"]
    assert revise_schema["required"] == ["expectedVersionId"]
    models = schema["components"]["schemas"]
    assert models["UpdateProposal"]["required"] == ["expectedVersionId", "content"]
    assert models["PublishProposal"]["properties"]["format"]["enum"] == ["pdf", "markdown", "text", "link"]
