/**
 * T36 の完了条件のうち UI 側:
 *   「GXワザとVSTARパワーが対戦中1回に制限され、UIに使用済みが表示される」
 *
 * ★枠は **プレイヤー単位** なので、ポケモンのバッジではなく HUD に出す。
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createGameState, type GameState, type OncePerGameKind } from '@pokeca/shared';
import { OncePerGameChips, PlayerHud } from './PlayerHud';

const ME = 'p-1';

function state(used: OncePerGameKind[] = []): GameState {
  const base = createGameState({
    gameId: 'g-hud',
    rngSeed: 'seed',
    seats: [
      { playerId: ME, displayName: '自分' },
      { playerId: 'p-2', displayName: '相手' },
    ],
  });
  base.players[ME]!.oncePerGameUsed = used;
  return base;
}

describe('★対戦中1回の表示（T36）', () => {
  it('使っていなければ両方とも点灯し、「まだ使える」と読める', () => {
    render(<OncePerGameChips used={[]} />);
    expect(screen.getByRole('button', { name: 'GX' }).title).toContain('まだ使える');
    expect(screen.getByRole('button', { name: 'VSTAR' }).title).toContain('まだ使える');
  });

  it('★使い切ったら「使用済み」が出る', () => {
    render(<OncePerGameChips used={['gx']} />);
    const gx = screen.getByRole('button', { name: /GX/ });
    expect(gx.textContent).toContain('使用済み');
    expect(gx.title).toContain('この対戦で使用済み');
    // VSTAR はまだ残っている
    expect(screen.getByRole('button', { name: 'VSTAR' }).textContent).not.toContain('使用済み');
  });

  it('★プレイヤー単位であることが読める', () => {
    render(<OncePerGameChips used={['vstar']} />);
    expect(screen.getByRole('button', { name: /VSTAR/ }).title).toContain('プレイヤーごとに1回');
  });

  it('押すと手で戻せる（効果で例外的にもう1回使えるカードのため）', () => {
    const onToggle = vi.fn();
    render(<OncePerGameChips used={['gx']} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole('button', { name: /GX/ }));
    expect(onToggle).toHaveBeenCalledWith('gx', false);
  });

  it('操作できない盤面ではボタンが無効になる', () => {
    render(<OncePerGameChips used={[]} />);
    expect((screen.getByRole('button', { name: 'GX' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('★HUD に出る（ポケモンではなくプレイヤーの情報として置く）', () => {
    render(<PlayerHud state={state(['gx'])} playerId={ME} />);
    expect(screen.getByRole('button', { name: /GX/ }).textContent).toContain('使用済み');
  });
});
