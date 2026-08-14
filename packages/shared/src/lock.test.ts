/**
 * T42 の完了条件:
 *   ★各ロックが正しく機能し、**発生源が場を離れると解除される**。
 *   ★ロックが2つ以上同時に場にあるときは警告が出て、該当ポケモンが ASSISTED に落ちる（§2.1）。
 *
 * あわせて §2.2 の統一表現そのものを確かめる:
 *   5種類のロックが、カードごとの分岐なしに **同じ判定関数** を通ること。
 */
import { describe, expect, it } from 'vitest';
import { applyAction, applyActionChecked, applyActions, type Action } from './actions';
import { buildCardIndex } from './cards';
import { damageInputFromState } from './damageCalculation';
import {
  canAttackAgain,
  canUseCardKind,
  getBenchLimit,
  getEffectiveAbilities,
  getEffectiveAbilityEntries,
  toolsNullified,
} from './derived';
import { effectSlotKey } from './effects';
import {
  abilityLockOn,
  attackDamageImmunity,
  attackLockOn,
  cardKindLockOn,
  collectLocks,
  describeLock,
  lockFromContinuous,
  lockHits,
  multipleLockWarning,
} from './lock';
import { createGameState, withCards } from './gameState';
import { WARNING_CODES, type RuleContext } from './rules';
import { ALICE, BOB, tick } from './testFixtures';
import type { CardInstance, CardText, GameState, LockEffect, PlayerId } from './types';

const act = <T extends Omit<Action, 'actorId' | 'at'>>(a: T, actorId: PlayerId = ALICE): Action =>
  ({ ...a, actorId, at: tick() }) as Action;

// ── カード定義。★すべて locks 宣言だけで書く（個別実装をしない） ──

const mon = (fid: string, name: string, over: Partial<CardText> = {}): CardText => ({
  functionalId: fid,
  name,
  supertype: 'pokemon',
  hp: 120,
  types: ['water'],
  stage: 'basic',
  ruleBox: null,
  abilities: [{ name: `${name}の特性`, text: '', kind: 'ability' }],
  attacks: [{ name: 'たいあたり', cost: ['colorless'], damage: '30', text: '' }],
  weakness: null,
  resistance: null,
  retreatCost: 1,
  ...over,
});

/** 特性を持つだけのポケモン（ロックの的） */
const BASIC = mon('t-basic', 'たねポケモン');
const STAGE1 = mon('t-stage1', '1進化ポケモン', { stage: 'stage1', evolvesFrom: 'たねポケモン' });
const RULE_MON = mon('t-rule', 'ルール持ちV', { ruleBox: 'V', hp: 210 });

/** ソーナンス型: たねポケモン（自分をのぞく）の特性がなくなる */
const WOBBUFFET = mon('t-wobb', 'ソーナンス型', {
  locks: [
    {
      kind: 'abilityLock',
      scope: { player: 'both', filter: { stage: ['basic'] } },
      exceptSelf: true,
      requiresActive: false,
      label: 'たねポケモンの特性がなくなる',
    },
  ],
});

/** ガラルマタドガス型: バトル場にいるあいだ、すべての特性がなくなる */
const WEEZING = mon('t-weez', 'ガラルマタドガス型', {
  stage: 'stage1',
  locks: [
    {
      kind: 'abilityLock',
      scope: { player: 'both', filter: {} },
      exceptSelf: true,
      requiresActive: true,
    },
  ],
});

/** 頂への雪道型: ルールを持つポケモンの特性がなくなる（スタジアム） */
const SNOW_ROAD: CardText = {
  functionalId: 't-snow',
  name: '頂への雪道型',
  supertype: 'trainer',
  trainerKind: 'stadium',
  text: '',
  locks: [
    {
      kind: 'abilityLock',
      scope: { player: 'both', filter: { ruleBox: 'any' } },
      exceptSelf: false,
      requiresActive: false,
    },
  ],
};

/** ラフレシア型: おたがいグッズが使えない */
const VILEPLUME = mon('t-vile', 'ラフレシア型', {
  stage: 'stage2',
  locks: [
    {
      kind: 'cardKindLock',
      scope: { player: 'both', filter: {} },
      exceptSelf: false,
      requiresActive: false,
      payload: { trainerKind: ['item'] },
    },
  ],
});

/** メガニウム型: 相手のたねポケモンはワザを使えない */
const MEGANIUM = mon('t-mega', 'メガニウム型', {
  stage: 'stage2',
  locks: [
    {
      kind: 'attackLock',
      scope: { player: 'opponent', filter: { stage: ['basic'] } },
      exceptSelf: false,
      requiresActive: false,
    },
  ],
});

/** ジュナイパー型: たねポケモンからワザのダメージを受けない */
const DECIDUEYE = mon('t-deci', 'ジュナイパー型', {
  stage: 'stage2',
  locks: [
    {
      kind: 'attackDamageImmunity',
      scope: { player: 'self', filter: { stage: ['basic'] } },
      exceptSelf: false,
      requiresActive: false,
    },
  ],
});

/** ムゲンダイナVMAX型: 自分の場が水ポケモンだけならベンチ8 */
const ETERNATUS = mon('t-eter', 'ムゲンダイナ型', {
  ruleBox: 'VMAX',
  locks: [
    {
      kind: 'benchLimit',
      scope: { player: 'self', filter: {} },
      exceptSelf: false,
      requiresActive: false,
      payload: { limit: 8, requiresAllOwnPokemon: { types: ['water'] } },
    },
  ],
});

/** ウソッキー型: おたがいベンチ4 */
const SUDOWOODO = mon('t-sudo', 'ウソッキー型', {
  types: ['fighting'],
  locks: [
    {
      kind: 'benchLimit',
      scope: { player: 'both', filter: {} },
      exceptSelf: false,
      requiresActive: false,
      payload: { limit: 4 },
    },
  ],
});

/** サイレントラボ型: 場・手札・トラッシュのたねポケモンの特性がなくなる */
const SILENT = mon('t-silent', 'サイレントラボ型', {
  locks: [
    {
      kind: 'abilityLock',
      scope: {
        player: 'both',
        filter: { stage: ['basic'] },
        zones: ['field', 'hand', 'discard'],
      },
      exceptSelf: false,
      requiresActive: false,
    },
  ],
});

/** ダストダス型: どうぐの効果がなくなる（★条件でどうぐを名指しする） */
const GARBODOR = mon('t-garb', 'ダストダス型', {
  stage: 'stage1',
  locks: [
    {
      kind: 'abilityLock',
      scope: { player: 'both', filter: { supertype: ['trainer'], trainerKind: ['tool'] } },
      exceptSelf: false,
      requiresActive: false,
      label: 'どうぐの効果がなくなる',
    },
  ],
});

/** 常時効果を出すどうぐ。ダストダス型に止められる的 */
const BAND: CardText = {
  functionalId: 't-band',
  name: 'ちからのハチマキ型',
  supertype: 'trainer',
  trainerKind: 'tool',
  text: '',
  continuous: [
    {
      kind: 'damageModifier',
      scope: 'self',
      applyAt: 'step2',
      delta: 20,
      on: 'attached',
      label: 'ダメージ+20',
    },
  ],
};

const ITEM: CardText = {
  functionalId: 't-item',
  name: 'ダミーのグッズ',
  supertype: 'trainer',
  trainerKind: 'item',
  text: '',
};

const POOL = [
  BASIC,
  STAGE1,
  RULE_MON,
  WOBBUFFET,
  WEEZING,
  SNOW_ROAD,
  VILEPLUME,
  MEGANIUM,
  DECIDUEYE,
  ETERNATUS,
  SUDOWOODO,
  SILENT,
  GARBODOR,
  BAND,
  ITEM,
];
const ctx: RuleContext = { cards: buildCardIndex(POOL) };

const card = (instanceId: string, ownerId: PlayerId, fid: string, position: number): CardInstance => ({
  instanceId,
  functionalId: fid,
  ownerId,
  zone: 'hand',
  visibleTo: [ownerId],
  faceUp: false,
  position,
});

/** 手札に全部そろえた卓。バトル場はアリス=たね、ボブ=たね */
function table(): GameState {
  const base = createGameState({
    gameId: 'g-lock',
    rngSeed: 'seed',
    seats: [
      { playerId: ALICE, displayName: 'アリス' },
      { playerId: BOB, displayName: 'ボブ' },
    ],
  });
  const seeded = withCards(base, [
    card('a-basic', ALICE, 't-basic', 0),
    card('a-rule', ALICE, 't-rule', 1),
    card('a-eter', ALICE, 't-eter', 2),
    card('a-sudo', ALICE, 't-sudo', 3),
    card('a-band', ALICE, 't-band', 4),
    card('a-item', ALICE, 't-item', 5),
    card('a-deci', ALICE, 't-deci', 6),
    card('a-basic2', ALICE, 't-basic', 7),
    card('a-stage1', ALICE, 't-stage1', 8),
    card('b-basic', BOB, 't-basic', 0),
    card('b-wobb', BOB, 't-wobb', 1),
    card('b-weez', BOB, 't-weez', 2),
    card('b-vile', BOB, 't-vile', 3),
    card('b-mega', BOB, 't-mega', 4),
    card('b-garb', BOB, 't-garb', 5),
    card('b-snow', BOB, 't-snow', 6),
    card('b-silent', BOB, 't-silent', 7),
  ]);
  return applyActions(
    seeded,
    [
      act({ type: 'placePokemon', playerId: ALICE, slotId: 'active', cardId: 'a-basic' }),
      act({ type: 'placePokemon', playerId: BOB, slotId: 'active', cardId: 'b-basic' }, BOB),
      act({ type: 'setFirstPlayer', playerId: ALICE }),
      act({ type: 'setSetupStep', step: 'done' }),
    ],
    ctx,
  );
}

const place = (state: GameState, playerId: PlayerId, slotId: string, cardId: string): GameState =>
  applyAction(
    state,
    act({ type: 'placePokemon', playerId, slotId, cardId } as never, playerId),
    ctx,
  );

const ALICE_ACTIVE = effectSlotKey(ALICE, 'active');

// ── 完了条件① 各ロックが機能する ─────────

describe('★5種類のロックが、同じ統一表現で動く（§2.2）', () => {
  it('abilityLock: たねポケモンの特性が止まる。1進化は止まらない', () => {
    const state = place(table(), BOB, 'bench-0', 'b-wobb');
    expect(getEffectiveAbilities(state, ALICE_ACTIVE, ctx)).toHaveLength(0);
    expect(abilityLockOn(state, ALICE, 'active', ctx).sources).toEqual(['ソーナンス型']);
    // 1進化を出せばそちらは止まらない
    const evolved = applyAction(
      place(state, ALICE, 'bench-0', 'a-basic2'),
      act({ type: 'evolvePokemon', playerId: ALICE, slotId: 'bench-0', cardId: 'a-stage1' }),
      ctx,
    );
    expect(abilityLockOn(evolved, ALICE, 'bench-0', ctx).locked).toBe(false);
  });

  it('★exceptSelf: ロックを出している当のカードは止まらない', () => {
    const state = place(table(), BOB, 'bench-0', 'b-wobb');
    expect(abilityLockOn(state, BOB, 'bench-0', ctx).locked).toBe(false);
    // 同じ たね である相手のバトル場は止まっている
    expect(abilityLockOn(state, ALICE, 'active', ctx).locked).toBe(true);
  });

  it('★exceptSelf: false なら自分も対象（ダストダス型は自分のどうぐも止める）', () => {
    const attached = applyAction(
      table(),
      act({ type: 'attachCard', playerId: ALICE, slotId: 'active', cardId: 'a-band', as: 'tool' }),
      ctx,
    );
    expect(toolsNullified(attached, ALICE, ctx)).toBe(false);
    const withGarb = place(attached, BOB, 'bench-0', 'b-garb');
    expect(toolsNullified(withGarb, ALICE, ctx)).toBe(true);
    expect(toolsNullified(withGarb, BOB, ctx)).toBe(true);
  });

  it('cardKindLock: グッズが使えなくなる', () => {
    const state = place(table(), BOB, 'bench-0', 'b-vile');
    expect(canUseCardKind(state, ALICE, 'item', ctx)).toBe(false);
    expect(canUseCardKind(state, ALICE, 'supporter', ctx)).toBe(true);
    expect(cardKindLockOn(state, ALICE, 'item', ctx).sources).toEqual(['ラフレシア型']);
  });

  it('attackLock: ★貫通ワザも通らない（ワザの宣言そのものができない）', () => {
    const state = place(table(), BOB, 'bench-0', 'b-mega');
    expect(attackLockOn(state, ALICE, 'active', ctx).locked).toBe(true);
    expect(canAttackAgain(state, ALICE, 'active', ctx)).toBe(false);
    // 相手（宣言した側）は自由に使える
    expect(canAttackAgain(state, BOB, 'active', ctx)).toBe(true);
  });

  it('attackDamageImmunity: たねポケモンからのワザのダメージを受けない', () => {
    const state = place(table(), ALICE, 'bench-0', 'a-deci');
    const input = damageInputFromState(
      state,
      ctx,
      { playerId: BOB, slotId: 'active' },
      { playerId: ALICE, slotId: 'bench-0' },
      { baseDamage: 100, attackerTypes: ['water'], defender: {}, targetIsBench: true },
    );
    expect(input.targetPreventsDamage).toBe(true);
    // 守られていないポケモンには効かない
    const other = damageInputFromState(
      state,
      ctx,
      { playerId: BOB, slotId: 'active' },
      { playerId: ALICE, slotId: 'active' },
      { baseDamage: 100, attackerTypes: ['water'], defender: {}, targetIsBench: false },
    );
    expect(other.targetPreventsDamage).toBe(false);
  });

  it('benchLimit: ★低いほうを採る（§2.3）', () => {
    const eight = place(table(), ALICE, 'bench-0', 'a-eter');
    expect(getBenchLimit(eight, ALICE, ctx)).toBe(8);
    const both = place(eight, ALICE, 'bench-1', 'a-sudo');
    // ウソッキー型は闘タイプなので「水だけ」の条件が崩れ、8 の宣言自体が消える
    expect(getBenchLimit(both, ALICE, ctx)).toBe(4);
    expect(getBenchLimit(both, BOB, ctx)).toBe(4);
  });

  it('benchLimit: 条件（自分の場が水だけ）を満たさなければ宣言そのものがはたらかない', () => {
    const mixed = place(place(table(), ALICE, 'bench-0', 'a-eter'), ALICE, 'bench-1', 'a-sudo');
    expect(collectLocks(mixed, ctx).some((s) => s.card.name === 'ムゲンダイナ型')).toBe(false);
  });
});

// ── 完了条件② 発生源が場を離れると解除される ──

describe('★発生源が場を離れると解除される', () => {
  it('ベンチのロックポケモンをトラッシュすると特性が戻る', () => {
    const locked = place(table(), BOB, 'bench-0', 'b-wobb');
    expect(getEffectiveAbilities(locked, ALICE_ACTIVE, ctx)).toHaveLength(0);

    const gone = applyAction(
      locked,
      act({ type: 'moveCard', cardId: 'b-wobb', toZone: 'discard' }, BOB),
      ctx,
    );
    expect(getEffectiveAbilities(gone, ALICE_ACTIVE, ctx)).toHaveLength(1);
    // ★状態には何も書き込んでいない（派生状態である）
    expect(gone.effects).toEqual([]);
  });

  it('★requiresActive: バトル場を離れたら効かない（ガラルマタドガス型）', () => {
    const onBench = place(table(), BOB, 'bench-0', 'b-weez');
    expect(collectLocks(onBench, ctx)).toHaveLength(0);
    expect(abilityLockOn(onBench, ALICE, 'active', ctx).locked).toBe(false);

    const swapped = applyAction(
      onBench,
      act({ type: 'movePokemon', playerId: BOB, fromSlotId: 'bench-0', toSlotId: 'active' }, BOB),
      ctx,
    );
    expect(collectLocks(swapped, ctx)).toHaveLength(1);
    expect(abilityLockOn(swapped, ALICE, 'active', ctx).locked).toBe(true);
  });

  it('スタジアムを張り替えるとロックが消える', () => {
    const withStadium = applyAction(
      table(),
      act({ type: 'setStadium', cardId: 'b-snow' }, BOB),
      ctx,
    );
    const ruled = place(withStadium, ALICE, 'bench-0', 'a-rule');
    expect(abilityLockOn(ruled, ALICE, 'bench-0', ctx).locked).toBe(true);

    const removed = applyAction(ruled, act({ type: 'setStadium', cardId: null }, BOB), ctx);
    expect(abilityLockOn(removed, ALICE, 'bench-0', ctx).locked).toBe(false);
  });
});

// ── ★及ぶ場所（場 / 手札 / トラッシュ。T43） ──

describe('★ロックが及ぶ場所', () => {
  it('宣言がなければ場だけ。手札・トラッシュのカードには効かない', () => {
    const state = place(table(), BOB, 'bench-0', 'b-wobb');
    const locks = collectLocks(state, ctx);
    const target = { playerId: ALICE, slotId: null, card: BASIC };
    // 場としてなら効く
    expect(locks.some((s) => lockHits(s, { ...target, zone: 'field' }))).toBe(true);
    // ★手札・トラッシュには及ばない
    expect(locks.some((s) => lockHits(s, { ...target, zone: 'hand' }))).toBe(false);
    expect(locks.some((s) => lockHits(s, { ...target, zone: 'discard' }))).toBe(false);
  });

  it('zones を書けば手札・トラッシュにも及ぶ（ソーナンス / サイレントラボ）', () => {
    const state = place(table(), BOB, 'bench-1', 'b-silent');
    const locks = collectLocks(state, ctx);
    const target = { playerId: ALICE, slotId: null, card: BASIC };
    for (const zone of ['field', 'hand', 'discard'] as const) {
      expect(locks.some((s) => lockHits(s, { ...target, zone })), zone).toBe(true);
    }
  });
});

// ── ★§2.1 固定点計算をしない ────────────

describe('★固定点計算をしない（§2.1）', () => {
  it('ロック効果自体はロックされない', () => {
    // ガラルマタドガス型（すべての特性を止める）と、ソーナンス型（たねの特性を止める）が同居
    const state = place(
      applyAction(
        place(table(), BOB, 'bench-0', 'b-weez'),
        act({ type: 'movePokemon', playerId: BOB, fromSlotId: 'bench-0', toSlotId: 'active' }, BOB),
        ctx,
      ),
      BOB,
      'bench-1',
      'b-wobb',
    );
    // ★どちらも生きている。互いに打ち消し合わない
    expect(collectLocks(state, ctx).map((s) => s.card.name).sort()).toEqual([
      'ガラルマタドガス型',
      'ソーナンス型',
    ]);
  });

  it('★2つ以上あるときは警告が出て、影響を受けるポケモンが ASSISTED に落ちる', () => {
    const one = place(table(), BOB, 'bench-0', 'b-wobb');
    expect(multipleLockWarning(one, ctx).multiple).toBe(false);
    expect(abilityLockOn(one, ALICE, 'active', ctx).assisted).toBe(false);

    const two = place(one, BOB, 'bench-1', 'b-vile');
    const warning = multipleLockWarning(two, ctx);
    expect(warning.multiple).toBe(true);
    expect(warning.message).toContain('自動判定しません');
    expect(warning.details).toHaveLength(2);

    const verdict = abilityLockOn(two, ALICE, 'active', ctx);
    expect(verdict.locked).toBe(true);
    // ★答えは出すが、信用しない印をつける
    expect(verdict.assisted).toBe(true);
  });

  it('ロックの影響を受けていないポケモンは ASSISTED にしない（画面が騒がしくなるため）', () => {
    const two = place(place(table(), BOB, 'bench-0', 'b-wobb'), BOB, 'bench-1', 'b-vile');
    // ソーナンス型自身は exceptSelf でロック対象外
    expect(abilityLockOn(two, BOB, 'bench-0', ctx).assisted).toBe(false);
  });

  it('特性の一覧はロックされても消えない（§4.1 のグレーアウト用）', () => {
    const locked = place(table(), BOB, 'bench-0', 'b-wobb');
    const entries = getEffectiveAbilityEntries(locked, ALICE_ACTIVE, ctx);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.lock.locked).toBe(true);
    expect(entries[0]?.lock.reason).toContain('ソーナンス型');
    // 使える一覧のほうからは消える
    expect(getEffectiveAbilities(locked, ALICE_ACTIVE, ctx)).toHaveLength(0);
  });
});

// ── 警告はするが、禁止はしない（第2段階 §2） ──

describe('★ロックされていても操作は通る', () => {
  it('ワザ封じ中にワザを使うと警告が出て、それでも通る', () => {
    const state = place(table(), BOB, 'bench-0', 'b-mega');
    const result = applyActionChecked(
      state,
      act({ type: 'useAttack', playerId: ALICE, slotId: 'active', attackIndex: 0, attackName: 'たいあたり' }),
      ctx,
    );
    expect(result.warnings.map((w) => w.code)).toContain(WARNING_CODES.ATTACK_LOCKED);
    expect(result.state.players[ALICE]?.turnFlags.attacksUsed).toBe(1);
  });

  it('グッズロック中にグッズを使うと警告が出て、それでも通る', () => {
    const state = place(table(), BOB, 'bench-0', 'b-vile');
    const result = applyActionChecked(
      state,
      act({ type: 'moveCard', cardId: 'a-item', toZone: 'discard' }),
      ctx,
    );
    expect(result.warnings.map((w) => w.code)).toContain(WARNING_CODES.CARD_KIND_LOCKED);
    expect(result.state.cards['a-item']?.zone).toBe('discard');
  });

  it('★ロックが2つ以上になった瞬間がログに残る', () => {
    const one = place(table(), BOB, 'bench-0', 'b-wobb');
    const two = applyActionChecked(
      one,
      act({ type: 'placePokemon', playerId: BOB, slotId: 'bench-1', cardId: 'b-vile' }, BOB),
      ctx,
    );
    expect(two.warnings.map((w) => w.code)).toContain(WARNING_CODES.MULTIPLE_LOCKS);
    // 3つめでは繰り返さない（すでに複数だったので）
    const three = applyActionChecked(
      two.state,
      act({ type: 'placePokemon', playerId: BOB, slotId: 'bench-2', cardId: 'b-mega' }, BOB),
      ctx,
    );
    expect(three.warnings.map((w) => w.code)).not.toContain(WARNING_CODES.MULTIPLE_LOCKS);
  });
});

// ── 旧データとの橋 ────────────────────

describe('第3段階までの continuous 宣言も同じ道を通る', () => {
  it('lockAbilities / lockCardKind / benchLimit / nullifyTools が読み替えられる', () => {
    const ability = lockFromContinuous({ kind: 'lockAbilities', scope: 'all', filter: { stage: ['basic'] } });
    expect(ability?.kind).toBe('abilityLock');
    expect(ability?.scope.player).toBe('both');

    const kind = lockFromContinuous({ kind: 'lockCardKind', scope: 'opponent', trainerKind: ['item'] });
    expect(kind?.kind).toBe('cardKindLock');
    expect(kind?.scope.player).toBe('opponent');

    const bench = lockFromContinuous({ kind: 'benchLimit', scope: 'all', limit: 8 });
    expect(bench?.payload?.['limit']).toBe(8);

    // ★どうぐの効果を消す宣言も、どうぐを名指しした特性ロックとして表す
    const tools = lockFromContinuous({ kind: 'nullifyTools', scope: 'all' });
    expect(tools?.kind).toBe('abilityLock');
    expect(tools?.scope.filter).toEqual({ supertype: ['trainer'], trainerKind: ['tool'] });

    expect(lockFromContinuous({ kind: 'damageModifier', scope: 'self' })).toBeNull();
  });

  it('条件を書いていない特性ロックは、どうぐまでは止めない', () => {
    // ガラルマタドガス型（filter なし）はポケモンの特性だけを止める
    const attached = applyAction(
      table(),
      act({ type: 'attachCard', playerId: ALICE, slotId: 'active', cardId: 'a-band', as: 'tool' }),
      ctx,
    );
    const weez = applyAction(
      place(attached, BOB, 'bench-0', 'b-weez'),
      act({ type: 'movePokemon', playerId: BOB, fromSlotId: 'bench-0', toSlotId: 'active' }, BOB),
      ctx,
    );
    expect(abilityLockOn(weez, ALICE, 'active', ctx).locked).toBe(true);
    expect(toolsNullified(weez, ALICE, ctx)).toBe(false);
  });
});

// ── 説明文 ──────────────────────────

describe('画面に出す説明', () => {
  it('label があればそれを使い、なければ種類から組み立てる', () => {
    const state = place(table(), BOB, 'bench-0', 'b-vile');
    const source = collectLocks(state, ctx)[0];
    expect(source && describeLock(source)).toBe('グッズが使えない');
  });

  it('ベンチ上限は数まで出す', () => {
    const state = place(table(), ALICE, 'bench-0', 'a-sudo');
    const source = collectLocks(state, ctx)[0];
    expect(source && describeLock(source)).toBe('ベンチ上限 4');
  });
});

// ── ワザでかけるカード種別ロック（ガマゲロゲEX） ──

describe('ワザでかけたカード種別ロックも同じ窓口から見える', () => {
  const lockEffect = (state: GameState): GameState =>
    applyAction(
      state,
      act({
        type: 'startEffect',
        executionId: 'x-gekogeko',
        ops: [
          {
            op: 'applyEffect',
            effect: {
              target: { player: 'opponent' },
              applyAt: 'none',
              kind: 'lockCardKind',
              payload: { trainerKind: ['item'] },
              duration: { type: 'untilEndOfNextOpponentTurn' },
              label: 'グッズが使えない',
            },
          },
        ],
        source: { instanceId: 'b-basic', playerId: BOB, label: 'げこげこアタック' },
      } as never, BOB),
      ctx,
    );

  it('かかっている効果でもグッズが止まる', () => {
    const started = lockEffect(table());
    const stepped = applyAction(started, act({ type: 'effectStep', executionId: 'x-gekogeko' } as never, BOB), ctx);
    expect(canUseCardKind(stepped, ALICE, 'item', ctx)).toBe(false);
    // ★盤面のロックではないので、ロックの数には数えない（相互作用の警告を汚さない）
    expect(collectLocks(stepped, ctx)).toHaveLength(0);
  });
});

// ── 型の形（統一表現であること） ────────

describe('★統一表現であることそのもの', () => {
  it('5種類すべてが同じキーの組み合わせで書ける', () => {
    const declared: LockEffect[] = POOL.flatMap((c) => c.locks ?? []);
    for (const lock of declared) {
      expect(typeof lock.exceptSelf).toBe('boolean');
      expect(typeof lock.requiresActive).toBe('boolean');
      expect(['self', 'opponent', 'both']).toContain(lock.scope.player);
      expect(typeof lock.scope.filter).toBe('object');
    }
    expect(new Set(declared.map((l) => l.kind)).size).toBe(5);
  });

  it('attackDamageImmunity は攻撃側のカードを条件にする', () => {
    const state = place(table(), ALICE, 'bench-0', 'a-deci');
    const verdict = attackDamageImmunity(
      state,
      { playerId: ALICE, slotId: 'bench-0' },
      { playerId: BOB, slotId: 'active' },
      ctx,
    );
    expect(verdict.locked).toBe(true);
    expect(verdict.sources).toEqual(['ジュナイパー型']);
  });
});
