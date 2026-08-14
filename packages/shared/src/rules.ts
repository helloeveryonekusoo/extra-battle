/**
 * ルールの検査（第2段階）。
 *
 * ★最重要の原則: **警告はするが、禁止はしない。**
 *   ここにある関数は一切 throw しないし、操作を止めない。警告の配列を返すだけ。
 *
 *   理由は、効果が未実装のカードを手で処理する必要があるから。
 *   素朴なルール強制は実在のカードで必ず破綻する:
 *     ジバコイル（ダブルブレイン）      → サポートを1ターンに2枚
 *     ふしぎなアメ / ぬけがけしんか     → 最初の番でも進化する
 *     スカイフィールド / ムゲンゾーン    → ベンチ8匹
 *     ウソッキー（みちをふさぐ）        → ベンチ4匹
 *     ディアルガGX（タイムレスGX）      → 追加の番
 *     オルタージェネシスGX             → サイドを1枚多くとる
 *   ブロックすると、これらが一切遊べなくなる。
 */
import type { Action } from './actions';
import { checkUsability, useKindOf } from './applicability';
import type { CardIndex } from './cards';
// knockout.ts は rules.ts から型（RuleContext）だけを取るので、実行時の循環は起きない
import {
  abilityOf,
  attackAllowanceFor,
  attackBlock,
  canUseAbilityThisTurn,
  getEffectiveAbilityEntries,
} from './derived';
import { cardKindLockOn, multipleLockWarning, playLockFor } from './lock';
import { effectSlotKey } from './effects';
import { hasUsedOncePerGame, ONCE_PER_GAME_LABEL, ruleFor } from './ruleBox';
import { V_UNION_PARTS } from './vUnion';
import { prizesForRuleBox, remainingHpOf, topCardOf } from './knockout';
import { nextPokemonCheckTarget } from './pokemonCheck';
import type {
  CardText,
  GameState,
  OncePerGameKind,
  PlayerId,
  TrainerKind,
  BooleanTurnFlag,
  TurnFlags,
} from './types';

export interface RuleWarning {
  /** 'SUPPORTER_ALREADY_USED' など */
  code: string;
  severity: 'info' | 'warn';
  /** 日本語。そのまま画面に出す */
  message: string;
  /** 該当のカード・スロット */
  refs?: string[];
}

export interface ActionResult {
  state: GameState;
  /** 空配列でも必ず返す */
  warnings: RuleWarning[];
}

/**
 * 検査に必要な外部情報。
 * カード定義がないと「そのカードがサポートか」すら分からないので、
 * サーバーは必ず cards を渡すこと。省略した場合、その検査は静かに飛ばす。
 */
export interface RuleContext {
  cards?: CardIndex | null;
}

// ── 警告コード ────────────────────────

export const WARNING_CODES = {
  // T14: 1ターン制限
  ENERGY_ALREADY_ATTACHED: 'ENERGY_ALREADY_ATTACHED',
  SUPPORTER_ALREADY_USED: 'SUPPORTER_ALREADY_USED',
  STADIUM_ALREADY_PLAYED: 'STADIUM_ALREADY_PLAYED',
  ALREADY_RETREATED: 'ALREADY_RETREATED',
  // T15: 最初の番の制限
  FIRST_TURN_SUPPORTER: 'FIRST_TURN_SUPPORTER',
  FIRST_TURN_ATTACK: 'FIRST_TURN_ATTACK',
  EVOLVE_ON_FIRST_TURN: 'EVOLVE_ON_FIRST_TURN',
  EVOLVE_JUST_PLACED: 'EVOLVE_JUST_PLACED',
  EVOLVE_ALREADY_EVOLVED: 'EVOLVE_ALREADY_EVOLVED',
  EVOLVE_JUST_DEVOLVED: 'EVOLVE_JUST_DEVOLVED',
  NOT_YOUR_TURN: 'NOT_YOUR_TURN',
  // T27: 常時効果によるロック
  CARD_KIND_LOCKED: 'CARD_KIND_LOCKED',
  // T42: ロック系カード
  ATTACK_LOCKED: 'ATTACK_LOCKED',
  /** ★ロックが2つ以上。相互作用は自動判定しない（§2.1） */
  MULTIPLE_LOCKS: 'MULTIPLE_LOCKS',
  // T34: 「自分の番に1回」をもう使っている / 特性が止まっている
  ABILITY_ALREADY_USED: 'ABILITY_ALREADY_USED',
  ABILITY_LOCKED: 'ABILITY_LOCKED',
  // T36: 「対戦中1回」をもう使っている / M進化で番が終わる
  ONCE_PER_GAME_USED: 'ONCE_PER_GAME_USED',
  MEGA_EVOLUTION_ENDS_TURN: 'MEGA_EVOLUTION_ENDS_TURN',
  // T43: 使うと番が終わる特性（ふとうのつるぎ）
  ABILITY_ENDS_TURN: 'ABILITY_ENDS_TURN',
  // T38: V-UNION の組み立て
  VUNION_INCOMPLETE: 'VUNION_INCOMPLETE',
  // T39: 古代能力（ワザの回数）
  ATTACK_ALREADY_USED: 'ATTACK_ALREADY_USED',
  EXTRA_ATTACK_AVAILABLE: 'EXTRA_ATTACK_AVAILABLE',
  // T41: 追加の番
  EXTRA_TURN_INSERTED: 'EXTRA_TURN_INSERTED',
  // T29: 使っても状況が変わらない
  EFFECT_NO_CHANGE: 'EFFECT_NO_CHANGE',
  // T16: きぜつ
  KNOCKOUT_NOT_REACHED: 'KNOCKOUT_NOT_REACHED',
  KNOCKOUT_PRIZE_UNUSUAL: 'KNOCKOUT_PRIZE_UNUSUAL',
  // T17: ポケモンチェック
  POKEMON_CHECK_OUT_OF_ORDER: 'POKEMON_CHECK_OUT_OF_ORDER',
  POKEMON_CHECK_INCOMPLETE: 'POKEMON_CHECK_INCOMPLETE',
} as const;

// ── 補助 ─────────────────────────────

const warn = (
  code: string,
  message: string,
  refs?: readonly string[],
): RuleWarning => ({
  code,
  severity: 'warn',
  message,
  ...(refs && refs.length > 0 ? { refs: [...refs] } : {}),
});

/** 「間違いではないが記録しておきたい」もの。トーストの色が変わる */
const info = (code: string, message: string, refs?: readonly string[]): RuleWarning => ({
  ...warn(code, message, refs),
  severity: 'info',
});

const nameOf = (state: GameState, playerId: PlayerId): string =>
  state.players[playerId]?.displayName ?? playerId;

const flagsOf = (state: GameState, playerId: PlayerId): TurnFlags | undefined =>
  state.players[playerId]?.turnFlags;

export function cardOf(
  state: GameState,
  ctx: RuleContext,
  instanceId: string | null | undefined,
): CardText | undefined {
  if (!instanceId) return undefined;
  const instance = state.cards[instanceId];
  if (!instance || instance.functionalId === '') return undefined;
  return ctx.cards?.byFunctionalId.get(instance.functionalId);
}

/**
 * この操作が「対戦中1回」の枠を使うものなら、その枠を返す（T36）。
 * ワザ（GXワザ / VSTARワザ）と特性（VSTARパワー）の両方を1か所で見る。
 */
function oncePerGameKindOf(
  state: GameState,
  ctx: RuleContext,
  action: Action,
): { playerId: PlayerId; kind: OncePerGameKind; refs: string[] } | null {
  if (action.type === 'useAttack') {
    const slot = state.players[action.playerId]?.pokemon.find((p) => p.slotId === action.slotId);
    const top = slot?.stack[slot.stack.length - 1];
    const kind = cardOf(state, ctx, top)?.attacks?.[action.attackIndex]?.oncePerGame;
    return kind ? { playerId: action.playerId, kind, refs: [action.slotId] } : null;
  }
  if (action.type === 'startEffect') {
    const { instanceId, abilityIndex, playerId } = action.source;
    if (!instanceId || abilityIndex === undefined) return null;
    const kind = abilityOf(state, instanceId, abilityIndex, ctx)?.oncePerGame;
    return kind ? { playerId, kind, refs: [instanceId] } : null;
  }
  return null;
}

/** そのカードが場のどのスロットにいるか。`p-1/active` の形。場になければ null */
function slotKeyOfCard(state: GameState, instanceId: string): string | null {
  for (const [playerId, player] of Object.entries(state.players)) {
    const slot = player.pokemon.find((p) => p.stack.includes(instanceId));
    if (slot) return effectSlotKey(playerId, slot.slotId);
  }
  return null;
}

/** 手札からトラッシュへ送られるサポートかどうか（＝サポートを使った） */
export function isSupporterPlay(
  state: GameState,
  ctx: RuleContext,
  action: Action,
): { playerId: PlayerId; cardId: string } | null {
  if (action.type !== 'moveCard') return null;
  const instance = state.cards[action.cardId];
  if (!instance || instance.zone !== 'hand') return null;
  if (action.toZone !== 'discard') return null;
  const card = cardOf(state, ctx, action.cardId);
  if (card?.trainerKind !== 'supporter') return null;
  return { playerId: instance.ownerId, cardId: action.cardId };
}

const TRAINER_KIND_LABEL: Record<TrainerKind, string> = {
  item: 'グッズ',
  tool: 'ポケモンのどうぐ',
  supporter: 'サポート',
  stadium: 'スタジアム',
};

/**
 * トレーナーズを使ったかどうか（T27 のロック判定用）。
 * サポート・グッズは「手札からトラッシュ」、どうぐは「手札からつける」、
 * スタジアムは setStadium で表れる。
 */
export function isTrainerPlay(
  state: GameState,
  ctx: RuleContext,
  action: Action,
): { playerId: PlayerId; cardId: string; kind: TrainerKind } | null {
  if (action.type === 'setStadium' && action.cardId !== null) {
    const owner = state.cards[action.cardId]?.ownerId;
    return owner ? { playerId: owner, cardId: action.cardId, kind: 'stadium' } : null;
  }

  if (action.type === 'attachCard' && action.as === 'tool') {
    const instance = state.cards[action.cardId];
    if (!instance || instance.zone !== 'hand') return null;
    if (cardOf(state, ctx, action.cardId)?.trainerKind !== 'tool') return null;
    return { playerId: action.playerId, cardId: action.cardId, kind: 'tool' };
  }

  if (action.type !== 'moveCard') return null;
  const instance = state.cards[action.cardId];
  if (!instance || instance.zone !== 'hand' || action.toZone !== 'discard') return null;
  const kind = cardOf(state, ctx, action.cardId)?.trainerKind;
  if (kind !== 'item' && kind !== 'supporter') return null;
  return { playerId: instance.ownerId, cardId: action.cardId, kind };
}

/** 手札からポケモンにつけるエネルギーかどうか（＝1ターン1枚のエネルギー） */
export function isEnergyAttachFromHand(
  state: GameState,
  action: Action,
): { playerId: PlayerId; cardId: string } | null {
  if (action.type !== 'attachCard' || action.as !== 'energy') return null;
  const instance = state.cards[action.cardId];
  if (!instance || instance.zone !== 'hand') return null;
  return { playerId: action.playerId, cardId: action.cardId };
}

// ── 番の数え方（T15） ────────────────────

/** そのプレイヤーがこれまでに取った番の数（進行中の番を含む） */
export function turnsTakenBy(state: GameState, playerId: PlayerId): number {
  return state.turnHistory.filter((t) => t.playerId === playerId).length;
}

/** いま進行中の番が、そのプレイヤーにとって最初の番か */
export function isPlayersFirstTurn(state: GameState, playerId: PlayerId): boolean {
  return turnsTakenBy(state, playerId) === 1;
}

/** いま進行中の番が、対戦全体の最初の番（＝先攻の最初の番）か */
export function isFirstTurnOfGame(state: GameState): boolean {
  return state.turnHistory.length === 1;
}

// ── 1ターン制限（T14） ───────────────────

/**
 * この操作によって使用済みにすべき1ターン制限。
 * ★あくまで「よくある場合」の推測。効果で例外的に使えたときは、
 *   HUD のインジケータをクリックして手で戻せる。
 */
export function turnFlagUpdates(
  state: GameState,
  action: Action,
  ctx: RuleContext,
): { playerId: PlayerId; flag: BooleanTurnFlag }[] {
  const energy = isEnergyAttachFromHand(state, action);
  if (energy) return [{ playerId: energy.playerId, flag: 'energyAttached' }];

  const supporter = isSupporterPlay(state, ctx, action);
  if (supporter) return [{ playerId: supporter.playerId, flag: 'supporterUsed' }];

  if (action.type === 'setStadium' && action.cardId !== null) {
    const owner = state.cards[action.cardId]?.ownerId;
    if (owner) return [{ playerId: owner, flag: 'stadiumPlayed' }];
  }

  if (action.type === 'movePokemon' && action.asRetreat) {
    return [{ playerId: action.playerId, flag: 'retreated' }];
  }

  return [];
}

// ── 検査の入口 ────────────────────────

/**
 * 操作の前に呼ぶ。警告を返すだけで、操作は必ず通す。
 * state は「操作を適用する前」の状態。
 */
/**
 * ★ロックが2つ以上になった瞬間を記録に残す（第4段階 §2.1 / T42）。
 *
 * 適用の前後を見比べて、「2つ以上になった」ときだけ1回出す。
 * 画面には消えないバナーを出す（§4.5）が、そちらは派生状態から直接引く。
 * ここはログに残すためのもの。
 */
export function multipleLockNotice(
  before: GameState,
  after: GameState,
  ctx: RuleContext = {},
): RuleWarning | null {
  const now = multipleLockWarning(after, ctx);
  if (!now.multiple) return null;
  if (multipleLockWarning(before, ctx).multiple) return null;
  return info(WARNING_CODES.MULTIPLE_LOCKS, `${now.message}：${now.details.join('、')}`);
}

export function checkAction(
  state: GameState,
  action: Action,
  ctx: RuleContext = {},
): RuleWarning[] {
  const warnings: RuleWarning[] = [];

  // ── 1ターン制限（T14） ──
  const energy = isEnergyAttachFromHand(state, action);
  if (energy && flagsOf(state, energy.playerId)?.energyAttached) {
    warnings.push(
      warn(
        WARNING_CODES.ENERGY_ALREADY_ATTACHED,
        `${nameOf(state, energy.playerId)}はこの番すでにエネルギーをつけています`,
        [energy.cardId],
      ),
    );
  }

  const supporter = isSupporterPlay(state, ctx, action);
  if (supporter && flagsOf(state, supporter.playerId)?.supporterUsed) {
    warnings.push(
      warn(
        WARNING_CODES.SUPPORTER_ALREADY_USED,
        `${nameOf(state, supporter.playerId)}はこの番すでにサポートを使っています`,
        [supporter.cardId],
      ),
    );
  }

  if (action.type === 'setStadium' && action.cardId !== null) {
    const owner = state.cards[action.cardId]?.ownerId;
    if (owner && flagsOf(state, owner)?.stadiumPlayed) {
      warnings.push(
        warn(
          WARNING_CODES.STADIUM_ALREADY_PLAYED,
          `${nameOf(state, owner)}はこの番すでにスタジアムを出しています`,
          [action.cardId],
        ),
      );
    }
  }

  if (action.type === 'movePokemon' && action.asRetreat) {
    if (flagsOf(state, action.playerId)?.retreated) {
      warnings.push(
        warn(
          WARNING_CODES.ALREADY_RETREATED,
          `${nameOf(state, action.playerId)}はこの番すでににげています`,
          [action.fromSlotId],
        ),
      );
    }
  }

  // ── 最初の番の制限（T15） ──
  if (supporter && isFirstTurnOfGame(state) && supporter.playerId === state.firstPlayer) {
    warnings.push(
      warn(
        WARNING_CODES.FIRST_TURN_SUPPORTER,
        '先攻の最初の番はサポートを使えません',
        [supporter.cardId],
      ),
    );
  }

  if (
    action.type === 'useAttack' &&
    isFirstTurnOfGame(state) &&
    action.playerId === state.firstPlayer
  ) {
    warnings.push(
      warn(WARNING_CODES.FIRST_TURN_ATTACK, '先攻の最初の番はワザを使えません', [action.slotId]),
    );
  }

  /*
   * ── M進化すると自分の番が終わる（T36） ──
   * ★勝手に番を終わらせない。知らせるだけにして、終わらせるのは人の操作。
   *   「進化させたつもりが番が飛んだ」は取り返しがつかないので、自動化しない。
   */
  if (action.type === 'evolvePokemon') {
    const evolvingInto = cardOf(state, ctx, action.cardId);
    if (evolvingInto && ruleFor(evolvingInto.ruleBox).endsTurnOnEvolve) {
      warnings.push(
        info(
          WARNING_CODES.MEGA_EVOLUTION_ENDS_TURN,
          `M進化したので、${nameOf(state, action.playerId)}の番はここで終わりです`,
          [action.cardId],
        ),
      );
    }
  }

  // ── 進化の制限（T15） ──
  if (action.type === 'evolvePokemon') {
    const slot = state.players[action.playerId]?.pokemon.find((p) => p.slotId === action.slotId);
    const where = slot ? [action.slotId] : undefined;

    if (isPlayersFirstTurn(state, action.playerId)) {
      warnings.push(
        warn(
          WARNING_CODES.EVOLVE_ON_FIRST_TURN,
          `${nameOf(state, action.playerId)}の最初の番は進化できません`,
          where,
        ),
      );
    }

    if (slot) {
      if (slot.placedOnTurn === state.turn) {
        warnings.push(
          warn(
            WARNING_CODES.EVOLVE_JUST_PLACED,
            'この番に出したばかりのポケモンは進化できません',
            where,
          ),
        );
      }
      if (slot.evolvedOnTurn === state.turn) {
        warnings.push(
          warn(
            WARNING_CODES.EVOLVE_ALREADY_EVOLVED,
            'このポケモンはこの番すでに進化しています',
            where,
          ),
        );
      }
      if (slot.devolvedOnTurn === state.turn) {
        warnings.push(
          warn(
            WARNING_CODES.EVOLVE_JUST_DEVOLVED,
            'この番に退化したばかりのポケモンは進化できません',
            where,
          ),
        );
      }
    }
  }

  /*
   * ── ★手札から出せないカード（T43） ──
   *   種別で指せないもの（シャドーミストの「特殊エネルギー」）もここで拾う。
   *   もちろん止めない。警告して通す（第2段階 §2）。
   */
  const energyPlay = isEnergyAttachFromHand(state, action);
  if (energyPlay) {
    const verdict = playLockFor(
      state,
      energyPlay.playerId,
      cardOf(state, ctx, energyPlay.cardId),
      ctx,
    );
    if (verdict.locked) {
      warnings.push(
        warn(WARNING_CODES.CARD_KIND_LOCKED, verdict.reason, [energyPlay.cardId]),
      );
    }
  }

  // ── ロックによるカード種別の制限（T27 → T42 で統一表現に） ──
  const trainer = isTrainerPlay(state, ctx, action);
  if (trainer) {
    const verdict = cardKindLockOn(
      state,
      trainer.playerId,
      trainer.kind,
      ctx,
      cardOf(state, ctx, trainer.cardId),
    );
    if (verdict.locked) {
      warnings.push(
        warn(
          WARNING_CODES.CARD_KIND_LOCKED,
          `いま${TRAINER_KIND_LABEL[trainer.kind]}は使えません（${verdict.sources.join(' / ')}）` +
            (verdict.assisted ? '［ロックが複数。要確認］' : ''),
          [trainer.cardId],
        ),
      );
    }
  }

  /*
   * ── ワザの回数（Ω連打。T39） ──
   * ★「1番に1回」を定数にしない。上限は派生状態から出す。
   *   使いすぎても止めない。警告して通す（第2段階 §2）。
   */
  if (action.type === 'useAttack') {
    // ★追加の番が入ることを、ログにも残す（T41）
    const slot = state.players[action.playerId]?.pokemon.find((p) => p.slotId === action.slotId);
    const attack = cardOf(state, ctx, slot?.stack[slot.stack.length - 1])?.attacks?.[
      action.attackIndex
    ];
    if (attack?.extraTurn) {
      warnings.push(
        info(
          WARNING_CODES.EXTRA_TURN_INSERTED,
          `「${attack.name}」で${nameOf(state, action.playerId)}の追加の番が入りました`,
          [action.slotId],
        ),
      );
    }

    /*
     * ★ワザ封じ（メガニウム。T42）。
     *   回数の問題ではないので、使用回数とは別に見る。
     *   「この効果は貫通する」ワザも、宣言そのものができないので通らない。
     */
    const attackLock = attackBlock(state, action.playerId, action.slotId, ctx);
    if (attackLock.blocked) {
      warnings.push(
        warn(
          WARNING_CODES.ATTACK_LOCKED,
          `いまワザを使えません（${attackLock.reason}）` +
            (attackLock.assisted ? '［ロックが複数。要確認］' : ''),
          [action.slotId],
        ),
      );
    }

    const used = flagsOf(state, action.playerId)?.attacksUsed ?? 0;
    const allowance = attackAllowanceFor(state, action.playerId, action.slotId, ctx);
    if (used >= allowance) {
      warnings.push(
        warn(
          WARNING_CODES.ATTACK_ALREADY_USED,
          allowance === 1
            ? `${nameOf(state, action.playerId)}はこの番すでにワザを使っています`
            : `この番に使えるワザは${allowance}回までです（すでに${used}回）`,
          [action.slotId],
        ),
      );
    } else if (allowance > 1 && used + 1 < allowance) {
      // ★ワザを使っても番が終わらない場合があることを知らせる
      warnings.push(
        info(
          WARNING_CODES.EXTRA_ATTACK_AVAILABLE,
          `あと${allowance - used - 1}回ワザを使えます（番はまだ終わりません）`,
          [action.slotId],
        ),
      );
    }
  }

  // ── 対戦中1回（T36） ──
  // ★プレイヤー単位。別のポケモンに交代しても戻らない
  const onceKind = oncePerGameKindOf(state, ctx, action);
  if (onceKind && hasUsedOncePerGame(state, onceKind.playerId, onceKind.kind)) {
    warnings.push(
      warn(
        WARNING_CODES.ONCE_PER_GAME_USED,
        `${nameOf(state, onceKind.playerId)}はこの対戦ですでに${ONCE_PER_GAME_LABEL[onceKind.kind]}を使っています`,
        onceKind.refs,
      ),
    );
  }

  /*
   * ── V-UNION の組み立て（T38） ──
   * ★4枚そろっていなくても止めない。警告して通す（第2段階 §2）。
   *   「対戦中1回」のほうは共通の枠なので、上の判定がすでに拾っている。
   */
  if (action.type === 'assembleVUnion') {
    if (hasUsedOncePerGame(state, action.playerId, 'vunion')) {
      warnings.push(
        warn(
          WARNING_CODES.ONCE_PER_GAME_USED,
          `${nameOf(state, action.playerId)}はこの対戦ですでに V-UNION を組み立てています`,
          [action.slotId],
        ),
      );
    }
    if (action.cardIds.length !== V_UNION_PARTS) {
      warnings.push(
        warn(
          WARNING_CODES.VUNION_INCOMPLETE,
          `V-UNION は4種類そろって1匹です（いま${action.cardIds.length}枚）`,
          [action.slotId],
        ),
      );
    }
  }

  // ── 特性（T34） ──
  if (action.type === 'startEffect') {
    const { instanceId, abilityIndex } = action.source;
    if (instanceId && abilityIndex !== undefined) {
      const ability = abilityOf(state, instanceId, abilityIndex, ctx);

      // ★「自分の番に1回」をもう使っている。警告は出すが、通す
      //   （ジバコイルのように、効果で追加で使えるカードがあるため）
      if (ability?.oncePerTurn && !canUseAbilityThisTurn(state, instanceId, abilityIndex)) {
        warnings.push(
          warn(
            WARNING_CODES.ABILITY_ALREADY_USED,
            `「${ability.name}」はこの番すでに使っています`,
            [instanceId],
          ),
        );
      }

      /*
       * ★使うと番が終わる特性（ふとうのつるぎ。T43）。
       *   M進化と同じく **勝手には終わらせない**。知らせるだけにして、
       *   「番を終える」を押すのは人に任せる（第2段階 §2）。
       */
      if (ability?.endsTurn) {
        warnings.push(
          info(
            WARNING_CODES.ABILITY_ENDS_TURN,
            `「${ability.name}」を使うと、この番は終わります（番を終えてください）`,
            [instanceId],
          ),
        );
      }

      // 場のロック効果で止まっている特性を使おうとした（T34 → T42 で理由も出す）
      const slotKey = slotKeyOfCard(state, instanceId);
      const entry = slotKey
        ? getEffectiveAbilityEntries(state, slotKey, ctx).find(
            (e) => e.instanceId === instanceId && e.abilityIndex === abilityIndex,
          )
        : undefined;
      if (ability && entry?.lock.locked) {
        warnings.push(
          warn(
            WARNING_CODES.ABILITY_LOCKED,
            `「${ability.name}」はいま止まっています（${entry.lock.reason}）` +
              (entry.lock.assisted ? '［ロックが複数。要確認］' : ''),
            [instanceId],
          ),
        );
      }
    }
  }

  // ── 状況が変化しない効果（T29） ──
  if (action.type === 'startEffect') {
    const kind = useKindOf(state, ctx, action.source);
    if (kind) {
      const verdict = checkUsability(state, kind, action.ops, action.source, ctx);
      // ★第2段階の原則どおり、警告だけで効果開始は止めない。
      // ワザは状況が変わらなくても宣言できるため、usable は常に true。
      if (!verdict.usable && verdict.reason) {
        warnings.push(
          warn(
            WARNING_CODES.EFFECT_NO_CHANGE,
            verdict.reason,
            action.source.instanceId ? [action.source.instanceId] : undefined,
          ),
        );
      }
    }
  }

  // ── きぜつ（T16） ──
  if (action.type === 'knockOut') {
    const slot = state.players[action.playerId]?.pokemon.find((p) => p.slotId === action.slotId);
    if (slot) {
      const remaining = remainingHpOf(state, ctx, slot);
      if (remaining !== null && remaining > 0) {
        warnings.push(
          info(
            WARNING_CODES.KNOCKOUT_NOT_REACHED,
            `残りHPが${remaining}あります（効果によるきぜつとして処理します）`,
            [action.slotId],
          ),
        );
      }
      const expected = prizesForRuleBox(topCardOf(state, ctx, slot)?.ruleBox);
      if (action.prizePlayerId !== null && action.prizeCount !== expected) {
        warnings.push(
          info(
            WARNING_CODES.KNOCKOUT_PRIZE_UNUSUAL,
            `サイドを${action.prizeCount}枚とりました（ルール上の既定は${expected}枚）`,
            [action.slotId],
          ),
        );
      }
    }
  }

  // ── ポケモンチェック（T17） ──
  if (action.type === 'resolvePokemonCheckTarget') {
    const next = nextPokemonCheckTarget(state);
    if (
      next &&
      (next.step.order !== action.order ||
        next.target.playerId !== action.playerId ||
        next.target.slotId !== action.slotId ||
        next.target.topInstanceId !== action.expectedTopInstanceId)
    ) {
      warnings.push(
        warn(
          WARNING_CODES.POKEMON_CHECK_OUT_OF_ORDER,
          'ポケモンチェックの処理順が前後しています（操作はそのまま記録します）',
          [action.slotId],
        ),
      );
    }
  }

  if (action.type === 'endTurn' && state.phase === 'pokemonCheck') {
    const remaining = (state.pokemonCheck?.steps ?? []).flatMap((step) =>
      step.targets.filter((target) => !target.resolved),
    );
    if (remaining.length > 0) {
      warnings.push(
        warn(
          WARNING_CODES.POKEMON_CHECK_INCOMPLETE,
          `ポケモンチェックに未処理の対象が${remaining.length}件あります（番はそのまま進めます）`,
          remaining.map((target) => target.slotId),
        ),
      );
    }
  }

  return warnings;
}
