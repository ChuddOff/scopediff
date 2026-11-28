from sqlalchemy import (
    CheckConstraint,
    Column,
    Date,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    LargeBinary,
    MetaData,
    String,
    Table,
    UniqueConstraint,
    Uuid,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB

metadata = MetaData()

sessions = Table(
    "sessions",
    metadata,
    Column("id", Uuid, primary_key=True),
    Column("token_hash", LargeBinary, nullable=False),
    UniqueConstraint("token_hash", name="uq_sessions_token_hash"),
    CheckConstraint("octet_length(token_hash) = 32", name="ck_sessions_token_hash_length"),
)

services = Table(
    "services",
    metadata,
    Column("id", Uuid, primary_key=True),
    Column("session_id", Uuid, ForeignKey("sessions.id", name="fk_services_session"), nullable=False),
    Column("name", String(120), nullable=False),
    Column("description", String(12000), nullable=False),
    CheckConstraint("char_length(name) >= 1", name="ck_services_name_not_empty"),
    Index("ix_services_session_name_id", "session_id", "name", "id"),
)

orders = Table(
    "orders",
    metadata,
    Column("id", Uuid, primary_key=True),
    Column("session_id", Uuid, ForeignKey("sessions.id", name="fk_orders_session"), nullable=False),
    Column("service_id", Uuid, ForeignKey("services.id", name="fk_orders_service", ondelete="SET NULL")),
    Column("service_snapshot", JSONB(none_as_null=True)),
    Column("title", String(160), nullable=False),
    Column("agreements", String(12000), nullable=False),
    Column("completed_work", String(12000), nullable=False),
    Column("deadline", Date),
    Column("status", String(9), server_default="active", nullable=False),
    Column("revision", Integer, server_default="1", nullable=False),
    Column("created_at", DateTime(timezone=True), server_default=func.statement_timestamp(), nullable=False),
    Column("updated_at", DateTime(timezone=True), server_default=func.statement_timestamp(), nullable=False),
    CheckConstraint("char_length(title) >= 1", name="ck_orders_title_not_empty"),
    CheckConstraint("status IN ('active', 'completed')", name="ck_orders_status"),
    CheckConstraint("revision >= 1", name="ck_orders_revision"),
    Index("ix_orders_service_id", "service_id"),
)

Index("ix_orders_session_updated_id", orders.c.session_id, orders.c.updated_at.desc(), orders.c.id.desc())

proposals = Table(
    "proposals",
    metadata,
    Column("id", Uuid, primary_key=True),
    Column("order_id", Uuid, ForeignKey("orders.id", name="fk_proposals_order", ondelete="CASCADE"), nullable=False),
    Column("title", String(160), nullable=False),
    Column("status", String(9), nullable=False),
    Column("current_version_id", Uuid, nullable=False),
    Column("published_version_id", Uuid),
    Column("approved_version_id", Uuid),
    Column("share_token", String(43)),
    Column("created_at", DateTime(timezone=True), server_default=func.statement_timestamp(), nullable=False),
    Column("updated_at", DateTime(timezone=True), server_default=func.statement_timestamp(), nullable=False),
    CheckConstraint("status IN ('draft', 'pending', 'countered', 'approved', 'rejected')", name="ck_proposals_status"),
    UniqueConstraint("share_token", name="uq_proposals_share_token"),
    CheckConstraint("char_length(share_token) = 43", name="ck_proposals_share_token_length"),
)

open_proposal = proposals.c.status.in_(("draft", "pending", "countered"))
Index("uq_proposals_open_order", proposals.c.order_id, unique=True, postgresql_where=open_proposal)
Index("ix_proposals_order_updated_id", proposals.c.order_id, proposals.c.updated_at.desc(), proposals.c.id.desc())

proposal_versions = Table(
    "proposal_versions",
    metadata,
    Column("id", Uuid, primary_key=True),
    Column("proposal_id", Uuid, ForeignKey("proposals.id", name="fk_versions_proposal", ondelete="CASCADE"), nullable=False),
    Column("version", Integer, nullable=False),
    Column("author", String(10), nullable=False),
    Column("base_order_revision", Integer, nullable=False),
    Column("title", String(160), nullable=False),
    Column("items", JSONB, nullable=False),
    Column("deadline", Date),
    Column("conditions", String(12000), nullable=False),
    Column("comment", String(12000)),
    Column("created_at", DateTime(timezone=True), server_default=func.statement_timestamp(), nullable=False),
    UniqueConstraint("proposal_id", "version", name="uq_versions_proposal_number"),
    UniqueConstraint("proposal_id", "id", name="uq_versions_proposal_id"),
    CheckConstraint("version >= 1", name="ck_versions_number"),
    CheckConstraint("base_order_revision >= 1", name="ck_versions_base_revision"),
    CheckConstraint("author IN ('freelancer', 'client')", name="ck_versions_author"),
)

for pointer in ("current", "published", "approved"):
    proposals.append_constraint(
        ForeignKeyConstraint(
            ["id", f"{pointer}_version_id"],
            ["proposal_versions.proposal_id", "proposal_versions.id"],
            name=f"fk_proposals_{pointer}_version",
            use_alter=True,
            deferrable=True,
            initially="DEFERRED",
        )
    )
