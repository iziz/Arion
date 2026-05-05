import type { DomainEvent, KnowledgeDomainGroup } from "../../shared/types";

export const ONTOLOGY_VERSION = "sports-domain-v1";

export type DomainQueryProfile = {
  expandedText: string;
  domains: KnowledgeDomainGroup[];
  labels: string[];
  football: {
    fieldZones: NonNullable<DomainEvent["football"]>["fieldZone"][];
    passTypes: NonNullable<DomainEvent["football"]>["passType"][];
    eventTypes: string[];
    receiverRequired: boolean;
    playerRequired: boolean;
  };
  americanFootball: {
    eventTypes: string[];
    pressureRequired: boolean;
    quarterbackRequired: boolean;
  };
};

export type OntologyRule = {
  label: string;
  terms: string[];
  aliases: string[];
};

export const footballRules = {
  domain: {
    label: "sports.football",
    terms: [
      "football",
      "soccer",
      "축구",
      "fifa",
      "uefa",
      "premier league",
      "bundesliga",
      "champions league",
      "haaland",
      "striker",
      "keeper",
      "goalkeeper",
      "goal",
      "shot",
      "pass",
      "cross",
      "offside",
      "spielzug",
      "tor",
      "stürmer",
      "stuermer"
    ],
    aliases: ["football", "soccer", "축구"]
  },
  passTypes: [
    {
      label: "pass.through_ball",
      terms: [
        "through ball",
        "through-ball",
        "스루패스",
        "스루 패스",
        "침투패스",
        "침투 패스",
        "killer pass",
        "ball in behind",
        "pass in behind",
        "in die tiefe",
        "über die spitze",
        "ueber die spitze",
        "over the top"
      ],
      aliases: ["through ball", "스루패스", "침투패스"]
    },
    {
      label: "pass.cross",
      terms: ["cross", "크로스", "flanke", "wide delivery"],
      aliases: ["cross", "크로스"]
    },
    {
      label: "pass.cutback",
      terms: ["cutback", "cut back", "컷백", "pull back"],
      aliases: ["cutback", "컷백"]
    },
    {
      label: "pass.long_ball",
      terms: ["long ball", "롱볼", "long pass", "diagonal ball"],
      aliases: ["long ball", "롱볼"]
    },
    {
      label: "pass.short_pass",
      terms: ["short pass", "패스", "pass", "passes", "passing", "ball"],
      aliases: ["pass", "패스"]
    }
  ] satisfies OntologyRule[],
  eventTypes: [
    {
      label: "event.pass_receive",
      terms: [
        "receive",
        "receives",
        "received",
        "receiver",
        "receiving",
        "first touch",
        "controls",
        "takes",
        "latch onto",
        "gets on the end",
        "받는",
        "받아",
        "받았다",
        "리시브",
        "연결",
        "annahme",
        "annimmt",
        "bekommt"
      ],
      aliases: ["receive", "receiver", "받는 선수"]
    },
    {
      label: "event.shot",
      terms: ["shot", "shoots", "finish", "finishes", "슈팅", "슛", "마무리", "abschluss"],
      aliases: ["shot", "슛"]
    },
    {
      label: "event.dribble",
      terms: ["dribble", "dribbles", "dribbling", "take on", "takes on", "carry", "carries", "드리블", "돌파", "운반"],
      aliases: ["dribble", "드리블"]
    },
    {
      label: "event.progressive_pass",
      terms: ["progressive pass", "line breaking pass", "breaks the line", "전진 패스", "라인 브레이킹", "라인브레이킹"],
      aliases: ["progressive pass", "전진 패스"]
    },
    {
      label: "event.save",
      terms: ["save", "saves", "keeper save", "goalkeeper save", "선방", "세이브"],
      aliases: ["save", "선방"]
    },
    {
      label: "event.pressure",
      terms: ["pressure", "under pressure", "pressured", "압박", "pressure situation"],
      aliases: ["pressure", "압박"]
    },
    {
      label: "event.scramble",
      terms: ["scramble", "scrambles", "scramble play", "스크램블"],
      aliases: ["scramble", "스크램블"]
    },
    {
      label: "event.pocket_escape",
      terms: ["pocket escape", "escapes the pocket", "out of the pocket", "포켓 탈출"],
      aliases: ["pocket escape", "포켓 탈출"]
    },
    {
      label: "event.throw_on_run",
      terms: ["throw on the run", "throws on the run", "rolling right", "rolling left", "이동 중 패스"],
      aliases: ["throw on the run"]
    }
  ] satisfies OntologyRule[],
  fieldZones: [
    {
      label: "zone.final_third",
      terms: ["final third", "attacking third", "파이널 서드", "공격 진영", "공격 지역", "last third", "letzte drittel"],
      aliases: ["final third", "attacking third", "파이널 서드"]
    },
    {
      label: "zone.penalty_area",
      terms: ["penalty area", "box", "six yard", "박스", "페널티 박스", "goal area", "strafraum"],
      aliases: ["penalty area", "box", "박스"]
    },
    {
      label: "zone.middle_third",
      terms: ["middle third", "midfield", "미드필드", "중원", "mittelfeld"],
      aliases: ["middle third", "midfield", "중원"]
    },
    {
      label: "zone.defensive_third",
      terms: ["defensive third", "own third", "수비 진영", "수비 지역"],
      aliases: ["defensive third", "수비 진영"]
    }
  ] satisfies OntologyRule[],
  phase: {
    attack: ["attack", "attacking", "counter", "counterattack", "break", "chance", "찬스", "역습", "공격", "spielzug"],
    setPiece: ["corner", "free kick", "set piece", "코너킥", "프리킥"]
  }
};

export const americanFootballRules = {
  domain: {
    label: "sports.american_football",
    terms: [
      "american football",
      "nfl",
      "national football league",
      "quarterback",
      "qb",
      "pocket",
      "scramble",
      "downfield",
      "snap",
      "pass rush",
      "blitz"
    ],
    aliases: ["american football", "nfl", "quarterback"]
  },
  eventTypes: [
    {
      label: "event.scramble",
      terms: ["scramble", "scrambles", "scramble play", "qb run", "quarterback run", "extends the play", "스크램블"],
      aliases: ["scramble", "qb scramble", "quarterback scramble"]
    },
    {
      label: "event.pressure",
      terms: ["pressure", "under pressure", "pressured", "pass rush", "rush", "blitz", "collapsing pocket", "압박"],
      aliases: ["pressure", "pass rush", "blitz"]
    },
    {
      label: "event.pocket_escape",
      terms: ["pocket escape", "escapes the pocket", "out of the pocket", "breaks contain", "포켓 탈출"],
      aliases: ["pocket escape", "out of the pocket"]
    },
    {
      label: "event.throw_on_run",
      terms: ["throw on the run", "throws on the run", "rolling right", "rolling left", "off-platform throw", "이동 중 패스"],
      aliases: ["throw on the run", "off-platform throw"]
    }
  ] satisfies OntologyRule[]
};
