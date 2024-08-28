/**
 * Temporary priorities that override the routing.
 */

import { getCounter, Location, Monster } from "kolmafia";
import {
  $effect,
  $item,
  $location,
  $skill,
  get,
  getTodaysHolidayWanderers,
  have,
  undelay,
} from "libram";
import { CombatStrategy } from "./combat";
import { moodCompatible } from "./moods";
import { getModifiersFrom } from "./outfit";
import { forceItemSources, forceNCPossible, yellowRaySources } from "./resources";
import { globalStateCache } from "./state";
import { Priority, Task } from "./task";

export class Priorities {
  static Wanderer: Priority = { score: 20000, reason: "Wanderer" };
  static Always: Priority = { score: 10000, reason: "Forced" };
  static GoodForceNC: Priority = { score: 8000, reason: "Forcing NC" };
  static Free: Priority = { score: 1000, reason: "Free action" };
  static Start: Priority = { score: 900, reason: "Initial tasks" };
  static NeedAdv: Priority = { score: 200, reason: "Low on adventures" };
  static LastCopyableMonster: Priority = { score: 100, reason: "Copy last monster" };
  static Effect: Priority = { score: 20, reason: "Useful effect" };
  static GoodOrb: Priority = { score: 15, reason: "Target orb monster" };
  static BestCosmicBowlingBall: Priority = {
    score: 14,
    reason: "Use cosmic bowling ball + Melodramedary",
  };
  static CosmicBowlingBall: Priority = { score: 11, reason: "Use cosmic bowling ball" };
  static FreeRun: Priority = { score: 10.5, reason: "Free run away" }
  static GoodYR: Priority = { score: 10, reason: "Yellow ray" };
  static GoodAutumnaton: Priority = { score: 4, reason: "Setup Autumnaton" };
  static GoodCamel: Priority = { score: 3, reason: "Melodramedary is ready" };
  static MinorEffect: Priority = { score: 2, reason: "Useful minor effect" };
  static GoodBanish3: Priority = { score: 0.7, reason: "3+ banishes committed" };
  static GoodBanish2: Priority = { score: 0.6, reason: "2 banishes committed" };
  static GoodBanish: Priority = { score: 0.5, reason: "1 banish committed" };
  static SeekJellyfish: Priority = { score: 0.1, reason: "Get Spectral Jellyfish" };
  static None: Priority = { score: 0 };
  static BadForcingNC: Priority = { score: -0.4, reason: "Not forcing NC" };
  static BadAutumnaton: Priority = { score: -2, reason: "Autumnaton in use here" };
  static BadTrain: Priority = { score: -3, reason: "Use Trainset" };
  static BadOrb: Priority = { score: -4, reason: "Avoid orb monster" };
  static BadCamel: Priority = { score: -5, reason: "Waiting for Melodramedary" };
  static BadHoliday: Priority = { score: -10 };
  static BadYR: Priority = { score: -16, reason: "Too early for yellow ray" };
  static BadSweat: Priority = { score: -20, reason: "Not enough sweat" };
  static BadProtonic: Priority = { score: -40, reason: "Protonic ghost here" };
  static BadMood: Priority = { score: -100, reason: "Wrong effects" };
  static Last: Priority = { score: -10000, reason: "Only if nothing else" };
}

export class Prioritization {
  private priorities = new Set<Priority>();
  private orb_monster?: Monster = undefined;

  static fixed(priority: Priority) {
    const result = new Prioritization();
    result.priorities.add(priority);
    return result;
  }

  static from(task: Task): Prioritization {
    const result = new Prioritization();
    const base = task.priority?.() ?? Priorities.None;
    if (Array.isArray(base)) {
      for (const priority of base) result.priorities.add(priority);
    } else {
      if (base !== Priorities.None) result.priorities.add(base);
    }

    // Prioritize getting a YR
    const yr_needed =
      task.combat?.can("yellowRay") ||
      (task.combat?.can("forceItems") && !forceItemSources.find((s) => s.available()));
    if (yr_needed && yellowRaySources.find((yr) => yr.available())) {
      if (have($effect`Everything Looks Yellow`)) {
        if (!have($skill`Emotionally Chipped`) || get("_feelEnvyUsed") === 3)
          result.priorities.add(Priorities.BadYR);
      } else result.priorities.add(Priorities.GoodYR);
    }

    // Dodge useless monsters with the orb
    if (task.do instanceof Location) {
      const next_monster = globalStateCache.orb().prediction(task.do);
      if (next_monster !== undefined) {
        result.orb_monster = next_monster;
        result.priorities.add(orbPriority(task, next_monster));
      }
    }

    // Ensure that the current +/- combat effects are compatible
    //  (Macguffin/Forest is tough and doesn't need much +combat; just power though)
    const modifier = getModifiersFrom(undelay(task.outfit));
    if (!moodCompatible(modifier) && task.name !== "Macguffin/Forest") {
      result.priorities.add(Priorities.BadMood);
    }

    // Burn off desert debuffs
    if (
      (have($effect`Prestidigysfunction`) || have($effect`Turned Into a Skeleton`)) &&
      task.combat &&
      task.combat.can("killItem")
    ) {
      result.priorities.add(Priorities.BadMood);
    }

    // If we have already used banishes in the zone, prefer it
    if (!task?.ignore_banishes?.()) {
      const numBanished = globalStateCache.banishes().numPartiallyBanished(task);
      if (numBanished === 1) result.priorities.add(Priorities.GoodBanish);
      else if (numBanished === 2) result.priorities.add(Priorities.GoodBanish2);
      else if (numBanished >= 3) result.priorities.add(Priorities.GoodBanish3);
    }

    // Avoid ML boosting zones when a scaling holiday wanderer is due
    if (modifier?.includes("ML") && !modifier.match("-[\\d .]*ML")) {
      if (getTodaysHolidayWanderers().length > 0 && getCounter("holiday") <= 0) {
        result.priorities.add(Priorities.BadHoliday);
      }
    }

    // Handle potential NC forcers in a zone
    if (undelay(task.ncforce)) {
      if (get("noncombatForcerActive")) {
        result.priorities.add(Priorities.GoodForceNC);
      } else if (forceNCPossible()) {
        result.priorities.add(Priorities.BadForcingNC);
      }
    }

    // Delay if there is a protonic ghost we have not killed
    if (
      have($item`protonic accelerator pack`) &&
      get("questPAGhost") !== "unstarted" &&
      get("ghostLocation") &&
      get("ghostLocation") === task.do
    )
      result.priorities.add(Priorities.BadProtonic);

    // Prefer tasks where the cosmic bowling ball is useful
    const ball_useful =
      task.combat === undefined ||
      task.combat.can("ignore") ||
      task.combat.can("banish") ||
      task.combat.getDefaultAction() === undefined;
    const ball_may_not_be_useful =
      task.combat?.can("kill") ||
      task.combat?.can("killHard") ||
      task.combat?.can("killItem") ||
      task.combat?.can("killFree") ||
      task.combat?.can("forceItems") ||
      task.combat?.can("yellowRay");
    const location_blacklist = [
      $location`The Shore, Inc. Travel Agency`,
      $location`The Hidden Temple`,
      $location`The Oasis`,
      $location`Lair of the Ninja Snowmen`,
    ];
    const location_whitelist = [
      $location`The Haunted Bathroom`,
      $location`The Castle in the Clouds in the Sky (Top Floor)`,
      $location`Lair of the Ninja Snowmen`,
      $location`The Batrat and Ratbat Burrow`,
    ];
    const location_in_blacklist =
      task.do instanceof Location && location_blacklist.includes(task.do);
    const location_in_whitelist =
      task.do instanceof Location && location_whitelist.includes(task.do);

    if (
      location_in_whitelist ||
      (!task.freeaction &&
        !task.freecombat &&
        ball_useful &&
        !ball_may_not_be_useful &&
        !location_in_blacklist)
    ) {
      if (have($item`cosmic bowling ball`) || get("cosmicBowlingBallReturnCombats") === 0) {
        result.priorities.add(Priorities.CosmicBowlingBall);
      }
      if (!have($effect`Everything Looks Green`) && have($item`spring shoes`)) {
        result.priorities.add(Priorities.FreeRun);
      }
    }

    return result;
  }

  public explain(): string {
    const result = [...this.priorities]
      .map((priority) => priority.reason)
      .filter((priority) => priority !== undefined)
      .join(", ");
    if (this.orb_monster) return result.replace("orb monster", `${this.orb_monster}`);
    else return result;
  }

  public explainWithColor(): string | undefined {
    const result = [...this.priorities]
      .map((priority) => {
        if (priority.reason === undefined) return undefined;
        if (priority.score > 0) return `<font color='blue'>${priority.reason}</font>,`;
        else if (priority.score < 0) return `<font color='red'>${priority.reason}</font>,`;
        else return undefined;
      })
      .filter((priority) => priority !== undefined)
      .join(" ");
    if (result === undefined || result.length === 0) return undefined;

    const trimmed_result = result.slice(0, -1);
    if (this.orb_monster) return trimmed_result.replace("orb monster", `${this.orb_monster}`);
    else return trimmed_result;
  }

  public has(priorty: Priority) {
    for (const prior of this.priorities) {
      if (prior.score === priorty.score) return true;
    }
    return false;
  }

  public score(): number {
    let result = 0;
    for (const priority of this.priorities) {
      result += priority.score;
    }
    return result;
  }
}

function orbPriority(task: Task, monster: Monster): Priority {
  if (!(task.do instanceof Location)) return Priorities.None;

  // Determine if a monster is useful or not based on the combat goals
  if (task.orbtargets === undefined) {
    const task_combat = task.combat ?? new CombatStrategy();
    const next_monster_strategy = task_combat.currentStrategy(monster);

    const next_useless =
      next_monster_strategy === "ignore" ||
      next_monster_strategy === "ignoreNoBanish" ||
      next_monster_strategy === "ignoreSoftBanish" ||
      next_monster_strategy === "banish" ||
      next_monster_strategy === undefined;

    const others_useless =
      task_combat.can("ignore") ||
      task_combat.can("ignoreNoBanish") ||
      task_combat.can("banish") ||
      task_combat.can("ignoreSoftBanish") ||
      task_combat.getDefaultAction() === undefined;

    const others_useful =
      task_combat.can("kill") ||
      task_combat.can("killFree") ||
      task_combat.can("killHard") ||
      task_combat.can("killItem");

    if (next_useless && others_useful) {
      return Priorities.BadOrb;
    } else if (!next_useless && others_useless) {
      return Priorities.GoodOrb;
    } else {
      return Priorities.None;
    }
  }

  // Use orbtargets to decide if the next monster is useful
  const targets = task.orbtargets();
  if (targets === undefined) return Priorities.None;
  if (targets.length === 0) return Priorities.None;
  if (targets.find((t) => t === monster) === undefined) {
    return Priorities.BadOrb;
  } else {
    return Priorities.GoodOrb;
  }
}
