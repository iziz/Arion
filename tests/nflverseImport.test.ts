import assert from "node:assert/strict";
import test from "node:test";
import { americanFootballPlaysFromPbpRows } from "../server/nflverseImport";

test("nflverse play-by-play rows normalize into American-football play metadata", () => {
  const [play] = americanFootballPlaysFromPbpRows([
    {
      "game id": "2025_01_DAL_PHI",
      "play id": "1234",
      season: "2025",
      week: "1",
      "game date": "2025-09-04",
      "home team": "PHI",
      "away team": "DAL",
      posteam: "PHI",
      defteam: "DAL",
      down: "3",
      ydstogo: "7",
      yrdln: "PHI 42",
      "yardline 100": "42",
      qtr: "2",
      time: "12:34",
      "play type": "pass",
      desc: "Jalen Hurts pass complete short right to A.J. Brown for 12 yards, TOUCHDOWN.",
      "yards gained": "12",
      touchdown: "1",
      "passer player id": "00-0036389",
      "passer player name": "Jalen Hurts",
      "receiver player id": "00-0035676",
      "receiver player name": "A.J. Brown"
    }
  ], 2025);

  assert.equal(play.provider, "nflverse");
  assert.equal(play.gameId, "2025_01_DAL_PHI");
  assert.equal(play.playId, "1234");
  assert.equal(play.homeTeam, "Philadelphia Eagles");
  assert.equal(play.awayTeam, "Dallas Cowboys");
  assert.equal(play.down, 3);
  assert.equal(play.distance, 7);
  assert.equal(play.yardline100, 42);
  assert.equal(play.touchdown, true);
  assert.equal(play.passerPlayerId, "00-0036389");
  assert.equal(play.receiverPlayerName, "A.J. Brown");
  assert.match(play.sourceText, /gameId=2025_01_DAL_PHI/);
  assert.match(play.sourceText, /3rd and 7/);
});
