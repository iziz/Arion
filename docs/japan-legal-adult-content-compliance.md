# Japan Legal Adult Content Compliance

Last checked against code: 2026-05-21.

This document describes the `adult.jp_legal` related-knowledge source. It is an operational compliance gate for lawful Japan adult video asset groups. It is not legal advice, and it does not make age, consent, obscenity, source-rights, or distribution-law conclusions from model inference.

## Source Scope

`adult.jp_legal` is intentionally different from the sports sources:

- It does not enable knowledge action spotting.
- It does not enable sports detector/tracker stages.
- It does not enable domain VLM refinement until a non-sports compliance prompt and evaluator exist.
- It can coexist with generic video VLM analysis, but VLM output can only create review evidence, not satisfy required compliance checks.

The compliance record is written to `asset.compliance` during the indexing finalize stage when the asset group's `domainIndexing.groups` includes `adult.jp_legal`.

## Compliance Statuses

| Status | Meaning |
| --- | --- |
| `not_applicable` | The asset group is not configured with `adult.jp_legal`. |
| `cleared` | All required metadata tags are present and no review/block indicators were detected. |
| `review_required` | Required metadata is missing or review terms were found in metadata, ASR, OCR, summary, or segment text. |
| `blocked` | An explicit block tag is present. The asset should not be searched, distributed, or treated as cleared until a human compliance operator resolves the block. |

## Required Metadata Tags

The compliance gate requires these explicit tags:

- `jp-adult:age-verified`
- `jp-adult:performer-id-verified`
- `jp-adult:consent-contract`
- `jp-adult:contract-explained`
- `jp-adult:cooling-period-1m`
- `jp-adult:publication-delay-4m`
- `jp-adult:performer-preview`
- `jp-adult:revocation-window-tracked`
- `jp-adult:takedown-ready`
- `jp-adult:mosaic-reviewed`
- `jp-adult:rights-cleared`

These tags represent external operator evidence. Model output, filenames, captions, OCR, ASR, or visual detections cannot satisfy a required tag.

## Explicit Block Tags

The compliance gate blocks an asset when any of these tags are present:

- `jp-adult:block:minor-risk`
- `jp-adult:block:age-unverified`
- `jp-adult:block:consent-withdrawn`
- `jp-adult:block:takedown-requested`
- `jp-adult:block:unmosaiced`
- `jp-adult:block:illegal-source`

Block tags are meant for ingestion, operator review, takedown, and rights workflows. They should be removed only after the underlying compliance issue is resolved and documented.

## Review Indicators

The evaluator scans asset metadata and indexed text for high-risk terms such as underage/minor indicators, consent withdrawal, takedown requests, stop-distribution requests, and uncensored distribution indicators. These indicators create `review_required`; they do not automatically prove a violation.

## Runtime Trace

When applied, the finalize stage appends a model trace entry:

```text
compliance:adult.jp_legal:<status>:missing=<n>:review=<n>:blocked=<n>
```

This keeps compliance evaluation visible in the same operational trace channel as model and indexing stages.

## Retrieval Enforcement

Assets with `review_required` or `blocked` compliance status are excluded from retrieval in both the in-memory ranking path and PostgreSQL text/visual vector search. Operators can still inspect the asset record and compliance checklist in the console, but the asset is not treated as searchable evidence until the compliance status is `cleared`.

## References

The implementation uses these public legal-reference anchors as operational requirements:

- Cabinet Office: AV performance harm prevention and relief law summary: <https://www.gender.go.jp/policy/no_violence/avjk/houritsu.html>
- Japanese Penal Code Article 175 translation: <https://www.japaneselawtranslation.go.jp/en/laws/view/3581/en>
- Child prostitution and child pornography protection act translation: <https://www.japaneselawtranslation.go.jp/en/laws/view/100/en>
