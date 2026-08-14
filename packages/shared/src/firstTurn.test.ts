/**
 * T15 の完了条件:
 * 「先攻の最初の番のサポート・ワザ、双方の最初の番の進化で適切な警告が出る。
 *   カードの効果で例外的に進化したい場合も操作は通る」
 */
import { describe, expect, it } from 'vitest';
import { applyAction, applyActionChecked, applyActions, type Action } from './actions';
import { buildCardIndex } from './cards';
import { createGameState, findSlot, withCards } from './gameState';
import {
  isFirstTurnOfGame,
  isPlayersFirstTurn,
  turnsTakenBy,
  WARNING_CODES,
  type RuleContext,
} from './rules';
import { ALICE, BOB, tick } from './testFixtures';
import type { CardInstance, CardText, GameState, PlayerId } from './types';

const act = <T extends Omit<Action, 'actorId' | 'at'>>(a: T, actorId: PlayerId = ALICE): Action =>
  ({ ...a, actorId, at: tick() }) as Action;

const BASIC: CardText = {
  functionalId: 'fn-basic',
  name: 'ゼニガメ',
  supertype: 'pokemon',
  hp: 70,
  types: ['water'],
  stage: 'basic',
  ruleBox: null,
  attacks: [{ name: 'みずでっぽう', cost: ['water'], damage: '20', text: '' }],
  weakness: null,
  resistance: null,
  retreatCost: 1,
};
const STAGE1: CardText = {
  ...BASIC,
  functionalId: 'fn-stage1',
  name: 'カメール',
  stage: 'stage1',
  evolvesFrom: 'ゼニガメ',
  hp: 100,
};
const SUPPORTER: CardText = {
  functionalId: 'fn-supporter',
  name: '研究員の指示',
  supertype: 'trainer',
  trainerKind: 'supporter',
  text: '7枚引く。',
};

const ctx: RuleContext = { cards: buildCardIndex([BASIC, STAGE1, SUPPORTER]) };

const card = (
  instanceId: string,
  functionalId: string,
  ownerId: PlayerId,
  position: number,
): CardInstance => ({
  instanceId,
  functionalId,
  ownerId,
  zone: 'hand',
  visibleTo: [ownerId],
  faceUp: false,
  position,
});

/**
 * 対戦準備を済ませ、両者がバトル場にたねポケモンを置いた状態で第1番を始める。
 * 先攻はアリス。
 */
function startedGame(): GameState {
  const base = createGameState({
    gameId: 'g-first',
    rngSeed: 'seed',
    seats: [
      { playerId: ALICE, displayName: 'アリス' },
      { playerId: BOB, displayName: 'ボブ' },
    ],
  });
  const seeded = withCards(base, [
    card('a-basic', 'fn-basic', ALICE, 0),
    card('a-stage1', 'fn-stage1', ALICE, 1),
    card('a-stage1b', 'fn-stage1', ALICE, 2),
    card('a-sup', 'fn-supporter', ALICE, 3),
    card('b-basic', 'fn-basic', BOB, 0),
    card('b-stage1', 'fn-stage1', BOB, 1),
    card('b-sup', 'fn-supporter', BOB, 2),
  ]);

  return applyActions(
    seeded,
    [
      // 準備中に場に出す（placedOnTurn は 0 になる）
      act({ type: 'placePokemon', playerId: ALICE, slotId: 'active', cardId: 'a-basic' }),
      act({ type: 'placePokemon', playerId: BOB, slotId: 'active', cardId: 'b-basic' }, BOB),
      act({ type: 'setFirstPlayer', playerId: ALICE }),
      act({ type: 'setSetupStep', step: 'done' }),
    ],
    ctx,
  );
}

describe('番の数え方', () => {
  it('第1番は先攻の最初の番', () => {
    const s = startedGame();
    expect(s.turn).toBe(1);
    expect(s.firstPlayer).toBe(ALICE);
    expect(isFirstTurnOfGame(s)).toBe(true);
    expect(isPlayersFirstTurn(s, ALICE)).toBe(true);
    // ボブはまだ番を取っていない
    expect(turnsTakenBy(s, BOB)).toBe(0);
    expect(isPlayersFirstTurn(s, BOB)).toBe(false);
  });

  it('第2番は後攻の最初の番。全体の最初の番ではない', () => {
    const s = applyAction(startedGame(), act({ type: 'endTurn' }), ctx);
    expect(s.activePlayer).toBe(BOB);
    expect(isFirstTurnOfGame(s)).toBe(false);
    expect(isPlayersFirstTurn(s, BOB)).toBe(true);
  });

  it('第3番は誰にとっても最初の番ではない', () => {
    const s = applyActions(startedGame(), [act({ type: 'endTurn' }), act({ type: 'endTurn' })], ctx);
    expect(s.activePlayer).toBe(ALICE);
    expect(isPlayersFirstTurn(s, ALICE)).toBe(false);
  });
});

describe('★先攻の最初の番の制限', () => {
  it('サポートを使うと警告が出るが、操作は成立する', () => {
    const { state, warnings } = applyActionChecked(
      startedGame(),
      act({ type: 'moveCard', cardId: 'a-sup', toZone: 'discard' }),
      ctx,
    );
    expect(warnings.map((w) => w.code)).toContain(WARNING_CODES.FIRST_TURN_SUPPORTER);
    expect(warnings.find((w) => w.code === WARNING_CODES.FIRST_TURN_SUPPORTER)?.message).toBe(
      '先攻の最初の番はサポートを使えません',
    );
    // 通る
    expect(state.cards['a-sup']?.zone).toBe('discard');
  });

  it('ワザを使うと警告が出る', () => {
    const { warnings } = applyActionChecked(
      startedGame(),
      act({ type: 'useAttack', playerId: ALICE, slotId: 'active', attackIndex: 0, attackName: 'みずでっぽう' }),
      ctx,
    );
    expect(warnings.map((w) => w.code)).toEqual([WARNING_CODES.FIRST_TURN_ATTACK]);
  });

  it('後攻の最初の番では、サポートもワザも警告が出ない', () => {
    const bobsTurn = applyAction(startedGame(), act({ type: 'endTurn' }), ctx);

    const supporter = applyActionChecked(
      bobsTurn,
      act({ type: 'moveCard', cardId: 'b-sup', toZone: 'discard' }, BOB),
      ctx,
    );
    expect(supporter.warnings).toEqual([]);

    const attack = applyActionChecked(
      bobsTurn,
      act({ type: 'useAttack', playerId: BOB, slotId: 'active', attackIndex: 0 }, BOB),
      ctx,
    );
    expect(attack.warnings).toEqual([]);
  });

  it('先攻でも2回目の番なら警告が出ない', () => {
    const third = applyActions(
      startedGame(),
      [act({ type: 'endTurn' }), act({ type: 'endTurn' })],
      ctx,
    );
    const { warnings } = applyActionChecked(
      third,
      act({ type: 'useAttack', playerId: ALICE, slotId: 'active', attackIndex: 0 }),
      ctx,
    );
    expect(warnings).toEqual([]);
  });
});

describe('★最初の番は進化できない', () => {
  it('先攻の最初の番の進化で警告が出るが、進化は成立する', () => {
    const { state, warnings } = applyActionChecked(
      startedGame(),
      act({ type: 'evolvePokemon', playerId: ALICE, slotId: 'active', cardId: 'a-stage1' }),
      ctx,
    );
    expect(warnings.map((w) => w.code)).toContain(WARNING_CODES.EVOLVE_ON_FIRST_TURN);

    // ★ふしぎなアメ・ぬけがけしんか等のため、操作は必ず通る（§2）
    expect(findSlot(state, ALICE, 'active')?.stack).toEqual(['a-basic', 'a-stage1']);
  });

  it('後攻の最初の番でも警告が出る', () => {
    const bobsTurn = applyAction(startedGame(), act({ type: 'endTurn' }), ctx);
    const { warnings } = applyActionChecked(
      bobsTurn,
      act({ type: 'evolvePokemon', playerId: BOB, slotId: 'active', cardId: 'b-stage1' }, BOB),
      ctx,
    );
    expect(warnings.map((w) => w.code)).toContain(WARNING_CODES.EVOLVE_ON_FIRST_TURN);
  });

  it('2回目の番なら警告なしで進化できる', () => {
    const third = applyActions(
      startedGame(),
      [act({ type: 'endTurn' }), act({ type: 'endTurn' })],
      ctx,
    );
    const { warnings } = applyActionChecked(
      third,
      act({ type: 'evolvePokemon', playerId: ALICE, slotId: 'active', cardId: 'a-stage1' }),
      ctx,
    );
    expect(warnings).toEqual([]);
  });
});

describe('出したばかり・進化したばかり・退化したばかり', () => {
  /** アリスの3番目の番（最初の番の制限が外れた状態） */
  const laterTurn = () =>
    applyActions(startedGame(), [act({ type: 'endTurn' }), act({ type: 'endTurn' })], ctx);

  it('この番に出したばかりのポケモンは進化できない', () => {
    const placed = applyAction(
      laterTurn(),
      act({ type: 'placePokemon', playerId: ALICE, slotId: 'bench-0', cardId: 'a-basic' }),
      ctx,
    );
    expect(findSlot(placed, ALICE, 'bench-0')?.placedOnTurn).toBe(placed.turn);

    const { state, warnings } = applyActionChecked(
      placed,
      act({ type: 'evolvePokemon', playerId: ALICE, slotId: 'bench-0', cardId: 'a-stage1' }),
      ctx,
    );
    expect(warnings.map((w) => w.code)).toContain(WARNING_CODES.EVOLVE_JUST_PLACED);
    expect(findSlot(state, ALICE, 'bench-0')?.stack).toHaveLength(2);
  });

  it('同じ番に2回進化させると警告が出る', () => {
    const evolved = applyAction(
      laterTurn(),
      act({ type: 'evolvePokemon', playerId: ALICE, slotId: 'active', cardId: 'a-stage1' }),
      ctx,
    );
    const { warnings } = applyActionChecked(
      evolved,
      act({ type: 'evolvePokemon', playerId: ALICE, slotId: 'active', cardId: 'a-stage1b' }),
      ctx,
    );
    expect(warnings.map((w) => w.code)).toContain(WARNING_CODES.EVOLVE_ALREADY_EVOLVED);
  });

  it('この番に退化したばかりのポケモンは進化できない', () => {
    const evolvedLastTurn = applyActions(
      laterTurn(),
      [
        act({ type: 'evolvePokemon', playerId: ALICE, slotId: 'active', cardId: 'a-stage1' }),
        act({ type: 'endTurn' }),
        act({ type: 'endTurn' }),
      ],
      ctx,
    );
    const devolved = applyAction(
      evolvedLastTurn,
      act({ type: 'devolvePokemon', playerId: ALICE, slotId: 'active', toZone: 'hand' }),
      ctx,
    );
    expect(findSlot(devolved, ALICE, 'active')?.devolvedOnTurn).toBe(devolved.turn);

    const { warnings } = applyActionChecked(
      devolved,
      act({ type: 'evolvePokemon', playerId: ALICE, slotId: 'active', cardId: 'a-stage1b' }),
      ctx,
    );
    expect(warnings.map((w) => w.code)).toContain(WARNING_CODES.EVOLVE_JUST_DEVOLVED);
  });

  it('前の番に出したポケモンは警告なしで進化できる', () => {
    const placedEarlier = applyActions(
      laterTurn(),
      [
        act({ type: 'placePokemon', playerId: ALICE, slotId: 'bench-0', cardId: 'a-basic' }),
        act({ type: 'endTurn' }),
        act({ type: 'endTurn' }),
      ],
      ctx,
    );
    const { warnings } = applyActionChecked(
      placedEarlier,
      act({ type: 'evolvePokemon', playerId: ALICE, slotId: 'bench-0', cardId: 'a-stage1' }),
      ctx,
    );
    expect(warnings).toEqual([]);
  });
});

describe('警告は重なって出る', () => {
  it('最初の番に、出したばかりのポケモンを進化させると2件出る', () => {
    const placed = applyAction(
      startedGame(),
      act({ type: 'placePokemon', playerId: ALICE, slotId: 'bench-0', cardId: 'a-basic' }),
      ctx,
    );
    const { warnings } = applyActionChecked(
      placed,
      act({ type: 'evolvePokemon', playerId: ALICE, slotId: 'bench-0', cardId: 'a-stage1' }),
      ctx,
    );
    expect(warnings.map((w) => w.code).sort()).toEqual(
      [WARNING_CODES.EVOLVE_ON_FIRST_TURN, WARNING_CODES.EVOLVE_JUST_PLACED].sort(),
    );
  });
});
