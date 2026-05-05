import type {
  AskOperation,
  AskResponse,
  AssetRecord,
  DomainQueryPlan,
  DomainSearchFilters,
  IndexRecord,
  KnowledgeSourceId
} from "../../../shared/types";

export type AskRequest = {
  query: string;
  explicitFilters: DomainSearchFilters;
  indexId?: string;
  assetId?: string;
  domainGroup?: KnowledgeSourceId;
  tag?: string;
  modality?: string;
  limit?: number;
  useKnowledgeLayer: boolean;
};

export type AskOperationEntry = {
  operation: AskOperation;
  request: AskRequest;
  response: AskResponse | null;
};

export type SearchPipelineRequest = AskRequest & {
  queryPlan: DomainQueryPlan;
  assets: AssetRecord[];
  indexes: IndexRecord[];
  askEntry?: AskOperationEntry;
};
