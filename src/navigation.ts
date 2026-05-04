import type { SportsDomainGroup } from "../shared/types";
import type { AssetDetailTab } from "./components/assets/AssetComponents";
import type { ConsoleTab } from "./consoleTypes";

export type ConsoleRouteState = {
  activeTab: ConsoleTab;
  selectedIndexId?: string | null;
  selectedAssetId?: string | null;
  selectedSegmentId?: string | null;
  assetDetailTab?: AssetDetailTab;
  selectedKnowledgeDomain?: SportsDomainGroup;
  seekAt?: number | null;
};

export type ParsedConsoleRoute = {
  activeTab: ConsoleTab;
  selectedIndexId: string | null;
  selectedAssetId: string | null;
  selectedSegmentId: string | null;
  assetDetailTab: AssetDetailTab;
  selectedKnowledgeDomain: SportsDomainGroup | null;
  seekAt: number | null;
};

const defaultAssetDetailTab: AssetDetailTab = "overview";

export function parseConsoleRoute(url: URL): ParsedConsoleRoute {
  const params = url.searchParams;
  const pathParts = url.pathname
    .split("/")
    .filter(Boolean)
    .map((part) => decodeURIComponent(part));
  const root = pathParts[0] ?? "";
  const queryTab = params.get("tab");
  const queryAsset = params.get("asset");
  const queryIndex = params.get("index");
  const queryDetailTab = params.get("assetTab");
  const route: ParsedConsoleRoute = {
    activeTab: tabFromLegacyQuery(queryTab) ?? "system",
    selectedIndexId: queryIndex,
    selectedAssetId: queryAsset,
    selectedSegmentId: params.get("segment"),
    assetDetailTab: isAssetDetailTab(queryDetailTab) ? queryDetailTab : defaultAssetDetailTab,
    selectedKnowledgeDomain: null,
    seekAt: parseFiniteNumber(params.get("t"))
  };

  if (root === "") {
    return route;
  }

  if (root === "dashboard" || root === "system") {
    route.activeTab = "system";
    return route;
  }

  if (root === "search") {
    route.activeTab = "search";
    return route;
  }

  if (root === "knowledge") {
    route.activeTab = "knowledge";
    route.selectedKnowledgeDomain = isSportsDomainGroup(pathParts[1]) ? pathParts[1] : null;
    return route;
  }

  if (root === "assets" || root === "asset-groups" || root === "data") {
    route.activeTab = "data";
    route.selectedIndexId = pathParts[1] ?? queryIndex;
    route.selectedAssetId = queryAsset;
    return route;
  }

  if (root === "asset") {
    route.activeTab = "data";
    route.selectedAssetId = pathParts[1] ?? queryAsset;
    route.assetDetailTab = isAssetDetailTab(pathParts[2])
      ? pathParts[2]
      : isAssetDetailTab(queryDetailTab)
        ? queryDetailTab
        : defaultAssetDetailTab;
    return route;
  }

  return route;
}

export function buildConsoleHref(route: ConsoleRouteState): string {
  const path = buildConsolePath(route);
  const params = new URLSearchParams();
  const assetDetailTab = route.assetDetailTab ?? defaultAssetDetailTab;

  if (route.activeTab === "data" && route.selectedAssetId) {
    if (route.selectedSegmentId) params.set("segment", route.selectedSegmentId);
    if (typeof route.seekAt === "number" && Number.isFinite(route.seekAt)) params.set("t", route.seekAt.toFixed(2));
    if (assetDetailTab !== "overview" && !path.endsWith(`/${assetDetailTab}`)) params.set("assetTab", assetDetailTab);
  }

  const search = params.toString();
  return search ? `${path}?${search}` : path;
}

export function buildConsoleUrl(baseHref: string, route: ConsoleRouteState): string {
  const base = new URL(baseHref);
  const href = buildConsoleHref(route);
  const next = new URL(href, base.origin);
  return next.toString();
}

export function consoleLocationKey(href: string): string {
  const url = new URL(href);
  return `${url.pathname}${url.search}`;
}

function buildConsolePath(route: ConsoleRouteState) {
  if (route.activeTab === "search") return "/search";
  if (route.activeTab === "knowledge") {
    return route.selectedKnowledgeDomain ? `/knowledge/${encodeURIComponent(route.selectedKnowledgeDomain)}` : "/knowledge";
  }
  if (route.activeTab === "data") {
    const assetDetailTab = route.assetDetailTab ?? defaultAssetDetailTab;
    if (route.selectedAssetId) {
      const base = `/asset/${encodeURIComponent(route.selectedAssetId)}`;
      return assetDetailTab === "overview" ? base : `${base}/${assetDetailTab}`;
    }
    return route.selectedIndexId ? `/assets/${encodeURIComponent(route.selectedIndexId)}` : "/assets";
  }
  return "/system";
}

function isAssetDetailTab(value: string | null | undefined): value is AssetDetailTab {
  return value === "overview" || value === "workflow" || value === "timeline";
}

function isSportsDomainGroup(value: string | null | undefined): value is SportsDomainGroup {
  return value === "sports.football" || value === "sports.american_football";
}

function tabFromLegacyQuery(value: string | null): ConsoleTab | null {
  if (value === "dashboard") return "system";
  if (value === "data" || value === "knowledge" || value === "search" || value === "system") return value;
  return null;
}

function parseFiniteNumber(value: string | null) {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
