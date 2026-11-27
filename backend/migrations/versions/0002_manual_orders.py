"""Create manual orders and preserve service terms in a snapshot."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0002_manual_orders"
down_revision = "0001_sessions_and_services"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "orders",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("session_id", sa.Uuid(), nullable=False),
        sa.Column("service_id", sa.Uuid()),
        sa.Column("service_snapshot", JSONB(none_as_null=True)),
        sa.Column("title", sa.String(160), nullable=False),
        sa.Column("agreements", sa.String(12000), nullable=False),
        sa.Column("completed_work", sa.String(12000), nullable=False),
        sa.Column("deadline", sa.Date()),
        sa.Column("status", sa.String(9), server_default="active", nullable=False),
        sa.Column("revision", sa.Integer(), server_default="1", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.statement_timestamp(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.statement_timestamp(), nullable=False),
        sa.ForeignKeyConstraint(["session_id"], ["sessions.id"], name="fk_orders_session"),
        sa.ForeignKeyConstraint(["service_id"], ["services.id"], name="fk_orders_service", ondelete="SET NULL"),
        sa.CheckConstraint("char_length(title) >= 1", name="ck_orders_title_not_empty"),
        sa.CheckConstraint("status IN ('active', 'completed')", name="ck_orders_status"),
        sa.CheckConstraint("revision >= 1", name="ck_orders_revision"),
    )
    op.create_index("ix_orders_session_updated_id", "orders", ["session_id", sa.text("updated_at DESC"), sa.text("id DESC")])
    op.create_index("ix_orders_service_id", "orders", ["service_id"])


def downgrade() -> None:
    op.drop_table("orders")
