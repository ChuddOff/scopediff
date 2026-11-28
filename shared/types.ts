/** ScopeDiff API v1. JSON keys are camelCase. IDs are opaque strings. */
export type ID = string;
export type DateOnly = string; // YYYY-MM-DD
export type Timestamp = string; // ISO 8601 UTC
export type OrderStatus = 'active' | 'completed';
export type ProposalStatus = 'draft' | 'pending' | 'countered' | 'approved' | 'rejected';
export type ChangeCategory = 'included' | 'extra' | 'unclear';
export type ShareFormat = 'pdf' | 'markdown' | 'text' | 'link';
export interface Service { id: ID; name: string; description: string; }
export type ServiceInput = Pick<Service, 'name'> & Partial<Pick<Service, 'description'>>;
export interface Order {
  id: ID;
  serviceId: ID | null;
  serviceSnapshot: Service | null;
  title: string;
  agreements: string;
  completedWork: string;
  deadline: DateOnly | null;
  status: OrderStatus;
  revision: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
export interface OrderInput {
  serviceId?: ID | null;
  title: string;
  agreements?: string;
  completedWork?: string;
  deadline?: DateOnly | null;
}
export interface OrderSummary extends Order { openProposalStatus: ProposalStatus | null; }
export interface ChangeItem {
  id: ID;
  title: string;
  description: string;
  category: ChangeCategory;
  reason: string;
  price: number | null; // integer RUB; null unknown, 0 explicitly free
}
export interface ProposalContent {
  title: string;
  items: ChangeItem[];
  deadline: DateOnly | null; // null = no proposed deadline change
  conditions: string;
  comment: string | null;
}
export interface ProposalVersion extends ProposalContent {
  id: ID;
  proposalId: ID;
  version: number;
  author: 'freelancer' | 'client';
  baseOrderRevision: number;
  createdAt: Timestamp;
}
export interface Proposal {
  id: ID;
  orderId: ID;
  title: string;
  status: ProposalStatus;
  currentVersionId: ID;
  publishedVersionId: ID | null;
  approvedVersionId: ID | null;
  shareUrl: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
export interface ProposalDetail { proposal: Proposal; versions: ProposalVersion[]; }
export interface OrderDetail { order: Order; proposals: Proposal[]; }
export interface OrderImportResult { order: Order; proposal: Proposal | null; version: ProposalVersion | null; }
export interface EnhanceDescriptionInput {
  kind: 'service' | 'order' | 'change_item' | 'conditions';
  title: string;
  currentText: string;
  dictation: string;
  context: string;
}
export interface EnhanceDescriptionResult { text: string; }
export interface ProposalResult { proposal: Proposal; version: ProposalVersion; }
export interface SessionResponse { token: string; }
export interface ApiError { error: { code: string; message: string; details?: unknown }; }
export interface VersionAction { expectedVersionId: ID; }
export type ProposalContentInput = Omit<ProposalContent, 'items'> & { items: Array<Omit<ChangeItem, 'id'> & { id: ID | null }> };
export interface UpdateProposal extends VersionAction { content: ProposalContentInput; }
export interface PublishProposal extends VersionAction { format: ShareFormat; }
export interface PdfLink { url: string; expiresAt: Timestamp; }
export interface PublicItem { id: ID; title: string; description: string; price: number | null; }
export interface PublicProposal {
  title: string;
  orderTitle: string;
  versionId: ID;
  version: number;
  status: ProposalStatus | 'editing';
  items: PublicItem[];
  deadline: DateOnly | null;
  conditions: string;
  comment: string | null;
  canRespond: boolean;
}
export interface PublicCounterContent {
  items: Array<Omit<PublicItem, 'id'> & { id: ID | null }>;
  deadline: DateOnly | null;
  conditions: string;
  comment: string | null;
}
export type PublicResponse =
  | (VersionAction & { action: 'approve' })
  | (VersionAction & { action: 'counter'; content: PublicCounterContent });
