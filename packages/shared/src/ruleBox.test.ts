/**
 * T36 の完了条件:
 *   1. 各クラスのきぜつでサイドが正しい枚数とられる
 *   2. ★GXワザとVSTARパワーが **対戦中1回・プレイヤー単位** に制限される
 *
 * あわせて第4段階 §3 の表にある固有ルールを確かめる:
 *   M進化すると自分の番が終わる / プリズムスターはロストゾーンへ
 */
import { describe, expect, it } from 'vitest';
import { applyAction, applyActions, type Action } from './actions';
import { buildCardIndex } from './cards';
import { createGameState, withCards } from './gameState';
import { prizesForRuleBox } from './knockout';
import {
  discardZoneFor,
  hasUsedOncePerGame,
  RULE_BOX_RULES,
  ruleFor,
} from './ruleBox';
import { WARNING_CODES, type RuleContext } from './rules';
import { ALICE, BOB, tick } from './testFixtures';
import type { CardInstance, CardText, GameState, PlayerId, RuleBox } from './types';

const act = <T extends Omit<Action, 'actorId' | 'at'>>(a: T, actorId: PlayerId = ALICE): Action =>
  ({ ...a, actorId, at: tick() }) as Action;

// ── カード定義 ────────────────────────

const mon = (
  over: Partial<CardText> & Pick<CardText, 'functionalId' | 'name'>,
): CardText => ({
  supertype: 'pokemon',
  hp: 200,
  types: ['water'],
  stage: 'basic',
  ruleBox: null,
  attacks: [],
  weakness: null,
  resistance: null,
  retreatCost: 1,
  ...over,
});

/** GXワザを持つポケモン */
const GX_MON = mon({
  functionalId: 'fn-gx',
  name: 'テストGX',
  ruleBox: 'GX',
  attacks: [
    { name: 'つうじょうわざ', cost: ['water'], damage: '30', text: '' },
    { name: 'テストGX', cost: ['water'], damage: '200', text: '', oncePerGame: 'gx' },
  ],
});

/** 別のGXポケモン。★同じ枠を食い合う */
const OTHER_GX = mon({
  ...GX_MON,
  functionalId: 'fn-gx2',
  name: 'べつのGX',
  attacks: [{ name: 'べつのGX', cost: ['water'], damage: '150', text: '', oncePerGame: 'gx' }],
});

/** VSTARパワーを **特性** で持つポケモン（スターポータル型） */
const VSTAR_MON = mon({
  functionalId: 'fn-vstar',
  name: 'テストVSTAR',
  ruleBox: 'VSTAR',
  abilities: [
    {
      name: 'スターポータル',
      kind: 'ability',
      text: 'VSTARパワー。対戦中1回。',
      oncePerGame: 'vstar',
      effects: [{ op: 'draw', player: 'self', count: 1 }],
    },
  ],
  attacks: [{ name: 'つうじょうわざ', cost: ['water'], damage: '30', text: '' }],
});

const MEGA_MON = mon({
  functionalId: 'fn-mega',
  name: 'MテストEX',
  ruleBox: 'MEGA',
  stage: 'mega',
  evolvesFrom: 'テストEX',
});

const EX_MON = mon({ functionalId: 'fn-ex', name: 'テストEX', ruleBox: 'EX' });

const PRISM_MON = mon({ functionalId: 'fn-prism', name: 'テスト◇', ruleBox: 'PRISM', hp: 100 });

const PLAIN = mon({ functionalId: 'fn-plain', name: 'ゼニガメ', hp: 70 });

const ctx: RuleContext = {
  cards: buildCardIndex([GX_MON, OTHER_GX, VSTAR_MON, MEGA_MON, EX_MON, PRISM_MON, PLAIN]),
};

const card = (instanceId: string, fid: string, ownerId: PlayerId = ALICE): CardInstance => ({
  instanceId,
  functionalId: fid,
  ownerId,
  zone: 'deck',
  visibleTo: [],
  faceUp: false,
});

function table(): GameState {
  const base = createGameState({
    gameId: 'g-rulebox',
    rngSeed: 'seed',
    seats: [
      { playerId: ALICE, displayName: 'アリス' },
      { playerId: BOB, displayName: 'ボブ' },
    ],
  });
  const cards = [
    card('a-gx', 'fn-gx'),
    card('a-gx2', 'fn-gx2'),
    card('a-vstar', 'fn-vstar'),
    card('a-ex', 'fn-ex'),
    card('a-mega', 'fn-mega'),
    card('a-prism', 'fn-prism'),
    card('b-plain', 'fn-plain', BOB),
  ];
  return applyActions(
    withCards({ ...base, phase: 'turn', turn: 3, setup: null }, cards),
    [
      act({ type: 'placePokemon', playerId: ALICE, slotId: 'active', cardId: 'a-gx' }),
      act({ type: 'placePokemon', playerId: ALICE, slotId: 'bench-0', cardId: 'a-gx2' }),
      act({ type: 'placePokemon', playerId: ALICE, slotId: 'bench-1', cardId: 'a-vstar' }),
      act({ type: 'placePokemon', playerId: BOB, slotId: 'active', cardId: 'b-plain' }, BOB),
    ],
    ctx,
  );
}

const startEffectOn = (state: GameState, instanceId: string, abilityIndex = 0): GameState =>
  applyAction(
    state,
    act({
      type: 'startEffect',
      executionId: `x-${tick()}`,
      ops: [{ op: 'draw', player: 'self', count: 1 }],
      source: { instanceId, playerId: ALICE, label: 'スターポータル', abilityIndex },
    }),
    ctx,
  );

const lastWarnings = (state: GameState): string[] =>
  (state.log[state.log.length - 1]?.warnings ?? []).map((w) => w.code);

// ── 1. サイド枚数 ──────────────────────

describe('★クラスごとのサイド枚数（第4段階 §3 の表）', () => {
  const cases: readonly [NonNullable<RuleBox>, number][] = [
    ['EX', 2],
    ['MEGA', 2],
    ['BREAK', 1],
    ['GX', 2],
    ['PRISM', 1],
    ['TAGTEAM', 3],
    ['V', 2],
    ['VMAX', 3],
    ['VUNION', 3],
    ['VSTAR', 2],
    ['RADIANT', 1],
    ['ex', 2],
  ];

  it.each(cases)('%s は %i枚', (ruleBox, prizes) => {
    expect(prizesForRuleBox(ruleBox)).toBe(prizes);
  });

  it('ルールを持たないポケモンは1枚', () => {
    expect(prizesForRuleBox(undefined)).toBe(1);
    expect(prizesForRuleBox(null as never)).toBe(1);
  });

  it('★表に載っているクラスを1つも取りこぼしていない', () => {
    expect(Object.keys(RULE_BOX_RULES)).toHaveLength(cases.length);
    for (const [ruleBox] of cases) expect(RULE_BOX_RULES[ruleBox]).toBeTruthy();
  });
});

// ── 2. ★対戦中1回（プレイヤー単位） ──────

describe('★GXワザ / VSTARパワーは対戦中1回', () => {
  /** バトル場のGXポケモンでGXワザを使う */
  const useGx = (state: GameState, slotId: 'active' | 'bench-0' = 'active'): GameState =>
    applyAction(
      state,
      act({
        type: 'useAttack',
        playerId: ALICE,
        slotId,
        attackIndex: slotId === 'active' ? 1 : 0,
        attackName: 'テストGX',
      }),
      ctx,
    );

  it('使う前は枠が空いている', () => {
    expect(hasUsedOncePerGame(table(), ALICE, 'gx')).toBe(false);
  });

  it('GXワザを使うと枠が埋まる', () => {
    const used = useGx(table());
    expect(hasUsedOncePerGame(used, ALICE, 'gx')).toBe(true);
    expect(lastWarnings(used)).not.toContain(WARNING_CODES.ONCE_PER_GAME_USED);
  });

  it('★2回目は警告が出る。ただし止めない', () => {
    const twice = useGx(useGx(table()));
    expect(lastWarnings(twice)).toContain(WARNING_CODES.ONCE_PER_GAME_USED);
    // 操作そのものはログに残っている（通っている）
    expect(twice.log[twice.log.length - 1]?.action.type).toBe('useAttack');
  });

  it('★別のGXポケモンでも使えない（ポケモン単位ではなくプレイヤー単位）', () => {
    const used = useGx(table());
    const other = useGx(used, 'bench-0');
    expect(lastWarnings(other)).toContain(WARNING_CODES.ONCE_PER_GAME_USED);
  });

  it('★番が変わっても戻らない（対戦中1回であって、番に1回ではない）', () => {
    const used = useGx(table());
    const nextTurn = applyAction(used, act({ type: 'endTurn' }), ctx);
    expect(hasUsedOncePerGame(nextTurn, ALICE, 'gx')).toBe(true);
  });

  it('相手の枠は別勘定', () => {
    const used = useGx(table());
    expect(hasUsedOncePerGame(used, BOB, 'gx')).toBe(false);
  });

  it('通常のワザは枠を使わない', () => {
    const normal = applyAction(
      table(),
      act({ type: 'useAttack', playerId: ALICE, slotId: 'active', attackIndex: 0 }),
      ctx,
    );
    expect(hasUsedOncePerGame(normal, ALICE, 'gx')).toBe(false);
  });

  it('★VSTARパワーは特性から使っても同じ枠を消費する', () => {
    const used = startEffectOn(table(), 'a-vstar');
    expect(hasUsedOncePerGame(used, ALICE, 'vstar')).toBe(true);
    // GX の枠は別
    expect(hasUsedOncePerGame(used, ALICE, 'gx')).toBe(false);

    const twice = startEffectOn(used, 'a-vstar');
    const startWarnings = twice.log
      .filter((entry) => entry.action.type === 'startEffect')
      .flatMap((entry) => entry.warnings.map((w) => w.code));
    expect(startWarnings).toContain(WARNING_CODES.ONCE_PER_GAME_USED);
  });

  it('★手で戻せる（効果で例外的にもう1回使えるカードのため）', () => {
    const used = useGx(table());
    const reset = applyAction(
      used,
      act({ type: 'setOncePerGameUsed', playerId: ALICE, kind: 'gx', value: false }),
      ctx,
    );
    expect(hasUsedOncePerGame(reset, ALICE, 'gx')).toBe(false);
  });
});

// ── 3. M進化 ──────────────────────────

describe('★M進化すると自分の番が終わる', () => {
  it('知らせるだけで、勝手に番を終わらせない', () => {
    const state = applyAction(
      table(),
      act({ type: 'evolvePokemon', playerId: ALICE, slotId: 'active', cardId: 'a-mega' }),
      ctx,
    );
    const warning = state.log[state.log.length - 1]?.warnings.find(
      (w) => w.code === WARNING_CODES.MEGA_EVOLUTION_ENDS_TURN,
    );
    expect(warning?.severity).toBe('info');
    // ★番はそのまま。終わらせるのは人の操作
    expect(state.turn).toBe(3);
    expect(state.activePlayer).toBe(table().activePlayer);
  });

  it('M進化でないなら出ない', () => {
    const state = applyAction(
      table(),
      act({ type: 'evolvePokemon', playerId: ALICE, slotId: 'active', cardId: 'a-ex' }),
      ctx,
    );
    expect(lastWarnings(state)).not.toContain(WARNING_CODES.MEGA_EVOLUTION_ENDS_TURN);
  });

  it('表の上でも MEGA だけが番を終わらせる', () => {
    expect(ruleFor('MEGA').endsTurnOnEvolve).toBe(true);
    const others = Object.entries(RULE_BOX_RULES).filter(([key]) => key !== 'MEGA');
    expect(others.every(([, rule]) => !rule.endsTurnOnEvolve)).toBe(true);
  });
});

// ── 4. プリズムスター ───────────────────

describe('★プリズムスターはトラッシュではなくロストゾーンへ', () => {
  it('行き先の表が lost になっている', () => {
    expect(discardZoneFor('PRISM')).toBe('lost');
    expect(discardZoneFor('GX')).toBe('discard');
    expect(discardZoneFor(undefined)).toBe('discard');
  });

  it('★きぜつしたプリズムスターはロストゾーンへ。ついていたカードはトラッシュ', () => {
    const placed = applyActions(
      table(),
      [
        act({ type: 'removePokemon', playerId: ALICE, slotId: 'bench-1', toZone: 'deck' }),
        act({ type: 'placePokemon', playerId: ALICE, slotId: 'bench-1', cardId: 'a-prism' }),
        act({ type: 'attachCard', playerId: ALICE, slotId: 'bench-1', cardId: 'a-ex', as: 'tool' }),
      ],
      ctx,
    );

    const knocked = applyAction(
      placed,
      act({
        type: 'knockOut',
        playerId: ALICE,
        slotId: 'bench-1',
        expectedTopInstanceId: 'a-prism',
        prizePlayerId: BOB,
        prizeCount: 1,
        prizeCardIds: [],
      }),
      ctx,
    );

    expect(knocked.cards['a-prism']?.zone).toBe('lost');
    // ★プリズムスターでないカードはトラッシュのまま
    expect(knocked.cards['a-ex']?.zone).toBe('discard');
  });

  it('デッキに入れられるのは1枚（かがやくポケモンと同じ扱い）', () => {
    expect(ruleFor('PRISM').deckLimit).toBe(1);
    expect(ruleFor('RADIANT').deckLimit).toBe(1);
    expect(ruleFor('GX').deckLimit).toBeNull();
  });
});

// ── 5. 別名カード ──────────────────────

describe('EX は元のポケモンと別名カード', () => {
  it('4枚制限は名前の完全一致で数えるので、自然に別扱いになる', () => {
    expect(EX_MON.name).not.toBe(PLAIN.name);
    expect(ctx.cards?.byName.get('テストEX')).toHaveLength(1);
    expect(ctx.cards?.byName.get('ゼニガメ')).toHaveLength(1);
  });
});
