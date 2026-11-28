import type {
  ApiError, EnhanceDescriptionInput, EnhanceDescriptionResult, ID, Order, OrderDetail, OrderImportResult, OrderInput, OrderSummary,
  ProposalDetail, ProposalResult, PublishProposal, Service, ServiceInput, UpdateProposal, VersionAction,
} from "../../shared/types";

export type OrderPatch = Partial<Pick<Order, "title" | "serviceId" | "agreements" | "completedWork" | "deadline" | "status">>;
export type AiInput = { text?: string; files?: readonly File[] };
export type OrderImportInput = AiInput & { serviceId?: ID };
export type ReviseInput = AiInput & { expectedVersionId: ID };

export interface ApiClient {
  readonly demo: boolean;
  readonly demoExamples?: { service: string; order: string; changes: string };
  allowInitialSessionRetry?(): void;
  listServices(): Promise<Service[]>;
  getService(id: ID): Promise<Service>;
  createService(input: ServiceInput): Promise<Service>;
  updateService(id: ID, input: Partial<ServiceInput>): Promise<Service>;
  deleteService(id: ID): Promise<void>;
  importServices(input: AiInput): Promise<Service[]>;
  enhanceDescription(input: EnhanceDescriptionInput): Promise<EnhanceDescriptionResult>;
  listOrders(): Promise<OrderSummary[]>;
  getOrder(id: ID): Promise<OrderDetail>;
  createOrder(input: OrderInput): Promise<Order>;
  updateOrder(id: ID, input: OrderPatch): Promise<Order>;
  deleteOrder(id: ID): Promise<void>;
  importOrder(input: OrderImportInput): Promise<OrderImportResult>;
  getProposal(id: ID): Promise<ProposalDetail>;
  createProposal(orderId: ID, input: AiInput): Promise<ProposalResult>;
  reviseProposal(id: ID, input: ReviseInput): Promise<ProposalResult>;
  updateProposal(id: ID, input: UpdateProposal): Promise<ProposalResult>;
  publishProposal(id: ID, input: PublishProposal): Promise<ProposalResult>;
  approveProposal(id: ID, input: VersionAction): Promise<ProposalResult>;
  rejectProposal(id: ID, input: VersionAction): Promise<ProposalResult>;
  revokeLink?(id: ID, input: VersionAction): Promise<ProposalResult>;
  temporaryPdfUrl?(versionId: ID): Promise<string>;
  respondToDemoCounter?(id: ID, input: VersionAction): Promise<ProposalResult>;
}

export let api: ApiClient;

export function configureApi(client: ApiClient) { api = client; }

export function errorMessage(error: unknown): string {
  return (error as Partial<ApiError> | null)?.error?.message ?? "Не удалось выполнить действие. Попробуйте ещё раз.";
}

export function isConflict(error: unknown) {
  const code = (error as Partial<ApiError> | null)?.error?.code;
  const status = (error as { status?: number } | null)?.status;
  return status === 409 || code === "VERSION_CONFLICT" || code === "ORDER_CHANGED" || code === "OPEN_PROPOSAL_EXISTS" || code === "INVALID_STATE";
}

export function isOutcomeUnknown(error: unknown) {
  return (error as { outcomeUnknown?: boolean } | null)?.outcomeUnknown === true;
}
