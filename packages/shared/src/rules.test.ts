/**
 * T14 の完了条件:
 * 「2回目のサポート使用で警告が出るが、操作は成立する」
 *
 * ★このファイル全体を通して確かめているのは、
 *   「警告は出るが、操作は必ず通る」という第2段階 §2 の原則。
 */
import { describe, expect, it } from 'vitest';
import { applyAction, applyActionChecked, applyActions, type Action } from './actions';
import { buildCardIndex } from './cards';
import { cardsInZone, findSlot, withCards } from './gameState';
import { WARNING_CODES, type RuleContext } from './rules';
import { ALICE, BOB, makeTable, tick } from './testFixtures';
import type { CardText, GameState } from './types';

const act = <T extends Omit<Action, 'actorId' | 'at'>>(a: T, actorId = ALICE): Action =>
  ({ ...a, actorId, at: tick() }) as Action;

const SUPPORTER: CardText = {
  functionalId: 'fn-supporter',
  name: '研究員の指示',
  supertype: 'trainer',
  trainerKind: 'supporter',
  text: '手札をすべてトラッシュし、7枚引く。',
};
const ITEM: CardText = {
  functionalId: 'fn-item',
  name: 'サーチボール',
  supertype: 'trainer',
  trainerKind: 'item',
  text: 'たねポケモンを1枚手札に加える。',
};
const ENERGY: CardText = {
  functionalId: 'fn-energy',
  name: '基本水エネルギー',
  supertype: 'energy',
  isBasicEnergy: true,
  energyProvides: ['water'],
};
const STADIUM: CardText = {
  functionalId: 'fn-stadium',
  name: '拡張フィールド',
  supertype: 'trainer',
  trainerKind: 'stadium',
  text: 'ベンチは8体になる。',
};
const BASIC: CardText = {
  functionalId: 'fn-basic',
  name: 'ピカチュウ',
  supertype: 'pokemon',
  hp: 60,
  types: ['lightning'],
  stage: 'basic',
  ruleBox: null,
  attacks: [],
  weakness: null,
  resistance: null,
  retreatCost: 1,
};

const ctx: RuleContext = { cards: buildCardIndex([SUPPORTER, ITEM, ENERGY, STADIUM, BASIC]) };

/** アリスの手札にサポート・グッズ・エネルギー・スタジアム、場にポケモン2匹 */
function table(): GameState {
  const base = makeTable({ deckSize: 2 });
  const withHand = withCards(base, [
    { instanceId: 'sup1', functionalId: 'fn-supporter', ownerId: ALICE, zone: 'hand', visibleTo: [ALICE], faceUp: false, position: 0 },
    { instanceId: 'sup2', functionalId: 'fn-supporter', ownerId: ALICE, zone: 'hand', visibleTo: [ALICE], faceUp: false, position: 1 },
    { instanceId: 'item1', functionalId: 'fn-item', ownerId: ALICE, zone: 'hand', visibleTo: [ALICE], faceUp: false, position: 2 },
    { instanceId: 'en1', functionalId: 'fn-energy', ownerId: ALICE, zone: 'hand', visibleTo: [ALICE], faceUp: false, position: 3 },
    { instanceId: 'en2', functionalId: 'fn-energy', ownerId: ALICE, zone: 'hand', visibleTo: [ALICE], faceUp: false, position: 4 },
    { instanceId: 'std1', functionalId: 'fn-stadium', ownerId: ALICE, zone: 'hand', visibleTo: [ALICE], faceUp: false, position: 5 },
    { instanceId: 'std2', functionalId: 'fn-stadium', ownerId: ALICE, zone: 'hand', visibleTo: [ALICE], faceUp: false, position: 6 },
    { instanceId: 'poke1', functionalId: 'fn-basic', ownerId: ALICE, zone: 'hand', visibleTo: [ALICE], faceUp: false, position: 7 },
    { instanceId: 'poke2', functionalId: 'fn-basic', ownerId: ALICE, zone: 'hand', visibleTo: [ALICE], faceUp: false, position: 8 },
  ]);
  return applyActions(
    withHand,
    [
      act({ type: 'placePokemon', playerId: ALICE, slotId: 'active', cardId: 'poke1' }),
      act({ type: 'placePokemon', playerId: ALICE, slotId: 'bench-0', cardId: 'poke2' }),
    ],
    ctx,
  );
}

const playSupporter = (cardId: string) =>
  act({ type: 'moveCard', cardId, toZone: 'discard' });

describe('サポートの1ターン1枚（★T14 の完了条件）', () => {
  it('1枚目は警告なしで、使用済みになる', () => {
    const { state, warnings } = applyActionChecked(table(), playSupporter('sup1'), ctx);
    expect(warnings).toEqual([]);
    expect(state.players[ALICE]?.turnFlags.supporterUsed).toBe(true);
    expect(state.cards['sup1']?.zone).toBe('discard');
  });

  it('★2枚目は警告が出るが、操作は成立する', () => {
    const first = applyAction(table(), playSupporter('sup1'), ctx);
    const { state, warnings } = applyActionChecked(first, playSupporter('sup2'), ctx);

    // 警告は出る
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe(WARNING_CODES.SUPPORTER_ALREADY_USED);
    expect(warnings[0]?.message).toContain('すでにサポートを使っています');
    expect(warnings[0]?.refs).toEqual(['sup2']);

    // それでも操作は通っている（ジバコイル等のため。§2）
    expect(state.cards['sup2']?.zone).toBe('discard');
  });

  it('警告はログに残り、相手にも見える', () => {
    const first = applyAction(table(), playSupporter('sup1'), ctx);
    const second = applyAction(first, playSupporter('sup2'), ctx);

    const entry = second.log[second.log.length - 1];
    expect(entry?.warnings[0]?.code).toBe(WARNING_CODES.SUPPORTER_ALREADY_USED);
    expect(entry?.visibleTo).toContain(BOB);
  });

  it('グッズは何枚使っても警告が出ない', () => {
    const s = applyAction(table(), playSupporter('item1'), ctx);
    expect(s.log[s.log.length - 1]?.warnings).toEqual([]);
    expect(s.players[ALICE]?.turnFlags.supporterUsed).toBe(false);
  });

  it('手動でフラグを戻せば、また警告なしで使える', () => {
    const used = applyAction(table(), playSupporter('sup1'), ctx);
    const reset = applyAction(
      used,
      act({ type: 'setTurnFlag', playerId: ALICE, flag: 'supporterUsed', value: false }),
      ctx,
    );
    const { warnings } = applyActionChecked(reset, playSupporter('sup2'), ctx);
    expect(warnings).toEqual([]);
  });
});

describe('エネルギーの1ターン1枚', () => {
  const attach = (cardId: string) =>
    act({ type: 'attachCard', playerId: ALICE, slotId: 'active', cardId, as: 'energy' });

  it('1枚目で使用済みになる', () => {
    const s = applyAction(table(), attach('en1'), ctx);
    expect(s.players[ALICE]?.turnFlags.energyAttached).toBe(true);
    expect(findSlot(s, ALICE, 'active')?.attachedEnergy).toEqual(['en1']);
  });

  it('2枚目は警告が出るが、ついている', () => {
    const first = applyAction(table(), attach('en1'), ctx);
    const { state, warnings } = applyActionChecked(first, attach('en2'), ctx);
    expect(warnings[0]?.code).toBe(WARNING_CODES.ENERGY_ALREADY_ATTACHED);
    expect(findSlot(state, ALICE, 'active')?.attachedEnergy).toEqual(['en1', 'en2']);
  });

  it('トラッシュからつけ直す場合は「手札から」ではないので数えない', () => {
    const discarded = applyAction(table(), act({ type: 'moveCard', cardId: 'en1', toZone: 'discard' }), ctx);
    const s = applyAction(discarded, attach('en1'), ctx);
    expect(s.players[ALICE]?.turnFlags.energyAttached).toBe(false);
    expect(s.log[s.log.length - 1]?.warnings).toEqual([]);
  });
});

describe('スタジアムの1ターン1枚', () => {
  it('2枚目で警告が出るが、場には出る', () => {
    const first = applyActions(
      table(),
      [
        act({ type: 'moveCard', cardId: 'std1', toZone: 'stadium' }),
        act({ type: 'setStadium', cardId: 'std1' }),
      ],
      ctx,
    );
    expect(first.players[ALICE]?.turnFlags.stadiumPlayed).toBe(true);

    const { state, warnings } = applyActionChecked(
      first,
      act({ type: 'setStadium', cardId: 'std2' }),
      ctx,
    );
    expect(warnings[0]?.code).toBe(WARNING_CODES.STADIUM_ALREADY_PLAYED);
    expect(state.stadium).toBe('std2');
  });
});

describe('にげるの1ターン1回', () => {
  const retreat = () =>
    act({
      type: 'movePokemon',
      playerId: ALICE,
      fromSlotId: 'active',
      toSlotId: 'bench-0',
      asRetreat: true,
    });

  it('にげると使用済みになる', () => {
    const s = applyAction(table(), retreat(), ctx);
    expect(s.players[ALICE]?.turnFlags.retreated).toBe(true);
  });

  it('2回目は警告が出るが、入れ替わる', () => {
    const first = applyAction(table(), retreat(), ctx);
    const { state, warnings } = applyActionChecked(first, retreat(), ctx);
    expect(warnings[0]?.code).toBe(WARNING_CODES.ALREADY_RETREATED);
    expect(findSlot(state, ALICE, 'active')?.stack).toEqual(['poke1']);
  });

  it('★「入れ替え」はにげるとして数えない（ポケモンいれかえ等）', () => {
    const s = applyAction(
      table(),
      act({ type: 'movePokemon', playerId: ALICE, fromSlotId: 'active', toSlotId: 'bench-0' }),
      ctx,
    );
    expect(s.players[ALICE]?.turnFlags.retreated).toBe(false);
    expect(s.log[s.log.length - 1]?.warnings).toEqual([]);
  });
});

describe('番が変われば制限は戻る', () => {
  it('endTurn で次のプレイヤーの制限がリセットされる', () => {
    const used = applyAction(table(), playSupporter('sup1'), ctx);
    expect(used.players[ALICE]?.turnFlags.supporterUsed).toBe(true);

    // アリス → ボブ → アリス と2回進める
    const back = applyActions(used, [act({ type: 'endTurn' }), act({ type: 'endTurn' })], ctx);
    expect(back.activePlayer).toBe(ALICE);
    expect(back.players[ALICE]?.turnFlags.supporterUsed).toBe(false);
  });
});

describe('カード定義がないときは静かに諦める', () => {
  it('ctx を渡さなければサポート判定はしない（誤検知しない）', () => {
    const first = applyAction(table(), playSupporter('sup1'));
    expect(first.players[ALICE]?.turnFlags.supporterUsed).toBe(false);
    const second = applyActionChecked(first, playSupporter('sup2'));
    expect(second.warnings).toEqual([]);
    expect(second.state.cards['sup2']?.zone).toBe('discard');
  });
});

describe('applyActionChecked は必ず配列を返す', () => {
  it('警告がなくても空配列', () => {
    const { warnings } = applyActionChecked(
      table(),
      act({ type: 'note', text: 'テスト' }),
      ctx,
    );
    expect(warnings).toEqual([]);
    expect(Array.isArray(warnings)).toBe(true);
  });

  it('どの操作でも throw しない（禁止しない）', () => {
    let s = table();
    for (let i = 0; i < 3; i += 1) {
      s = applyAction(s, playSupporter(i === 0 ? 'sup1' : 'sup2'), ctx);
      if (i === 0) continue;
      // 2回目以降は同じカードを動かすので何も起きないが、例外は出ない
      expect(cardsInZone(s, ALICE, 'discard').length).toBeGreaterThan(0);
    }
  });
});
