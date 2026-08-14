/**
 * §5.2「かかっている効果の可視化」★重要。
 *
 * 自動化が進むほど盤面に何が効いているか見えなくなるので、
 * 「必ず見える」「日本語で読める」「押せば外せる」を固定する。
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ActiveEffect, GameState } from '@pokeca/shared';
import { buildCardIndex, effectSlotKey } from '@pokeca/shared';
import { buildDemoState, DEMO_ME } from '../../cards/demoState';
import { EffectBadges, GlobalEffectBar } from './EffectBadges';

const effect = (over: Partial<ActiveEffect> = {}): ActiveEffect => ({
  effectId: 'e1',
  source: { instanceId: null, playerId: DEMO_ME, label: 'オルタージェネシスGX' },
  target: { slotId: effectSlotKey(DEMO_ME, 'active') },
  applyAt: 'step5',
  kind: 'damageModifier',
  payload: { delta: 50, label: '受けるワザのダメージ +50' },
  duration: { type: 'untilEndOfNextOpponentTurn' },
  expiresOn: [],
  createdOnTurn: 3,
  ...over,
});

const withEffects = (effects: ActiveEffect[]): GameState => ({
  ...buildDemoState()!,
  effects,
});

describe('ポケモンに重ねるバッジ', () => {
  it('効果がなければ何も出さない', () => {
    render(<EffectBadges state={withEffects([])} playerId={DEMO_ME} slotId="active" />);
    expect(screen.queryByRole('list', { name: 'かかっている効果' })).toBeNull();
  });

  it('★かかっている効果が見える。ホバーで内容と残り期間が読める', () => {
    render(
      <EffectBadges state={withEffects([effect()])} playerId={DEMO_ME} slotId="active" />,
    );

    const badge = screen.getByRole('listitem');
    expect(badge.textContent).toBe('+50');
    expect(badge.getAttribute('title')).toContain('受けるワザのダメージ +50');
    expect(badge.getAttribute('title')).toContain('次の相手の番の終わりまで');
    expect(badge.getAttribute('title')).toContain('オルタージェネシスGX');
  });

  it('かかっていないスロットには出さない', () => {
    render(
      <EffectBadges state={withEffects([effect()])} playerId={DEMO_ME} slotId="bench-0" />,
    );
    expect(screen.queryByRole('listitem')).toBeNull();
  });

  it('種類ごとに違う記号を出す', () => {
    render(
      <EffectBadges
        state={withEffects([
          effect({ effectId: 'e1', kind: 'preventAttackDamage', payload: {} }),
          effect({ effectId: 'e2', kind: 'cannotRetreat', payload: {} }),
          effect({ effectId: 'e3', kind: 'damageModifier', payload: { delta: -30 } }),
        ])}
        playerId={DEMO_ME}
        slotId="active"
      />,
    );
    expect(screen.getAllByRole('listitem').map((b) => b.textContent)).toEqual(['盾', '逃', '-30']);
  });

  it('★押すと手で外せる（自動判定が取りこぼしても卓が止まらない）', () => {
    const dispatch = vi.fn();
    render(
      <EffectBadges
        state={withEffects([effect()])}
        playerId={DEMO_ME}
        slotId="active"
        dispatch={dispatch}
      />,
    );

    fireEvent.click(screen.getByRole('listitem'));
    expect(dispatch).toHaveBeenCalledWith({
      type: 'removeEffect',
      effectId: 'e1',
      label: '受けるワザのダメージ +50',
    });
  });

  it('読み取り専用の盤面では押せない', () => {
    render(<EffectBadges state={withEffects([effect()])} playerId={DEMO_ME} slotId="active" />);
    expect(screen.getByRole('listitem').tagName).toBe('SPAN');
  });
});

describe('★盤面上部のバー（全体・プレイヤー単位）', () => {
  const global = effect({
    effectId: 'g1',
    target: { global: true },
    kind: 'extraPrize',
    applyAt: 'none',
    payload: { delta: 1, label: 'サイドを1枚多くとる' },
    duration: { type: 'wholeGame' },
  });

  it('スロットにかからない効果はバーに出す', () => {
    render(<GlobalEffectBar state={withEffects([global])} />);
    const bar = screen.getByRole('list', { name: '場全体にかかっている効果' });
    expect(bar.textContent).toContain('場全体');
    expect(bar.textContent).toContain('サイドを1枚多くとる');
    expect(bar.textContent).toContain('対戦のあいだずっと');
  });

  it('プレイヤー単位ならその人の名前を出す', () => {
    render(
      <GlobalEffectBar
        state={withEffects([{ ...global, target: { player: DEMO_ME } }])}
      />,
    );
    expect(screen.getByRole('list').textContent).toContain('あなた');
  });

  it('スロットにかかっている効果はバーに出さない（バッジ側に出る）', () => {
    render(<GlobalEffectBar state={withEffects([effect()])} />);
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('バーからも外せる', () => {
    const dispatch = vi.fn();
    render(<GlobalEffectBar state={withEffects([global])} dispatch={dispatch} />);
    fireEvent.click(screen.getByRole('button', { name: 'サイドを1枚多くとる を外す' }));
    expect(dispatch).toHaveBeenCalledWith({
      type: 'removeEffect',
      effectId: 'g1',
      label: 'サイドを1枚多くとる',
    });
  });
});

// ── T27: 止まっている特性を見せる ──

describe('★特性が止まっていることが盤面で分かる（T27）', () => {
  const ABILITY_MON = {
    functionalId: 'fn-ab',
    name: 'インテレオン',
    supertype: 'pokemon' as const,
    hp: 90,
    types: ['water' as const],
    stage: 'basic' as const,
    ruleBox: null,
    abilities: [{ name: 'うらこうさく', text: '', kind: 'ability' as const }],
    attacks: [],
    weakness: null,
    resistance: null,
    retreatCost: 1,
  };
  const LOCK = {
    functionalId: 'fn-lock',
    name: 'ダミーのロック',
    supertype: 'trainer' as const,
    trainerKind: 'tool' as const,
    text: '特性が止まる。',
    continuous: [{ kind: 'lockAbilities' as const, scope: 'all' as const }],
  };
  const index = buildCardIndex([ABILITY_MON, LOCK]);

  /** バトル場に特性持ち。lock を true にするとロックのどうぐがついている */
  const board = (lock: boolean): GameState => {
    const base = buildDemoState()!;
    return {
      ...base,
      cards: {
        ...base.cards,
        'x-mon': {
          instanceId: 'x-mon',
          functionalId: 'fn-ab',
          ownerId: DEMO_ME,
          zone: 'active',
          visibleTo: [DEMO_ME],
          faceUp: true,
        },
        'x-lock': {
          instanceId: 'x-lock',
          functionalId: 'fn-lock',
          ownerId: DEMO_ME,
          zone: 'active',
          visibleTo: [DEMO_ME],
          faceUp: true,
        },
      },
      players: {
        ...base.players,
        [DEMO_ME]: {
          ...base.players[DEMO_ME]!,
          pokemon: [
            {
              slotId: 'active',
              stack: ['x-mon'],
              attachedEnergy: [],
              attachedTool: lock ? 'x-lock' : null,
              damageCounters: 0,
              conditions: [],
              placedOnTurn: 1,
              evolvedOnTurn: null,
              devolvedOnTurn: null,
              grantedAttacks: [],
              notes: '',
            },
          ],
        },
      },
    };
  };

  it('ロックがなければ何も出ない', () => {
    render(
      <EffectBadges state={board(false)} playerId={DEMO_ME} slotId="active" cardIndex={index} />,
    );
    expect(screen.queryByRole('listitem')).toBeNull();
  });

  it('★ロックがあると「特性×」が出て、止まっている特性名が読める', () => {
    render(
      <EffectBadges state={board(true)} playerId={DEMO_ME} slotId="active" cardIndex={index} />,
    );
    const badge = screen.getByRole('listitem');
    expect(badge.textContent).toBe('特性×');
    expect(badge.getAttribute('title')).toContain('うらこうさく');
  });
});
