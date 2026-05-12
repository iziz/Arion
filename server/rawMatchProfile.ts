import type { AssetRecord, EvidenceTrustTier, MatchClockMapping, RawMatchVideoProfile, TimelineSegment, VisionTrackTeamCluster } from "../shared/types";

const RAW_MATCH_PROFILE_ID = "raw-match-video-profile-v1";

export function buildRawMatchVideoProfile(asset: AssetRecord, timeline: TimelineSegment[] = asset.timeline): RawMatchVideoProfile {
  const visionSegments = timeline.filter((segment) => Boolean(segment.sceneData?.vision));
  const trackingSegments = visionSegments.filter((segment) => segment.sceneData?.vision?.tracking?.status === "tracked");
  const playerTrackedSegments = visionSegments.filter((segment) => (segment.sceneData?.vision?.tracking?.playerTracks?.length ?? 0) > 0);
  const ballTrackedSegments = visionSegments.filter((segment) => Boolean(segment.sceneData?.vision?.tracking?.ballTrackId));
  const trackCoverages = visionSegments.map((segment) => segment.sceneData?.vision?.tracking?.trackCoverage ?? segment.sceneData?.vision?.tracking?.continuity ?? 0);
  const playerCoverage = ratio(playerTrackedSegments.length, Math.max(1, visionSegments.length));
  const ballCoverage = ratio(ballTrackedSegments.length, Math.max(1, visionSegments.length));
  const averageTrackCoverage = average(trackCoverages);
  const idSwitches = sum(visionSegments.map((segment) => segment.sceneData?.vision?.tracking?.idSwitches ?? 0));
  const pitchConfidence = average(visionSegments.map((segment) => segment.sceneData?.vision?.pitch.confidence ?? 0));
  const clockCandidates = collectClockCandidates(timeline);
  const scoreboardTexts = collectScoreboardTexts(timeline);
  const teamKitClusters = collectTeamKitClusters(timeline);
  const identityCandidateCount = asset.identity?.playerIdentityCandidates.length ?? 0;
  const confirmedAssignmentCount = asset.identity?.trackIdentityAssignments.filter((candidate) => candidate.status === "confirmed").length ?? 0;
  const jerseyTracks = collectPlayerTracks(timeline).filter((track) => (track.jerseyNumberCandidates?.length ?? 0) > 0);
  const faceTracks = collectPlayerTracks(timeline).filter((track) => (track.faceIdentityCandidates?.length ?? 0) > 0);
  const eventTypes = collectEventTypes(timeline);
  const sourceContext = buildSourceContext(asset);
  const trackingLimitations = buildTrackingLimitations({ visionSegments, playerCoverage, ballCoverage, averageTrackCoverage, idSwitches });
  const identityLimitations = buildIdentityLimitations({ sourceStatus: sourceContext.status, jerseyTracks: jerseyTracks.length, faceTracks: faceTracks.length, identityCandidateCount });
  const eventLimitations = buildEventLimitations({ ballCoverage, averageTrackCoverage, eventTypes: eventTypes.length });
  const profileStatus = sourceContext.status === "confirmed" && trackingLimitations.length === 0 ? "ready" : visionSegments.length > 0 || eventTypes.length > 0 || scoreboardTexts.length > 0 ? "partial" : "unknown";

  return {
    generatedBy: RAW_MATCH_PROFILE_ID,
    status: profileStatus,
    sourceContext,
    technical: {
      duration: asset.duration,
      fps: asset.technicalMetadata.frameRate,
      resolution: asset.width && asset.height ? `${asset.width}x${asset.height}` : null,
      videoCodec: asset.technicalMetadata.videoCodec,
      audioCodec: asset.technicalMetadata.audioCodec,
      qualityFlags: buildQualityFlags(asset)
    },
    observed: {
      pitchVisible: pitchConfidence >= 0.5 || visionSegments.some((segment) => segment.sceneData?.vision?.pitch.present),
      pitchConfidence,
      scoreboardTexts,
      clockCandidates,
      teamKitClusters
    },
    trackingReadiness: {
      playerCoverage,
      ballCoverage,
      averageTrackCoverage,
      idSwitches,
      usableForEvents: ballCoverage >= 0.12 && averageTrackCoverage >= 0.12,
      usableForIdentity: playerCoverage >= 0.18 && idSwitches <= Math.max(6, trackingSegments.length * 2),
      limitations: trackingLimitations
    },
    identityReadiness: {
      jerseyOcrUsable: jerseyTracks.length > 0,
      faceUsable: faceTracks.length > 0,
      rosterRequired: sourceContext.status !== "confirmed",
      candidateCount: identityCandidateCount + jerseyTracks.length + faceTracks.length,
      confirmedAssignmentCount,
      evidence: [
        jerseyTracks.length > 0 ? `${jerseyTracks.length} player track(s) have crop jersey OCR candidates.` : "",
        faceTracks.length > 0 ? `${faceTracks.length} player track(s) have roster-backed face embedding candidates.` : "",
        identityCandidateCount > 0 ? `${identityCandidateCount} roster/context identity candidate(s) were generated.` : "",
        confirmedAssignmentCount > 0 ? `${confirmedAssignmentCount} identity assignment(s) were reviewer-confirmed.` : ""
      ].filter(Boolean),
      limitations: identityLimitations
    },
    eventReadiness: {
      candidateCount: timeline.reduce((count, segment) => count + (segment.sceneData?.vision?.eventCandidates.length ?? 0), 0),
      domainEventCount: timeline.reduce((count, segment) => count + (segment.domain?.events.length ?? 0), 0),
      eventTypes,
      limitations: eventLimitations
    },
    trustSummary: buildTrustSummary(timeline),
    limitations: buildProfileLimitations(sourceContext.status, trackingLimitations, identityLimitations, eventLimitations),
    updatedAt: new Date().toISOString()
  };
}

function buildSourceContext(asset: AssetRecord): RawMatchVideoProfile["sourceContext"] {
  const contexts = asset.identity?.matchContexts ?? [];
  const confirmed = contexts.filter((context) => context.status === "confirmed");
  const candidates = contexts.filter((context) => context.status === "candidate");
  const selected = confirmed.length > 0 ? confirmed : candidates;
  return {
    status: confirmed.length > 0 ? "confirmed" : candidates.length > 0 ? "partial" : "unknown",
    matchContextIds: selected.map((context) => context.id).slice(0, 12),
    teams: unique(selected.flatMap((context) => [context.homeTeam, context.awayTeam]).filter(isPresent)).slice(0, 12),
    competitions: unique(selected.map((context) => context.competition).filter(isPresent)).slice(0, 8),
    evidence: selected.flatMap((context) => context.evidence).slice(0, 12)
  };
}

function collectScoreboardTexts(timeline: TimelineSegment[]) {
  const candidates = timeline.flatMap((segment) => {
    const text = segment.sceneData?.text;
    return [...(text?.screenText ?? []), ...(text?.overlays ?? []), ...(text?.watermarks ?? [])];
  });
  return unique(
    candidates
      .map((value) => value.trim())
      .filter((value) => value.length >= 2)
      .filter((value) => /\d{1,2}[:.-]\d{2}|\b\d+\s*[-:]\s*\d+\b|1H|2H|ET|PEN|Q[1-4]/i.test(value))
  ).slice(0, 24);
}

function collectClockCandidates(timeline: TimelineSegment[]): MatchClockMapping[] {
  const identityClockMappings = timeline.flatMap((segment) => segment.identity?.clockMappings ?? []);
  if (identityClockMappings.length > 0) return dedupeClockMappings(identityClockMappings).slice(0, 16);
  return collectScoreboardTexts(timeline)
    .flatMap((text) => {
      const clock = text.match(/\b(\d{1,2})[:.](\d{2})\b/);
      if (!clock) return [];
      const mapping: MatchClockMapping = {
        videoStart: 0,
        videoEnd: 0,
        period: "unknown",
        matchMinuteStart: Number(clock[1]),
        matchMinuteEnd: Number(clock[1]),
        clockText: clock[0],
        source: "ocr",
        confidence: 0.42,
        evidence: [`OCR scoreboard clock candidate: ${text}`]
      };
      return [mapping];
    })
    .slice(0, 16);
}

function collectTeamKitClusters(timeline: TimelineSegment[]): RawMatchVideoProfile["observed"]["teamKitClusters"] {
  const clusterMap = new Map<VisionTrackTeamCluster, { trackIds: Set<string>; segmentIds: Set<string>; confidences: number[]; colors: Set<string>; evidence: Set<string> }>();
  for (const segment of timeline) {
    for (const track of segment.sceneData?.vision?.tracking?.playerTracks ?? []) {
      const cluster = track.teamCluster;
      if (!cluster) continue;
      const item =
        clusterMap.get(cluster) ??
        {
          trackIds: new Set<string>(),
          segmentIds: new Set<string>(),
          confidences: [],
          colors: new Set<string>(),
          evidence: new Set<string>()
        };
      item.trackIds.add(track.id);
      item.segmentIds.add(segment.id);
      item.confidences.push(track.teamConfidence ?? 0);
      if (track.appearance?.dominantHex) item.colors.add(track.appearance.dominantHex);
      for (const evidence of track.teamEvidence ?? []) item.evidence.add(evidence);
      clusterMap.set(cluster, item);
    }
  }
  return Array.from(clusterMap.entries())
    .map(([cluster, item]) => ({
      cluster,
      trackCount: item.trackIds.size,
      segmentCount: item.segmentIds.size,
      confidence: average(item.confidences),
      colors: Array.from(item.colors).slice(0, 8),
      trust: "detected" as EvidenceTrustTier,
      evidence: Array.from(item.evidence).slice(0, 8)
    }))
    .sort((a, b) => b.trackCount - a.trackCount || b.confidence - a.confidence);
}

function collectPlayerTracks(timeline: TimelineSegment[]) {
  return timeline.flatMap((segment) => segment.sceneData?.vision?.tracking?.playerTracks ?? []);
}

function collectEventTypes(timeline: TimelineSegment[]): RawMatchVideoProfile["eventReadiness"]["eventTypes"] {
  const byType = new Map<string, { count: number; confidences: number[]; trust: EvidenceTrustTier }>();
  for (const segment of timeline) {
    for (const event of segment.domain?.events ?? []) {
      const item = byType.get(event.eventType) ?? { count: 0, confidences: [], trust: event.trust ?? "heuristic" };
      item.count += 1;
      item.confidences.push(event.confidence);
      item.trust = strongerTrust(item.trust, event.trust ?? "heuristic");
      byType.set(event.eventType, item);
    }
    const classifier = segment.sceneData?.vision?.eventClassification;
    if (classifier && classifier.label !== "unknown") {
      const item = byType.get(classifier.label) ?? { count: 0, confidences: [], trust: "candidate" as EvidenceTrustTier };
      item.count += 1;
      item.confidences.push(classifier.confidence);
      byType.set(classifier.label, item);
    }
  }
  return Array.from(byType.entries())
    .map(([type, item]) => ({ type, count: item.count, confidence: average(item.confidences), trust: item.trust }))
    .sort((a, b) => b.count - a.count || b.confidence - a.confidence)
    .slice(0, 16);
}

function buildTrustSummary(timeline: TimelineSegment[]): Record<EvidenceTrustTier, number> {
  const summary: Record<EvidenceTrustTier, number> = {
    observed: 0,
    detected: 0,
    aligned: 0,
    candidate: 0,
    inferred: 0,
    heuristic: 0,
    unavailable: 0
  };
  for (const segment of timeline) {
    if (segment.sceneData?.vision?.trust) summary[segment.sceneData.vision.trust] += 1;
    for (const event of segment.domain?.events ?? []) summary[event.trust ?? "heuristic"] += 1;
    if (segment.sceneData?.vision?.eventClassification?.label && segment.sceneData.vision.eventClassification.label !== "unknown") summary.candidate += 1;
  }
  return summary;
}

function buildQualityFlags(asset: AssetRecord) {
  return [
    asset.duration === null ? "duration_unknown" : "",
    asset.technicalMetadata.frameRate === null ? "fps_unknown" : "",
    asset.width === null || asset.height === null ? "resolution_unknown" : "",
    asset.width !== null && asset.width < 1280 ? "low_width" : "",
    asset.height !== null && asset.height < 720 ? "low_height" : "",
    asset.technicalMetadata.videoCodec === null ? "video_codec_unknown" : "",
    asset.technicalMetadata.audioCodec === null ? "audio_unavailable_or_unknown" : "",
    asset.intelligence.ocr.frames.length === 0 ? "no_ocr_frames" : "",
    asset.intelligence.asr.transcript.trim().length === 0 ? "no_asr_transcript" : ""
  ].filter(Boolean);
}

function buildTrackingLimitations(input: { visionSegments: TimelineSegment[]; playerCoverage: number; ballCoverage: number; averageTrackCoverage: number; idSwitches: number }) {
  return [
    input.visionSegments.length === 0 ? "No vision evidence is available for this asset." : "",
    input.playerCoverage < 0.18 ? "Player tracking coverage is low; identity and position inference should stay candidate-level." : "",
    input.ballCoverage < 0.12 ? "Ball tracking coverage is low; pass/shot/carry event confidence should be reduced." : "",
    input.averageTrackCoverage < 0.12 ? "Average tracker coverage is low across timeline segments." : "",
    input.idSwitches > Math.max(6, input.visionSegments.length * 2) ? "Tracker ID switches are high; track continuity is unstable." : ""
  ].filter(Boolean);
}

function buildIdentityLimitations(input: { sourceStatus: RawMatchVideoProfile["sourceContext"]["status"]; jerseyTracks: number; faceTracks: number; identityCandidateCount: number }) {
  return [
    input.sourceStatus !== "confirmed" ? "Match/team/player context is not confirmed; player names must remain candidate evidence." : "",
    input.jerseyTracks === 0 ? "No crop jersey OCR candidates were accepted." : "",
    input.faceTracks === 0 ? "No roster-backed face embedding candidates were accepted." : "",
    input.identityCandidateCount === 0 ? "No roster/context identity candidates were generated." : ""
  ].filter(Boolean);
}

function buildEventLimitations(input: { ballCoverage: number; averageTrackCoverage: number; eventTypes: number }) {
  return [
    input.eventTypes === 0 ? "No structured event candidates were generated." : "",
    input.ballCoverage < 0.12 ? "Ball visibility is insufficient for strong event classification." : "",
    input.averageTrackCoverage < 0.12 ? "Tracking coverage is insufficient for stable sequence-level event reasoning." : ""
  ].filter(Boolean);
}

function buildProfileLimitations(sourceStatus: RawMatchVideoProfile["sourceContext"]["status"], ...groups: string[][]) {
  return unique([
    sourceStatus !== "confirmed" ? "Raw match video mode: competition, teams, players, and clock stay unconfirmed until external context or review evidence agrees." : "",
    ...groups.flat()
  ].filter(Boolean));
}

function dedupeClockMappings(items: MatchClockMapping[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.period}:${item.clockText}:${item.videoStart}:${item.videoEnd}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function strongerTrust(left: EvidenceTrustTier, right: EvidenceTrustTier): EvidenceTrustTier {
  const order: EvidenceTrustTier[] = ["unavailable", "heuristic", "inferred", "candidate", "detected", "aligned", "observed"];
  return order.indexOf(right) > order.indexOf(left) ? right : left;
}

function average(values: number[]) {
  const usable = values.filter((value) => Number.isFinite(value));
  if (usable.length === 0) return 0;
  return Number((usable.reduce((total, value) => total + value, 0) / usable.length).toFixed(3));
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function ratio(value: number, total: number) {
  return Number((value / Math.max(1, total)).toFixed(3));
}

function unique<T>(items: T[]) {
  return Array.from(new Set(items));
}

function isPresent(value: string | null | undefined): value is string {
  return Boolean(value && value.trim());
}
