/**
 * T42 §4.1 / §4.5: ロック状態の可視化。
 *
 * ★この段階でいちばん大事な画面。
 *   - ロックが出ているあいだ、何が止まっているかを常に出す
 *   - ★2つ以上あるときの警告は **消えないバナー**（トーストにしない）
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  applyActions,
  buildCardIndex,
  createGameState,
  withCards,
  type Action,
  type CardIndex,
  type CardInstance,
  type CardText,
  type GameState,
} from '@pokeca/shared';
import { LockBanner } from './LockBanner';
import { benchInfo, handLockOf, slotViewOf } from './boardView';

const ALICE = 'p-1';
const BOB = 'p-2';

const MON: CardText = {
  functionalId: 'fn-mon',
  name: 'とくせい持ち',
  supertype: 'pokemon',
  hp: 90,
  types: ['water'],
  stage: 'basic',
  ruleBox: null,
  abilities: [{ name: 'うらこうさく', text: '', kind: 'ability' }],
  attacks: [],
  weakness: null,
  resistance: null,
  retreatCost: 1,
};

const WOBB: CardText = {
  ...MON,
  functionalId: 'fn-wobb',
  name: 'ソーナンス型',
  abilities: [{ name: 'がまんのかべ', text: '', kind: 'ability' }],
  locks: [
    {
      kind: 'abilityLock',
      scope: { player: 'both', filter: { stage: ['basic'] } },
      exceptSelf: true,
      requiresActive: false,
      label: 'たねポケモンの特性がなくなる',
    },
  ],
};

const VILE: CardText = {
  ...MON,
  functionalId: 'fn-vile',
  name: 'ラフレシア型',
  abilities: [],
  locks: [
    {
      kind: 'cardKindLock',
      scope: { player: 'both', filter: {} },
      exceptSelf: false,
      requiresActive: false,
      payload: { trainerKind: ['item'] },
    },
  ],
};

const ITEM: CardText = {
  functionalId: 'fn-item',
  name: 'ダミーのグッズ',
  supertype: 'trainer',
  trainerKind: 'item',
  text: '',
};

const index: CardIndex = buildCardIndex([MON, WOBB, VILE, ITEM]);

const card = (instanceId: string, ownerId: string, fid: string, position: number): CardInstance => ({
  instanceId,
  functionalId: fid,
  ownerId,
  zone: 'hand',
  visibleTo: [ownerId],
  faceUp: false,
  position,
});

const act = (a: Record<string, unknown>, actorId = ALICE): Action =>
  ({ ...a, actorId, at: `2026-01-01T00:00:0${position()}Z` }) as unknown as Action;

let n = 0;
const position = () => (n = (n + 1) % 10);

function table(extra: Action[] = []): GameState {
  const base = createGameState({
    gameId: 'g-lockui',
    rngSeed: 'seed',
    seats: [
      { playerId: ALICE, displayName: 'アリス' },
      { playerId: BOB, displayName: 'ボブ' },
    ],
  });
  const seeded = withCards(base, [
    card('a-mon', ALICE, 'fn-mon', 0),
    card('a-item', ALICE, 'fn-item', 1),
    card('b-mon', BOB, 'fn-mon', 0),
    card('b-wobb', BOB, 'fn-wobb', 1),
    card('b-vile', BOB, 'fn-vile', 2),
  ]);
  return applyActions(
    seeded,
    [
      act({ type: 'placePokemon', playerId: ALICE, slotId: 'active', cardId: 'a-mon' }),
      act({ type: 'placePokemon', playerId: BOB, slotId: 'active', cardId: 'b-mon' }, BOB),
      act({ type: 'setFirstPlayer', playerId: ALICE }),
      act({ type: 'setSetupStep', step: 'done' }),
      ...extra,
    ],
    { cards: index },
  );
}

const withWobb = () =>
  table([act({ type: 'placePokemon', playerId: BOB, slotId: 'bench-0', cardId: 'b-wobb' }, BOB)]);

const withBoth = () =>
  table([
    act({ type: 'placePokemon', playerId: BOB, slotId: 'bench-0', cardId: 'b-wobb' }, BOB),
    act({ type: 'placePokemon', playerId: BOB, slotId: 'bench-1', cardId: 'b-vile' }, BOB),
  ]);

describe('§4.1 ロック状態の常時表示', () => {
  it('ロックが出ていなければ何も出さない', () => {
    const { container } = render(
      <LockBanner state={table()} cardIndex={index} viewerId={ALICE} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('ロックが出ていれば、発生源と内容を出す', () => {
    render(<LockBanner state={withWobb()} cardIndex={index} viewerId={ALICE} />);
    expect(screen.getByText('ソーナンス型')).toBeTruthy();
    expect(screen.getByText('たねポケモンの特性がなくなる')).toBeTruthy();
    // どちらの場のものか分かる
    expect(screen.getByText('相手')).toBeTruthy();
  });

  it('★1つだけなら「要確認」の警告は出さない', () => {
    render(<LockBanner state={withWobb()} cardIndex={index} viewerId={ALICE} />);
    expect(screen.queryByText('要確認')).toBeNull();
  });

  it('★2つ以上なら消えない警告を出す（§4.5。トーストにしない）', () => {
    render(<LockBanner state={withBoth()} cardIndex={index} viewerId={ALICE} />);
    expect(screen.getByText('要確認')).toBeTruthy();
    expect(screen.getByText(/自動判定しません/u)).toBeTruthy();
    // 一覧は2つとも出る
    expect(screen.getByText('ソーナンス型')).toBeTruthy();
    expect(screen.getByText('ラフレシア型')).toBeTruthy();
  });
});

describe('§4.1 盤面と手札の見え方', () => {
  it('★止まっている特性は一覧から消さず、印をつけて残す', () => {
    const view = slotViewOf(withWobb(), index, ALICE, 'active');
    expect(view.abilities).toHaveLength(1);
    expect(view.abilities[0]?.name).toBe('うらこうさく');
    expect(view.abilities[0]?.locked).toBe(true);
    expect(view.abilities[0]?.reason).toContain('ソーナンス型');
  });

  it('ロックがなければ印はつかない', () => {
    const view = slotViewOf(table(), index, ALICE, 'active');
    expect(view.abilities[0]?.locked).toBe(false);
  });

  it('★ロックが2つ以上なら「要確認」が立つ', () => {
    const view = slotViewOf(withBoth(), index, ALICE, 'active');
    expect(view.abilities[0]?.assisted).toBe(true);
  });

  it('手札の使えないカードには理由がつく', () => {
    const locked = handLockOf(withBoth(), index, ALICE, ITEM);
    expect(locked.locked).toBe(true);
    expect(locked.reason).toContain('ラフレシア型');
    // ポケモンはカード種別ロックの対象ではない
    expect(handLockOf(withBoth(), index, ALICE, MON).locked).toBe(false);
  });

  it('ベンチの空き数と内訳を出す（上限は可変）', () => {
    const info = benchInfo(table(), ALICE, index);
    expect(info.limit).toBe(5);
    expect(info.used).toBe(0);
    expect(info.free).toBe(5);
    expect(info.title).toContain('ベンチ 0/5');
  });
});
