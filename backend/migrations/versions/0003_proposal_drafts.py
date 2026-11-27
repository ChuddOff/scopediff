"""Persist proposals and their versions."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0003_proposal_drafts"
down_revision = "0002_manual_orders"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "proposals",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("order_id", sa.Uuid(), nullable=False),
        sa.Column("title", sa.String(160), nullable=False),
        sa.Column("status", sa.String(9), nullable=False),
        sa.Column("current_version_id", sa.Uuid(), nullable=False),
        sa.Column("published_version_id", sa.Uuid()),
        sa.Column("approved_version_id", sa.Uuid()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.statement_timestamp(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.statement_timestamp(), nullable=False),
        sa.ForeignKeyConstraint(["order_id"], ["orders.id"], name="fk_proposals_order", ondelete="CASCADE"),
        sa.CheckConstraint("status IN ('draft', 'pending', 'countered', 'approved', 'rejected')", name="ck_proposals_status"),
    )
    op.create_index(
        "uq_proposals_open_order",
        "proposals",
        ["order_id"],
        unique=True,
        postgresql_where=sa.text("status IN ('draft', 'pending', 'countered')"),
    )
    op.create_index(
        "ix_proposals_order_updated_id",
        "proposals",
        ["order_id", sa.text("updated_at DESC"), sa.text("id DESC")],
    )
    op.create_table(
        "proposal_versions",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("proposal_id", sa.Uuid(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("author", sa.String(10), nullable=False),
        sa.Column("base_order_revision", sa.Integer(), nullable=False),
        sa.Column("title", sa.String(160), nullable=False),
        sa.Column("items", JSONB(), nullable=False),
        sa.Column("deadline", sa.Date()),
        sa.Column("conditions", sa.String(12000), nullable=False),
        sa.Column("comment", sa.String(12000)),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.statement_timestamp(), nullable=False),
        sa.ForeignKeyConstraint(["proposal_id"], ["proposals.id"], name="fk_versions_proposal", ondelete="CASCADE"),
        sa.UniqueConstraint("proposal_id", "version", name="uq_versions_proposal_number"),
        sa.UniqueConstraint("proposal_id", "id", name="uq_versions_proposal_id"),
        sa.CheckConstraint("version >= 1", name="ck_versions_number"),
        sa.CheckConstraint("base_order_revision >= 1", name="ck_versions_base_revision"),
        sa.CheckConstraint("author IN ('freelancer', 'client')", name="ck_versions_author"),
    )
    for pointer in ("current", "published", "approved"):
        op.create_foreign_key(
            f"fk_proposals_{pointer}_version",
            "proposals",
            "proposal_versions",
            ["id", f"{pointer}_version_id"],
            ["proposal_id", "id"],
            deferrable=True,
            initially="DEFERRED",
        )


def downgrade() -> None:
    for pointer in ("current", "published", "approved"):
        op.drop_constraint(f"fk_proposals_{pointer}_version", "proposals", type_="foreignkey")
    op.drop_table("proposal_versions")
    op.drop_table("proposals")
