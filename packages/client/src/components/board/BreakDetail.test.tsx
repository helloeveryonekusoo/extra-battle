/**
 * T37 の UI（§4.3）:
 *   - BREAK進化は横向きに重ねて表示し、**下のカードの名前が覗く**
 *   - 継承されているワザ・弱点・にげるが **どちらのカード由来か** を詳細パネルで示す
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  applyActions,
  buildCardIndex,
  createGameState,
  effectiveProfileOf,
  withCards,
  type Action,
  type CardInstance,
  type CardText,
  type GameState,
} from '@pokeca/shared';
import { BreakDetail } from './BreakDetail';
import { CardCompact } from '../card/CardCompact';
import { slotViewOf } from './boardView';

const ME = 'p-1';

const ZOROARK: CardText = {
  functionalId: 'fn-zoroark',
  name: 'ゾロアーク',
  supertype: 'pokemon',
  hp: 120,
  types: ['darkness'],
  stage: 'basic',
  ruleBox: null,
  attacks: [{ name: 'イカサマ', cost: ['darkness'], damage: '0', text: '' }],
  weakness: { type: 'fighting', modifier: '×2' },
  resistance: { type: 'psychic', modifier: '-20' },
  retreatCost: 1,
};

const ZOROARK_BREAK: CardText = {
  functionalId: 'fn-break',
  name: 'ゾロアークBREAK',
  supertype: 'pokemon',
  hp: 190,
  types: ['darkness'],
  stage: 'break',
  evolvesFrom: 'ゾロアーク',
  ruleBox: 'BREAK',
  attacks: [],
  weakness: null,
  resistance: null,
  retreatCost: 4,
};

const index = buildCardIndex([ZOROARK, ZOROARK_BREAK]);

const instance = (instanceId: string, functionalId: string): CardInstance => ({
  instanceId,
  functionalId,
  ownerId: ME,
  zone: 'deck',
  visibleTo: [ME],
  faceUp: false,
});

function board(toBreak: boolean): GameState {
  const base = createGameState({
    gameId: 'g-break-ui',
    rngSeed: 'seed',
    seats: [
      { playerId: ME, displayName: '自分' },
      { playerId: 'p-2', displayName: '相手' },
    ],
  });
  const actions: Action[] = [
    { type: 'placePokemon', playerId: ME, slotId: 'active', cardId: 'base', actorId: ME, at: 1 },
  ];
  if (toBreak) {
    actions.push({
      type: 'evolvePokemon',
      playerId: ME,
      slotId: 'active',
      cardId: 'brk',
      actorId: ME,
      at: 2,
    });
  }
  return applyActions(
    withCards(base, [instance('base', 'fn-zoroark'), instance('brk', 'fn-break')]),
    actions,
    { cards: index },
  );
}

const profileOf = (toBreak: boolean) => effectiveProfileOf(board(toBreak), ME, 'active', { cards: index });

describe('★BREAK進化の内訳（§4.3）', () => {
  it('BREAKでなければ何も出さない', () => {
    const { container } = render(<BreakDetail profile={profileOf(false)} />);
    expect(container.firstChild).toBeNull();
  });

  it('どちらのカードに重なっているかを出す', () => {
    render(<BreakDetail profile={profileOf(true)} />);
    const panel = screen.getByLabelText('BREAK進化の内訳');
    expect(panel.textContent).toContain('ゾロアークBREAK');
    expect(panel.textContent).toContain('ゾロアーク');
    expect(panel.textContent).toContain('重ねている');
  });

  it('★引きつぐものは「進化前のカード名」が由来として出る', () => {
    render(<BreakDetail profile={profileOf(true)} />);
    const rows = within(screen.getByLabelText('BREAK進化の内訳')).getAllByRole('listitem');
    const row = (label: string) => rows.find((li) => li.textContent?.startsWith(label));

    expect(row('ワザ')?.textContent).toContain('イカサマ');
    expect(row('ワザ')?.textContent).toContain('ゾロアーク');
    expect(row('弱点')?.textContent).toContain('闘 ×2');
    expect(row('抵抗力')?.textContent).toContain('超 -20');
    expect(row('にげる')?.textContent).toContain('1');
  });

  it('★BREAK側を使うものは「BREAK側のカード名」が由来として出る', () => {
    render(<BreakDetail profile={profileOf(true)} />);
    const rows = within(screen.getByLabelText('BREAK進化の内訳')).getAllByRole('listitem');
    const hp = rows.find((li) => li.textContent?.startsWith('HP'));
    expect(hp?.textContent).toContain('190');
    expect(hp?.textContent).toContain('ゾロアークBREAK');
  });
});

describe('★BREAKは横向きに重ねて表示する（§4.3）', () => {
  it('下のカードの名前が覗く', () => {
    const view = slotViewOf(board(true), index, ME, 'active');
    expect(view.breakUnder).toBe('ゾロアーク');

    render(
      <CardCompact
        card={view.top?.card}
        breakUnder={view.breakUnder}
        stackSize={view.stackSize}
      />,
    );
    // 上に乗るBREAK側と、下から覗く進化前の両方が読める
    expect(screen.getByText('ゾロアークBREAK')).toBeTruthy();
    expect(screen.getByText('ゾロアーク')).toBeTruthy();
    expect(screen.getByText('ワザ・弱点・にげるはこちら')).toBeTruthy();
    expect(screen.getByText('BREAK（2枚）')).toBeTruthy();
  });

  it('BREAKでなければ帯を出さない', () => {
    const view = slotViewOf(board(false), index, ME, 'active');
    expect(view.breakUnder).toBeNull();
    render(<CardCompact card={view.top?.card} breakUnder={view.breakUnder} />);
    expect(screen.queryByText('ワザ・弱点・にげるはこちら')).toBeNull();
  });
});
