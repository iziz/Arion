import type {
  AskOperation,
  AskResponse,
  AssetRecord,
  DomainQueryPlan,
  DomainSearchFilters,
  IndexRecord
} from "../../../shared/types";

export type AskRequest = {
  query: string;
  explicitFilters: DomainSearchFilters;
  indexId?: string;
  tag?: string;
  modality?: string;
  limit?: number;
};

export type AskOperationEntry = {
  operation: AskOperation;
  response: AskResponse | null;
};

export type SearchPipelineRequest = AskRequest & {
  queryPlan: DomainQueryPlan;
  assets: AssetRecord[];
  indexes: IndexRecord[];
  askEntry?: AskOperationEntry;
};
