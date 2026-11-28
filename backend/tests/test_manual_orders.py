from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from threading import Barrier
from uuid import UUID, uuid4

from alembic import command
from api_helpers import API, assert_error, auth, issue_token
from fastapi.testclient import TestClient
from sqlalchemy import text

from app import main
from app.db import create_database_engine

ORDERS = f"{API}/orders"
SERVICES = f"{API}/services"
ORDER_INPUT = {"serviceId": None, "title": "Ролик", "agreements": "", "completedWork": "", "deadline": None}
ORDER_FIELDS = set(ORDER_INPUT) | {"id", "serviceSnapshot", "status", "revision", "createdAt", "updatedAt"}


def add_service(client, headers, name="Монтаж", description="Два раунда правок"):
    response = client.post(SERVICES, headers=headers, json={"name": name, "description": description})
    assert response.status_code == 201
    return response.json()


def add_order(client, headers, **fields):
    response = client.post(ORDERS, headers=headers, json={**ORDER_INPUT, **fields})
    assert response.status_code == 201
    order = response.json()
    assert order.keys() == ORDER_FIELDS
    assert UUID(order["id"]).version == 4
    assert order["status"] == "active"
    assert order["revision"] == 1
    assert order["createdAt"] == order["updatedAt"]
    assert datetime.fromisoformat(order["createdAt"]).utcoffset() == timedelta(0)
    return order


def test_upgrade_existing_catalog_and_restart(database_schema):
    command.upgrade(database_schema, "0001_sessions_and_services")
    with TestClient(main.app) as client:
        headers = auth(issue_token(client))
        service = add_service(client, headers)

    command.upgrade(database_schema, "head")
    command.upgrade(database_schema, "head")
    command.check(database_schema)
    engine = create_database_engine()
    try:
        with engine.connect() as connection:
            assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "0004_public_approval"
    finally:
        engine.dispose()

    with TestClient(main.app) as client:
        assert client.get(f"{API}/health").json() == {"status": "ok"}
        assert client.get(SERVICES, headers=headers).json() == [service]
        assert client.get(ORDERS, headers=headers).json() == []
        order = add_order(client, headers, serviceId=service["id"])
        assert order["serviceSnapshot"] == service

    with TestClient(main.app) as client:
        assert client.get(SERVICES, headers=headers).json() == [service]
        assert client.get(ORDERS, headers=headers).json() == [{**order, "openProposalStatus": None}]
        assert client.get(f"{ORDERS}/{order['id']}", headers=headers).json() == {"order": order, "proposals": []}


def test_order_lifecycle_and_service_snapshots(migrated_database):
    with TestClient(main.app) as client:
        headers = auth(issue_token(client))
        plain = add_order(client, headers)
        assert plain["serviceId"] is plain["serviceSnapshot"] is None
        service = add_service(client, headers)
        order = add_order(client, headers, serviceId=service["id"], deadline="2028-02-29")
        order_path = f"{ORDERS}/{order['id']}"
        plain_path = f"{ORDERS}/{plain['id']}"
        service_path = f"{SERVICES}/{service['id']}"
        assert order["serviceSnapshot"] == service
        assert order["deadline"] == "2028-02-29"
        listing = client.get(ORDERS, headers=headers)
        assert listing.status_code == 200
        assert listing.json() == [{**item, "openProposalStatus": None} for item in (order, plain)]

        renamed = client.patch(plain_path, headers=headers, json={"title": "Новая обложка"})
        assert renamed.status_code == 200
        assert renamed.json() == {**plain, "title": "Новая обложка", "updatedAt": renamed.json()["updatedAt"]}
        assert datetime.fromisoformat(renamed.json()["updatedAt"]) > datetime.fromisoformat(plain["updatedAt"])
        assert client.get(ORDERS, headers=headers).json()[0]["id"] == plain["id"]

        patch = {"agreements": "Смонтировать ролик", "completedWork": "Есть черновик", "deadline": None}
        edited = client.patch(order_path, headers=headers, json=patch)
        assert edited.status_code == 200
        assert edited.json() == {**order, **patch, "revision": 2, "updatedAt": edited.json()["updatedAt"]}
        current = edited.json()
        for no_op in ({}, patch, {"serviceId": service["id"]}):
            assert client.patch(order_path, headers=headers, json=no_op).json() == current

        updated_service = client.patch(service_path, headers=headers, json={"description": "Один раунд правок"})
        assert updated_service.status_code == 200
        assert updated_service.json()["description"] == "Один раунд правок"
        assert client.get(order_path, headers=headers).json() == {"order": current, "proposals": []}
        assert client.patch(order_path, headers=headers, json={"serviceId": service["id"]}).json() == current
        assert client.delete(service_path, headers=headers).status_code == 204
        current = {**current, "serviceId": None}
        assert client.get(order_path, headers=headers).json() == {"order": current, "proposals": []}

        cleared = client.patch(order_path, headers=headers, json={"serviceId": None})
        assert cleared.status_code == 200
        assert cleared.json() == {**current, "serviceSnapshot": None, "revision": 3, "updatedAt": cleared.json()["updatedAt"]}
        assert client.patch(order_path, headers=headers, json={"serviceId": None}).json() == cleared.json()

        first = add_service(client, headers, "Съёмка", "Съёмочный день")
        second = add_service(client, headers, "Дизайн", "Один макет")
        attached = client.patch(order_path, headers=headers, json={"serviceId": first["id"]}).json()
        assert attached["serviceSnapshot"] == first and attached["revision"] == 4
        changed = client.patch(order_path, headers=headers, json={"serviceId": second["id"], "deadline": "2030-01-02"}).json()
        assert changed["serviceId"] == second["id"] and changed["serviceSnapshot"] == second
        assert changed["revision"] == 5 and changed["deadline"] == "2030-01-02"
        detached = client.patch(order_path, headers=headers, json={"serviceId": None}).json()
        assert detached["serviceId"] is detached["serviceSnapshot"] is None
        assert detached["revision"] == 6
        assert detached["createdAt"] == order["createdAt"]

        for status in ("completed", "active"):
            response = client.patch(order_path, headers=headers, json={"status": status})
            assert response.status_code == 200
            assert response.json() == {**detached, "status": status, "updatedAt": response.json()["updatedAt"]}
            assert datetime.fromisoformat(response.json()["updatedAt"]) > datetime.fromisoformat(detached["updatedAt"])
            assert client.get(ORDERS, headers=headers).json()[0]["status"] == status
            detached = response.json()


def test_order_session_isolation_and_atomic_errors(migrated_database):
    with TestClient(main.app) as client:
        owner = auth(issue_token(client))
        other = auth(issue_token(client))
        service = add_service(client, other)
        order = add_order(client, owner)
        path = f"{ORDERS}/{order['id']}"
        assert client.get(ORDERS, headers=other).json() == []
        for service_id in (service["id"], str(uuid4())):
            rejected = {**ORDER_INPUT, "serviceId": service_id, "title": "Посторонний заказ"}
            assert_error(client.post(ORDERS, headers=owner, json=rejected), 404, "NOT_FOUND")
            assert_error(client.patch(path, headers=owner, json=rejected), 404, "NOT_FOUND")
            assert client.get(path, headers=owner).json()["order"] == order
            assert client.get(ORDERS, headers=owner).json() == [{**order, "openProposalStatus": None}]

        for method, url, kwargs in (
            ("get", ORDERS, {}), ("post", ORDERS, {"json": ORDER_INPUT}),
            ("get", path, {}), ("patch", path, {"json": {"title": "Другое"}}), ("delete", path, {}),
        ):
            assert_error(client.request(method, url, headers=auth("invalid"), **kwargs), 401, "UNAUTHORIZED")
            if url == path:
                assert_error(client.request(method, url, headers=other, **kwargs), 404, "NOT_FOUND")

        response = client.delete(path, headers=owner)
        assert response.status_code == 204 and response.content == b""
        assert_error(client.get(path, headers=owner), 404, "NOT_FOUND")
        assert_error(client.delete(path, headers=owner), 404, "NOT_FOUND")
        assert client.get(ORDERS, headers=owner).json() == []


def test_order_validation_boundaries(migrated_database):
    with TestClient(main.app) as client:
        headers = auth(issue_token(client))
        bounds = {"title": "А" * 160, "agreements": "а" * 12000, "completedWork": "б" * 12000}
        order = add_order(client, headers, **bounds)
        path = f"{ORDERS}/{order['id']}"
        for field, value in (
            ("title", ""), ("title", "А" * 161), ("title", None),
            ("agreements", "а" * 12001), ("completedWork", "б" * 12001),
            ("agreements", None), ("completedWork", None), ("completedWork", "\x00"),
            ("deadline", "2027-02-29"), ("deadline", "2028-2-29"),
            ("deadline", "2028-02-29T00:00:00Z"), ("deadline", 0), ("deadline", "0"),
            ("serviceId", "invalid"), ("completed_work", "snake_case"), ("revision", 5),
        ):
            assert_error(client.post(ORDERS, headers=headers, json={**ORDER_INPUT, field: value}), 422, "VALIDATION_ERROR")
            assert_error(client.patch(path, headers=headers, json={field: value}), 422, "VALIDATION_ERROR")
        minimal = client.post(ORDERS, headers=headers, json={"title": "Неполный"})
        assert minimal.status_code == 201
        assert minimal.json().keys() == ORDER_FIELDS
        assert {field: minimal.json()[field] for field in ORDER_INPUT} == {**ORDER_INPUT, "title": "Неполный"}
        assert_error(client.post(ORDERS, headers=headers, json={**ORDER_INPUT, "status": "completed"}), 422, "VALIDATION_ERROR")
        for value in (None, "draft"):
            assert_error(client.patch(path, headers=headers, json={"status": value}), 422, "VALIDATION_ERROR")
        assert_error(client.get(f"{ORDERS}/invalid", headers=headers), 422, "VALIDATION_ERROR")
        assert client.get(path, headers=headers).json()["order"] == order
        shortest = client.patch(path, headers=headers, json={"title": "А", "agreements": "", "completedWork": ""})
        assert shortest.status_code == 200


def test_concurrent_patches_keep_both_context_changes(migrated_database):
    with TestClient(main.app) as client:
        headers = auth(issue_token(client))
        order = add_order(client, headers)
        path = f"{ORDERS}/{order['id']}"
        start = Barrier(2, timeout=5)

        def patch(payload):
            start.wait()
            return client.patch(path, headers=headers, json=payload)

        with ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(patch, ({"agreements": "Есть ТЗ"}, {"completedWork": "Есть черновик"})))
        assert [response.status_code for response in responses] == [200, 200]
        assert sorted(response.json()["revision"] for response in responses) == [2, 3]
        current = client.get(path, headers=headers).json()["order"]
        assert current["agreements"] == "Есть ТЗ"
        assert current["completedWork"] == "Есть черновик"
        assert current["revision"] == 3


def test_orders_openapi_matches_contract():
    schema = main.app.openapi()
    collection = schema["paths"][ORDERS]
    item = schema["paths"][f"{ORDERS}/{{order_id}}"]
    expected = [
        (collection["get"], {"200", "401", "503"}, "OrderSummary"),
        (collection["post"], {"201", "401", "404", "422", "503"}, "Order"),
        (item["get"], {"200", "401", "404", "422", "503"}, "OrderDetail"),
        (item["patch"], {"200", "401", "404", "409", "422", "503"}, "Order"),
        (item["delete"], {"204", "401", "404", "422", "503"}, None),
    ]
    for operation, statuses, model in expected:
        assert operation["security"] == [{"HTTPBearer": []}]
        assert operation["responses"].keys() == statuses
        response = operation["responses"][min(statuses)]
        if model is None:
            assert "content" not in response
        else:
            output = response["content"]["application/json"]["schema"]
            if model == "OrderSummary":
                assert output["type"] == "array"
                output = output["items"]
            assert output["$ref"] == f"#/components/schemas/{model}"

    models = schema["components"]["schemas"]
    assert models["Order"]["properties"].keys() == ORDER_FIELDS
    assert models["OrderSummary"]["properties"].keys() == ORDER_FIELDS | {"openProposalStatus"}
    assert models["OrderDetail"]["properties"].keys() == {"order", "proposals"}
    assert models["OrderDetail"]["properties"]["proposals"]["items"]["$ref"] == "#/components/schemas/Proposal"
    assert models["OrderInput"]["required"] == ["title"]
    assert set(models["Order"]["required"]) == ORDER_FIELDS
    patch = models["OrderPatch"]
    assert "required" not in patch
    assert patch["properties"].keys() == set(ORDER_INPUT) | {"status"}
    assert patch["properties"]["deadline"]["anyOf"] == [{"type": "string", "format": "date"}, {"type": "null"}]
    assert patch["properties"]["status"]["enum"] == ["active", "completed"]
