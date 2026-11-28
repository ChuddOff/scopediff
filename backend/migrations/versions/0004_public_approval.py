"""Persist revocable proposal links."""

import sqlalchemy as sa
from alembic import op

revision = "0004_public_approval"
down_revision = "0003_proposal_drafts"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("proposals", sa.Column("share_token", sa.String(43)))
    op.create_unique_constraint("uq_proposals_share_token", "proposals", ["share_token"])
    op.create_check_constraint("ck_proposals_share_token_length", "proposals", "char_length(share_token) = 43")


def downgrade() -> None:
    op.drop_constraint("ck_proposals_share_token_length", "proposals", type_="check")
    op.drop_constraint("uq_proposals_share_token", "proposals", type_="unique")
    op.drop_column("proposals", "share_token")
