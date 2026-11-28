"""Create anonymous sessions and their service catalogs."""

import sqlalchemy as sa
from alembic import op

revision = "0001_sessions_and_services"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "sessions",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("token_hash", sa.LargeBinary(), nullable=False),
        sa.UniqueConstraint("token_hash", name="uq_sessions_token_hash"),
        sa.CheckConstraint("octet_length(token_hash) = 32", name="ck_sessions_token_hash_length"),
    )
    op.create_table(
        "services",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("session_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("description", sa.String(12000), nullable=False),
        sa.ForeignKeyConstraint(["session_id"], ["sessions.id"], name="fk_services_session"),
        sa.CheckConstraint("char_length(name) >= 1", name="ck_services_name_not_empty"),
    )
    op.create_index("ix_services_session_name_id", "services", ["session_id", "name", "id"])


def downgrade() -> None:
    op.drop_table("services")
    op.drop_table("sessions")
