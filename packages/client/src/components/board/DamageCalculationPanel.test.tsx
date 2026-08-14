import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  buildCardIndex,
  createGameState,
  effectSlotKey,
  type ActiveEffect,
  type CardInstance,
  type CardText,
  type PokemonInPlay,
} from '@pokeca/shared';
import { DamageCalculationPanel } from './DamageCalculationPanel';

const cards: CardText[] = [
  {
    functionalId: 'attacker',
    name: 'デュアルアタッカー',
    supertype: 'pokemon',
    hp: 100,
    types: ['fire', 'water'],
    attacks: [{ name: 'テストアタック', cost: [], damage: '100+', text: '' }],
  },
  {
    functionalId: 'defender',
    name: 'ディフェンダー',
    supertype: 'pokemon',
    hp: 200,
    types: ['colorless'],
    weakness: { type: 'water', modifier: '×2' },
    resistance: { type: 'fire', modifier: '-20' },
    attacks: [],
  },
];

const slot = (slotId: PokemonInPlay['slotId'], id: string): PokemonInPlay => ({
  slotId,
  stack: [id],
  attachedEnergy: [],
  attachedTool: null,
  damageCounters: 0,
  conditions: [],
  placedOnTurn: 0,
  evolvedOnTurn: null,
  devolvedOnTurn: null,
  grantedAttacks: [],
  notes: '',
});

function fixture(effects: ActiveEffect[] = []) {
  const state = createGameState({
    gameId: 'damage-panel',
    rngSeed: 'seed',
    seats: [
      { playerId: 'me', displayName: '自分' },
      { playerId: 'opponent', displayName: '相手' },
    ],
  });
  state.setup = null;
  state.phase = 'turn';
  state.effects = effects;
  state.players.me!.pokemon = [slot('active', 'attacker-card')];
  state.players.opponent!.pokemon = [
    slot('active', 'defender-active'),
    slot('bench-0', 'defender-bench'),
  ];
  const instance = (instanceId: string, functionalId: string, ownerId: string): CardInstance => ({
    instanceId,
    functionalId,
    ownerId,
    zone: 'active',
    visibleTo: ['me', 'opponent'],
    faceUp: true,
  });
  state.cards = {
    'attacker-card': instance('attacker-card', 'attacker', 'me'),
    'defender-active': instance('defender-active', 'defender', 'opponent'),
    'defender-bench': { ...instance('defender-bench', 'defender', 'opponent'), zone: 'bench' },
  };
  return { state, cardIndex: buildCardIndex(cards) };
}

const renderPanel = (effects: ActiveEffect[] = []) => {
  const { state, cardIndex } = fixture(effects);
  const dispatch = vi.fn();
  render(
    <DamageCalculationPanel
      state={state}
      viewerId="me"
      cardIndex={cardIndex}
      dispatch={dispatch}
      onClose={vi.fn()}
    />,
  );
  return { dispatch };
};

/** 6段の表を「段名 / 内訳 / 値」で読み出す */
const breakdown = (): string[][] =>
  within(screen.getByLabelText('ダメージ計算の内訳'))
    .getAllByRole('listitem')
    .map((li) => [...li.querySelectorAll('span')].slice(1).map((sp) => sp.textContent ?? ''));

const total = () => screen.getByText('最終ダメージ').parentElement?.textContent ?? '';

describe('T19 ダメージ計算パネル', () => {
  it('基礎値を人が確定し、弱点・抵抗力・手動調整を反映して適用する', () => {
    const { dispatch } = renderPanel();

    expect(screen.getByText('100+')).toBeTruthy();
    expect((screen.getByLabelText('基礎ダメージ') as HTMLInputElement).value).toBe('100');
    expect(
      (screen.getByRole('button', { name: '確定してダメカンをのせる' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'この値で確定' }));
    expect(total()).toContain('180');

    fireEvent.change(screen.getByLabelText('手動調整'), { target: { value: '30' } });
    expect(total()).toContain('210');

    fireEvent.click(screen.getByRole('checkbox', { name: '弱点を使う' }));
    expect(total()).toContain('110');
    fireEvent.click(screen.getByRole('checkbox', { name: '弱点を使う' }));
    fireEvent.click(screen.getByRole('button', { name: '確定してダメカンをのせる' }));

    expect(dispatch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ type: 'useAttack', attackName: 'テストアタック' }),
    );
    expect(dispatch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: 'applyDamageCalculation',
        expectedTopInstanceId: 'defender-active',
        baseDamage: 100,
        weaknessApplied: true,
        resistanceApplied: true,
        manualAdjustment: 30,
        finalDamage: 210,
        damageCounters: 21,
      }),
    );
  });

  it('ベンチ対象は既定で弱点・抵抗力を外し、チェック時だけ適用する', () => {
    renderPanel();
    fireEvent.change(screen.getByLabelText('対象'), { target: { value: 'opponent/bench-0' } });
    fireEvent.click(screen.getByRole('button', { name: 'この値で確定' }));
    expect(total()).toContain('100');

    fireEvent.click(screen.getByRole('checkbox', { name: /ベンチにも弱点・抵抗力を適用する/ }));
    expect(total()).toContain('180');
  });
});

// ── §5.3 6段表示（T28） ──

describe('★ダメージ計算の6段表示（§5.3）', () => {
  it('6段すべてを、段の名前と内訳と値つきで並べる', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'この値で確定' }));

    expect(breakdown()).toEqual([
      ['基本ダメージ', '100', '100'],
      ['与える側の効果', '—', '—'],
      ['弱点 water', '×2', '200'],
      ['抵抗力 fire', '−20', '180'],
      ['受ける側の効果', '—', '—'],
      ['確定', '180', '180'],
    ]);
    expect(total()).toContain('ダメカン 18個');
  });

  it('★どこで何が起きたか追える（かかっている効果の名前が段に出る）', () => {
    const effect = (over: Partial<ActiveEffect>): ActiveEffect => ({
      effectId: 'e',
      source: { instanceId: null, playerId: 'me', label: 'テスト' },
      target: { slotId: effectSlotKey('me', 'active') },
      applyAt: 'step2',
      kind: 'damageModifier',
      payload: { delta: 30, label: '与えるダメージ +30' },
      duration: { type: 'thisTurn' },
      expiresOn: [],
      createdOnTurn: 1,
      ...over,
    });

    renderPanel([
      effect({ effectId: 'e1' }),
      effect({
        effectId: 'e2',
        applyAt: 'step5',
        target: { slotId: effectSlotKey('opponent', 'active') },
        payload: { delta: -50, label: '受けるワザのダメージ −50' },
      }),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'この値で確定' }));

    const rows = breakdown();
    // ★与える側は Step2、受ける側は Step5 に入る（段が入れ替わらない）
    expect(rows[1]?.[0]).toContain('与える側の効果');
    expect(rows[1]?.[0]).toContain('与えるダメージ +30');
    expect(rows[1]?.[2]).toBe('130');
    expect(rows[2]?.[2]).toBe('260'); // 弱点 ×2
    expect(rows[3]?.[2]).toBe('240'); // 抵抗力 −20
    expect(rows[4]?.[0]).toContain('受けるワザのダメージ −50');
    expect(rows[4]?.[2]).toBe('190');
    expect(total()).toContain('190');
  });

  it('★「かかっている効果を計算しない」にすると Step5 がとぶ', () => {
    renderPanel([
      {
        effectId: 'e2',
        source: { instanceId: null, playerId: 'me', label: 'テスト' },
        target: { slotId: effectSlotKey('opponent', 'active') },
        applyAt: 'step5',
        kind: 'damageModifier',
        payload: { delta: -50, label: '受けるワザのダメージ −50' },
        duration: { type: 'thisTurn' },
        expiresOn: [],
        createdOnTurn: 1,
      },
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'この値で確定' }));
    expect(total()).toContain('130');

    fireEvent.click(screen.getByRole('checkbox', { name: /かかっている効果を計算しない/ }));
    expect(breakdown()[4]?.[1]).toBe('計算しない');
    expect(total()).toContain('180');
  });

  it('★「弱点・抵抗力を計算しない」にすると Step3,4 がとぶ', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'この値で確定' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /弱点・抵抗力を計算しない/ }));

    const rows = breakdown();
    expect(rows[2]?.[1]).toBe('計算しない');
    expect(rows[3]?.[1]).toBe('計算しない');
    expect(total()).toContain('100');
  });

  it('★0以下で打ち切られたことが分かる', () => {
    renderPanel();
    fireEvent.change(screen.getByLabelText('基礎ダメージ'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'この値で確定' }));

    expect(screen.getByText(/Step1 で0以下になったので/)).toBeTruthy();
    expect(breakdown()[1]?.[1]).toBe('（0以下で打ち切り）');
  });
});
