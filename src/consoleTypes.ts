export type ConsoleTab = "data" | "knowledge" | "search" | "system";
export type DialogMode = "index" | "edit-index" | "asset" | null;
export type SearchScopeMode = "all" | "group" | "asset";
export type SearchKnowledgeContext = {
  enabled: boolean;
  label: string;
  detail: string;
  tone: "domain" | "mixed" | "off";
};
