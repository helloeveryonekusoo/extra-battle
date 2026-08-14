/**
 * T40 その他のエクストラ固有要素。完了条件は「各要素の単体テストが通る」。
 *
 *   1. フレア団ハイパーギア … 相手のポケモンEXにつけるどうぐ（持ち主と装着先が違う）
 *   2. 所属タグ            … CardFilter.tag で参照できる
 *   3. デュアルタイプ       … 弱点判定が2タイプ分効く
 *   4. ロストゾーン         … プリズムスターの行き先
 *   5. ★クレッフィ          … ポケモンがどうぐになり、相手の番の終わりにトラッシュされる
 */
import { describe, expect, it } from 'vitest';
import { applyAction, applyActions, type Action } from './actions';
import { matchesCardFilter } from './cardFilter';
import { buildCardIndex } from './cards';
import { damageInputFromState, runDamagePipeline } from './damageCalculation';
import { continuousDamageModifier, getEffectiveAbilities } from './derived';
import { effectSlotKey } from './effects';
import { createGameState, withCards } from './gameState';
import { discardZoneFor } from './ruleBox';
import type { RuleContext } from './rules';
import { ALICE, BOB, tick } from './testFixtures';
import type { CardInstance, CardText, GameState, PlayerId } from './types';

const act = <T extends Omit<Action, 'actorId' | 'at'>>(a: T, actorId: PlayerId = ALICE): Action =>
  ({ ...a, actorId, at: tick() }) as Action;

// ── カード定義 ────────────────────────

const mon = (over: Partial<CardText> & Pick<CardText, 'functionalId' | 'name'>): CardText => ({
  supertype: 'pokemon',
  hp: 120,
  types: ['water'],
  stage: 'basic',
  ruleBox: null,
  attacks: [{ name: 'たいあたり', cost: ['colorless'], damage: '30', text: '' }],
  weakness: null,
  resistance: null,
  retreatCost: 1,
  ...over,
});

const PLAIN = mon({ functionalId: 'fn-plain', name: 'ゼニガメ' });

/** 相手のポケモンEXにつけるどうぐ。★持ち主と装着先が違う */
const HYPER_GEAR: CardText = {
  functionalId: 'fn-gear',
  name: 'ダミーのフレア団ハイパーギア',
  supertype: 'trainer',
  trainerKind: 'tool',
  text: '相手のポケモンEXにつける。このポケモンが受けるワザのダメージは+30される。',
  continuous: [
    {
      kind: 'damageModifier',
      scope: 'self',
      applyAt: 'step5',
      delta: 30,
      on: 'attached',
      label: 'ハイパーギア 受けるダメージ +30',
    },
  ],
};

const EX_MON = mon({ functionalId: 'fn-ex', name: 'テストEX', ruleBox: 'EX', hp: 180 });

/** ★所属タグを持つカード（プラズマ団 / フュージョン等） */
const TAGGED = mon({
  functionalId: 'fn-tagged',
  name: 'プラズマ団のポケモン',
  tags: ['プラズマ団', 'フュージョン'],
});

/** ★デュアルタイプ。弱点判定が2タイプ分効くことを確かめる */
const DUAL = mon({ functionalId: 'fn-dual', name: 'デュアルタイプ', types: ['fire', 'water'] });

/** 炎弱点のポケモン */
const FIRE_WEAK = mon({
  functionalId: 'fn-fireweak',
  name: '炎弱点',
  weakness: { type: 'fire', modifier: '×2' },
});

/** プリズムスター。★きぜつ・使用後はロストゾーン */
const PRISM_ITEM: CardText = {
  functionalId: 'fn-prism-item',
  name: 'ダミーのプリズムスター◇',
  supertype: 'trainer',
  trainerKind: 'item',
  ruleBox: 'PRISM',
  text: 'テスト。',
};

/**
 * ★クレッフィ相当。ポケモンだが、どうぐとして相手のポケモンにつく。
 *   ついている間、おたがいのどうぐの効果を消す（ダストダスと組む形）。
 */
const KLEFKI = mon({
  functionalId: 'fn-klefki',
  name: 'ダミーのクレッフィ',
  types: ['metal'],
  abilities: [
    {
      name: 'ワンダーロック',
      kind: 'ability',
      text: 'このポケモンは、どうぐとしてつけられる。',
      trigger: 'passive',
    },
  ],
  continuous: [{ kind: 'lockAbilities', scope: 'all' }],
});

/** 特性持ち。クレッフィのロックが効くことを確かめる相手 */
const HAS_ABILITY = mon({
  functionalId: 'fn-ability',
  name: '特性持ち',
  abilities: [{ name: 'テスト特性', kind: 'ability', text: 'テスト' }],
});

const ctx: RuleContext = {
  cards: buildCardIndex([
    PLAIN, HYPER_GEAR, EX_MON, TAGGED, DUAL, FIRE_WEAK, PRISM_ITEM, KLEFKI, HAS_ABILITY,
  ]),
};

const card = (instanceId: string, fid: string, ownerId: PlayerId = ALICE): CardInstance => ({
  instanceId,
  functionalId: fid,
  ownerId,
  zone: 'deck',
  visibleTo: [],
  faceUp: false,
});

function table(aliceActive = 'fn-plain', bobActive = 'fn-ex'): GameState {
  const base = createGameState({
    gameId: 'g-extra',
    rngSeed: 'seed',
    seats: [
      { playerId: ALICE, displayName: 'アリス' },
      { playerId: BOB, displayName: 'ボブ' },
    ],
  });
  const cards = [
    card('a-active', aliceActive),
    card('a-gear', 'fn-gear'),
    card('a-klefki', 'fn-klefki'),
    card('a-prism', 'fn-prism-item'),
    card('b-active', bobActive, BOB),
    card('b-ability', 'fn-ability', BOB),
  ];
  return applyActions(
    withCards({ ...base, phase: 'turn', turn: 3, setup: null }, cards),
    [
      act({ type: 'placePokemon', playerId: ALICE, slotId: 'active', cardId: 'a-active' }),
      act({ type: 'placePokemon', playerId: BOB, slotId: 'active', cardId: 'b-active' }, BOB),
      act({ type: 'placePokemon', playerId: BOB, slotId: 'bench-0', cardId: 'b-ability' }, BOB),
    ],
    ctx,
  );
}

// ── 1. ★フレア団ハイパーギア ──────────────

describe('★相手のポケモンにつけるどうぐ（フレア団ハイパーギア）', () => {
  /** アリスのカードを、ボブのバトル場につける */
  const attached = (until?: 'endOfNextOpponentTurn'): GameState =>
    applyAction(
      table(),
      act({
        type: 'attachCard',
        playerId: BOB,
        slotId: 'active',
        cardId: 'a-gear',
        as: 'tool',
        ...(until ? { until } : {}),
      }),
      ctx,
    );

  it('★持ち主と装着先が違っても、どうぐとしてつく', () => {
    const state = attached();
    const slot = state.players[BOB]!.pokemon.find((p) => p.slotId === 'active');
    expect(slot?.attachedTool).toBe('a-gear');
    // ★持ち主はアリスのまま
    expect(state.cards['a-gear']?.ownerId).toBe(ALICE);
    // ゾーンはボブのバトル場
    expect(state.cards['a-gear']?.zone).toBe('active');
  });

  it('★効果は「ついているポケモン」に効く（＝相手側）', () => {
    const state = attached();
    const { delta, sources } = continuousDamageModifier(
      state,
      { playerId: ALICE, slotId: 'active' },
      { playerId: BOB, slotId: 'active' },
      'step5',
      ctx,
    );
    expect(delta).toBe(30);
    expect(sources[0]).toContain('ハイパーギア');
  });

  it('★きぜつすると、どうぐは **持ち主の** トラッシュへ戻る', () => {
    const knocked = applyAction(
      attached(),
      act({
        type: 'knockOut',
        playerId: BOB,
        slotId: 'active',
        expectedTopInstanceId: 'b-active',
        prizePlayerId: ALICE,
        prizeCount: 2,
        prizeCardIds: [],
      }),
      ctx,
    );
    expect(knocked.cards['a-gear']?.zone).toBe('discard');
    // ★持ち主はアリスなので、アリスのトラッシュに入る
    expect(knocked.cards['a-gear']?.ownerId).toBe(ALICE);
  });
});

// ── 2. 所属タグ ──────────────────────

describe('所属タグ（プラズマ団 / フュージョン等）', () => {
  it('CardFilter.tag で引ける', () => {
    expect(matchesCardFilter(TAGGED, { tag: ['プラズマ団'] })).toBe(true);
    expect(matchesCardFilter(TAGGED, { tag: ['フュージョン'] })).toBe(true);
    expect(matchesCardFilter(TAGGED, { tag: ['ロケット団'] })).toBe(false);
    expect(matchesCardFilter(PLAIN, { tag: ['プラズマ団'] })).toBe(false);
  });

  it('1つでも当てはまれば合う', () => {
    expect(matchesCardFilter(TAGGED, { tag: ['ロケット団', 'プラズマ団'] })).toBe(true);
  });

  it('他の条件とは AND で重なる', () => {
    expect(matchesCardFilter(TAGGED, { tag: ['プラズマ団'], stage: ['basic'] })).toBe(true);
    expect(matchesCardFilter(TAGGED, { tag: ['プラズマ団'], stage: ['stage2'] })).toBe(false);
  });
});

// ── 3. ★デュアルタイプ ────────────────

describe('★デュアルタイプは弱点判定が2タイプ分効く', () => {
  const damage = (attacker: CardText) =>
    runDamagePipeline(
      damageInputFromState(
        table(attacker.functionalId, 'fn-fireweak'),
        ctx,
        { playerId: ALICE, slotId: 'active' },
        { playerId: BOB, slotId: 'active' },
        {
          baseDamage: 100,
          attackerTypes: attacker.types ?? [],
          defender: FIRE_WEAK,
          targetIsBench: false,
        },
      ),
    );

  it('★2つ目のタイプでも弱点を突ける', () => {
    // デュアルタイプは fire / water。相手は炎弱点なので ×2 になる
    expect(damage(DUAL).finalDamage).toBe(200);
  });

  it('どちらのタイプも合わなければ弱点は乗らない', () => {
    expect(damage(PLAIN).finalDamage).toBe(100);
  });

  it('タイプの絞り込みも「1つでも一致すれば合う」', () => {
    expect(matchesCardFilter(DUAL, { types: ['water'] })).toBe(true);
    expect(matchesCardFilter(DUAL, { types: ['fire'] })).toBe(true);
    expect(matchesCardFilter(DUAL, { types: ['metal'] })).toBe(false);
  });
});

// ── 4. ロストゾーン ───────────────────

describe('ロストゾーン（プリズムスターの行き先）', () => {
  it('行き先の表が lost になっている', () => {
    expect(discardZoneFor('PRISM')).toBe('lost');
  });

  it('★トレーナーズのプリズムスターもロストゾーンへ送れる', () => {
    const state = applyAction(
      table(),
      act({ type: 'moveCard', cardId: 'a-prism', toZone: discardZoneFor(PRISM_ITEM.ruleBox) }),
      ctx,
    );
    expect(state.cards['a-prism']?.zone).toBe('lost');
    // ロストゾーンは両者に見える
    expect(state.cards['a-prism']?.visibleTo).toEqual([ALICE, BOB]);
  });
});

// ── 5. ★クレッフィ（ワンダーロック） ────────

describe('★ポケモンがどうぐになる（クレッフィ）', () => {
  /** アリスのクレッフィを自分のバトル場につける。既定は期限つき */
  const attachKlefki = (timed = true) =>
    applyAction(
      table(),
      act({
        type: 'attachCard',
        playerId: ALICE,
        slotId: 'active',
        cardId: 'a-klefki',
        as: 'tool',
        ...(timed ? { until: 'endOfNextOpponentTurn' as const } : {}),
      }),
      ctx,
    );

  const BOB_BENCH = effectSlotKey(BOB, 'bench-0');

  it('★ポケモンがどうぐ枠に入る（CardInstance の役割が変わる）', () => {
    const state = attachKlefki();
    expect(state.players[ALICE]!.pokemon.find((p) => p.slotId === 'active')?.attachedTool).toBe(
      'a-klefki',
    );
    // ポケモンとして場に出ているわけではない
    expect(state.players[ALICE]!.pokemon.some((p) => p.stack.includes('a-klefki'))).toBe(false);
  });

  it('★どうぐ化しているあいだ、その常時効果がはたらく', () => {
    const before = table();
    expect(getEffectiveAbilities(before, BOB_BENCH, ctx)).toHaveLength(1);

    const state = attachKlefki();
    expect(getEffectiveAbilities(state, BOB_BENCH, ctx)).toHaveLength(0);
  });

  it('★「相手の番の終わりにトラッシュ」が効果として立つ', () => {
    const state = attachKlefki();
    const effect = state.effects.find((e) => e.kind === 'temporaryTool');
    expect(effect).toBeTruthy();
    expect(effect?.payload['instanceId']).toBe('a-klefki');
    expect(effect?.duration).toEqual({ type: 'untilEndOfNextOpponentTurn' });
  });

  it('★自分の番が終わっただけでは外れない', () => {
    const state = applyAction(attachKlefki(), act({ type: 'endTurn' }), ctx);
    expect(state.cards['a-klefki']?.zone).toBe('active');
    expect(state.players[ALICE]!.pokemon[0]?.attachedTool).toBe('a-klefki');
  });

  it('★相手の番が終わるとトラッシュされ、どうぐ枠も空く', () => {
    const afterMine = applyAction(attachKlefki(), act({ type: 'endTurn' }), ctx);
    const afterTheirs = applyAction(afterMine, act({ type: 'endTurn' }, BOB), ctx);

    expect(afterTheirs.cards['a-klefki']?.zone).toBe('discard');
    expect(afterTheirs.players[ALICE]!.pokemon[0]?.attachedTool).toBeNull();
    // 効果も残らない
    expect(afterTheirs.effects.some((e) => e.kind === 'temporaryTool')).toBe(false);
  });

  it('★外れればロックも解ける', () => {
    const afterMine = applyAction(attachKlefki(), act({ type: 'endTurn' }), ctx);
    const afterTheirs = applyAction(afterMine, act({ type: 'endTurn' }, BOB), ctx);
    expect(getEffectiveAbilities(afterTheirs, BOB_BENCH, ctx)).toHaveLength(1);
  });

  it('期限を指定しなければ、ふつうのどうぐと同じで外れない', () => {
    const state = attachKlefki(false);
    expect(state.effects.some((e) => e.kind === 'temporaryTool')).toBe(false);
    const later = applyActions(
      state,
      [act({ type: 'endTurn' }), act({ type: 'endTurn' }, BOB)],
      ctx,
    );
    expect(later.cards['a-klefki']?.zone).toBe('active');
  });
});
