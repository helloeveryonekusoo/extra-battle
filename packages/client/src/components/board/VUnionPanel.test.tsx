/**
 * T38 の完了条件（UI側）:
 *   「トラッシュに4種揃うと組み立てUIが出て、ベンチに出せる」
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  applyActions,
  buildCardIndex,
  createGameState,
  withCards,
  type Action,
  type CardInstance,
  type CardText,
  type GameState,
} from '@pokeca/shared';
import { VUnionPanel } from './VUnionPanel';

const ME = 'p-1';

const part = (n: number, over: Partial<CardText> = {}): CardText => ({
  functionalId: `fn-vu-${n}`,
  name: 'ミュウツーV-UNION',
  supertype: 'pokemon',
  hp: 320,
  types: ['psychic'],
  stage: 'vunion',
  ruleBox: 'VUNION',
  vUnionPart: n,
  attacks: [],
  weakness: null,
  resistance: null,
  retreatCost: 2,
  ...over,
});

const PARTS = [part(1), part(2), part(3), part(4)];

const PLAIN: CardText = {
  functionalId: 'fn-plain',
  name: 'ゼニガメ',
  supertype: 'pokemon',
  hp: 70,
  types: ['water'],
  stage: 'basic',
  ruleBox: null,
  attacks: [],
  weakness: null,
  resistance: null,
  retreatCost: 1,
};

const index = buildCardIndex([...PARTS, PLAIN]);

const instance = (instanceId: string, functionalId: string): CardInstance => ({
  instanceId,
  functionalId,
  ownerId: ME,
  zone: 'deck',
  visibleTo: [ME],
  faceUp: false,
});

/** `inDiscard` の番号だけトラッシュに置いた盤面 */
function board(inDiscard: readonly number[], fillBench = false): GameState {
  const base = createGameState({
    gameId: 'g-vunion-ui',
    rngSeed: 'seed',
    seats: [
      { playerId: ME, displayName: '自分' },
      { playerId: 'p-2', displayName: '相手' },
    ],
  });
  const cards = [
    ...PARTS.map((p, i) => instance(`vu-${i + 1}`, p.functionalId)),
    ...Array.from({ length: 8 }, (_, i) => instance(`plain-${i}`, 'fn-plain')),
  ];
  const actions: Action[] = inDiscard.map((n) => ({
    type: 'moveCard' as const,
    cardId: `vu-${n}`,
    toZone: 'discard' as const,
    actorId: ME,
    at: n,
  }));
  if (fillBench) {
    // ベンチ上限ぶん埋める
    for (let i = 0; i < 5; i += 1) {
      actions.push({
        type: 'placePokemon',
        playerId: ME,
        slotId: `bench-${i}`,
        cardId: `plain-${i}`,
        actorId: ME,
        at: 100 + i,
      });
    }
  }
  return applyActions(withCards(base, cards), actions, { cards: index });
}

const renderPanel = (state: GameState, dispatch = vi.fn()) => {
  render(<VUnionPanel state={state} playerId={ME} cardIndex={index} dispatch={dispatch} />);
  return dispatch;
};

describe('★V-UNION の組み立てUI（T38）', () => {
  it('トラッシュに V-UNION がなければ何も出さない', () => {
    const { container } = render(
      <VUnionPanel state={board([])} playerId={ME} cardIndex={index} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('★何番がそろっていて、何番が足りないかを出す', () => {
    renderPanel(board([1, 3]));
    const panel = screen.getByLabelText('V-UNIONの組み立て');
    expect(within(panel).getByText('2 / 4')).toBeTruthy();
    expect(panel.textContent).toContain('2・4枚目');
    // ★どこにあるかは断定しない
    expect(panel.textContent).toContain('山札かサイド');
  });

  it('★4種そろうと理由が消え、ベンチに出せる', () => {
    const dispatch = renderPanel(board([1, 2, 3, 4]));
    const panel = screen.getByLabelText('V-UNIONの組み立て');
    expect(within(panel).getByText('4 / 4')).toBeTruthy();
    expect(panel.textContent).not.toContain('枚目がトラッシュにありません');

    fireEvent.click(screen.getByRole('button', { name: /ベンチに出す/ }));
    expect(dispatch).toHaveBeenCalledWith({
      type: 'assembleVUnion',
      playerId: ME,
      slotId: 'bench-0',
      // ★1枚目から4枚目の順に積む
      cardIds: ['vu-1', 'vu-2', 'vu-3', 'vu-4'],
    });
  });

  it('★そろっていなくてもボタンは消さない（警告はするが禁止はしない）', () => {
    const dispatch = renderPanel(board([1, 2]));
    const button = screen.getByRole('button', { name: /ベンチに出す/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'assembleVUnion', cardIds: ['vu-1', 'vu-2'] }),
    );
  });

  it('ベンチが満杯なら出せないと伝える', () => {
    renderPanel(board([1, 2, 3, 4], true));
    const button = screen.getByRole('button', { name: /ベンチに空きがありません/ });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('読み取り専用の盤面ではボタンが押せない', () => {
    render(<VUnionPanel state={board([1, 2, 3, 4])} playerId={ME} cardIndex={index} />);
    expect((screen.getByRole('button', { name: /ベンチに出す/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
