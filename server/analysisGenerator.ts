import type { AnalysisResult, AssetRecord, ClipResult, TimelineSegment, VerificationCheck } from "../shared/types";

export type AnalysisGenerationInput = {
  question: string;
  asset: AssetRecord;
  chapters: TimelineSegment[];
  clips: ClipResult[];
  signals: string[];
  patterns: AnalysisResult["patterns"];
  verification: VerificationCheck[];
};

export type AnalysisGenerationOutput = {
  answer: string;
  summary?: string;
  report: AnalysisResult["report"];
  generator: AnalysisResult["generator"];
};

export interface AnalysisGenerator {
  provider: string;
  model: string;
  mode: AnalysisResult["generator"]["mode"];
  generate(input: AnalysisGenerationInput): Promise<AnalysisGenerationOutput>;
}

export function createAnalysisGenerator(): AnalysisGenerator {
  const provider = (process.env.ANALYSIS_GENERATOR ?? "local").trim().toLowerCase();
  if (provider === "http") {
    const url = process.env.ANALYSIS_GENERATOR_URL?.trim();
    if (url) return new HttpAnalysisGenerator(url, process.env.ANALYSIS_GENERATOR_MODEL ?? "external-video-language-generator");
  }
  return new LocalAnalysisGenerator(provider === "http" ? "http-unconfigured" : "local");
}

class LocalAnalysisGenerator implements AnalysisGenerator {
  provider: string;
  model = "local-grounded-report-v1";
  mode: AnalysisResult["generator"]["mode"] = "local";

  constructor(provider: string) {
    this.provider = provider;
    if (provider !== "local") this.mode = "fallback";
  }

  async generate(input: AnalysisGenerationInput): Promise<AnalysisGenerationOutput> {
    const verified = input.verification.filter((check) => check.status === "pass").length;
    const uncertain = input.verification.filter((check) => check.status === "soft_pass" || check.status === "unknown").length;
    const failed = input.verification.filter((check) => check.status === "fail").length;
    const answer =
      input.question.trim().length > 0
        ? `Grounded analysis for "${input.question}" used ${input.chapters.length} retrieved moments with ${verified} verified constraints, ${uncertain} soft or missing constraints, and ${failed} failed constraints. ${
            input.signals.length > 0 ? `Strongest signals are ${input.signals.slice(0, 6).join(", ")}.` : "No grounded signals were available."
          } Review ${input.chapters.map((chapter) => `${formatTime(chapter.start)}-${formatTime(chapter.end)}`).join(", ") || "no grounded moments"}.`
        : `The asset is indexed with ${input.asset.timeline.length} segments and emphasizes ${input.signals.slice(0, 5).join(", ")}.`;

    return {
      answer,
      summary: input.asset.summary,
      report: buildLocalReport(input),
      generator: {
        provider: this.provider,
        model: this.model,
        mode: this.mode
      }
    };
  }
}

class HttpAnalysisGenerator implements AnalysisGenerator {
  provider = "http";
  mode: AnalysisResult["generator"]["mode"] = "http";

  constructor(
    private readonly url: string,
    public readonly model: string
  ) {}

  async generate(input: AnalysisGenerationInput): Promise<AnalysisGenerationOutput> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        task: "grounded_video_analysis",
        question: input.question,
        asset: {
          id: input.asset.id,
          title: input.asset.title,
          indexId: input.asset.indexId,
          summary: input.asset.summary
        },
        clips: input.clips,
        signals: input.signals,
        patterns: input.patterns,
        verification: input.verification
      })
    });
    if (!response.ok) {
      const fallback = await new LocalAnalysisGenerator("http-error").generate(input);
      return {
        ...fallback,
        generator: {
          provider: "http-error",
          model: this.model,
          mode: "fallback"
        }
      };
    }
    const parsed = (await response.json()) as Partial<AnalysisGenerationOutput>;
    const fallbackReport = buildLocalReport(input);
    return {
      answer: typeof parsed.answer === "string" && parsed.answer.trim() ? parsed.answer : fallbackReport.sections[0]?.body ?? "No generated answer was returned.",
      summary: typeof parsed.summary === "string" ? parsed.summary : input.asset.summary,
      report: parsed.report ?? fallbackReport,
      generator: {
        provider: "http",
        model: this.model,
        mode: "http"
      }
    };
  }
}

function buildLocalReport(input: AnalysisGenerationInput): AnalysisResult["report"] {
  const passed = input.verification.filter((check) => check.status === "pass").length;
  const total = input.verification.length;
  const confidence = input.clips.length > 0 ? Number((input.clips.reduce((sum, clip) => sum + clip.confidence, 0) / input.clips.length).toFixed(2)) : 0;
  const topGroups = input.patterns.topGroups.slice(0, 5).map((group) => `${group.label} (${group.count}/${input.patterns.totalMoments})`);
  const verifiedRatio = total > 0 ? `${passed}/${total}` : "0/0";
  return {
    title: input.question.trim() ? `Grounded report for ${input.question}` : `Asset report for ${input.asset.title}`,
    confidence,
    sections: [
      {
        heading: "Retrieval Grounding",
        body: `${input.clips.length} clips were selected from indexed timeline moments. Structured verification passed ${verifiedRatio} constraints.`,
        bullets: input.clips.slice(0, 5).map((clip) => `${clip.title}: ${clip.event}${clip.player ? ` - ${clip.player}` : ""}`)
      },
      {
        heading: "Pattern Summary",
        body: input.patterns.totalMoments > 0 ? "The aggregator grouped retrieved moments by event, role, zone, season, and tracking signals." : "No grounded moments were available for aggregation.",
        bullets: topGroups.length > 0 ? topGroups : ["No dominant pattern group was available."]
      },
      {
        heading: "Operational Notes",
        body: input.signals.length > 0 ? `Primary indexed signals: ${input.signals.slice(0, 6).join(", ")}.` : "No strong indexed signals were available.",
        bullets: input.patterns.gaps.length > 0 ? input.patterns.gaps.slice(0, 5) : ["No major indexed evidence gaps were detected for the selected clips."]
      }
    ],
    limitations: input.patterns.gaps.length > 0 ? input.patterns.gaps : ["This report is generated from indexed metadata and local heuristics, not direct foundation-model generation."]
  };
}

function formatTime(seconds: number) {
  const safe = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return `${minutes}:${rest.toString().padStart(2, "0")}`;
}
