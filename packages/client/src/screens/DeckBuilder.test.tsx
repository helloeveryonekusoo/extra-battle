import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { saveCardPool } from '../cards/cardPool';
import { sampleCardIndex } from '../cards/sampleCards';
import { listSavedDecks } from '../decks/deckStorage';
import { DeckBuilder } from './DeckBuilder';

describe('デッキ構築UI', () => {
  beforeEach(() => {
    window.localStorage.clear();
    // ★T45: 手元に読み込んだプールから組む
    saveCardPool([{ name: 'test.json', cards: sampleCardIndex.all }]);
    window.location.hash = '#deck';
  });

  it('検索したカードを増減し、検証結果を常時表示する', () => {
    const card = sampleCardIndex.all[0]!;
    render(<DeckBuilder />);

    const catalog = screen.getByLabelText('カードカタログ');
    fireEvent.change(screen.getByLabelText('カード検索'), { target: { value: card.name } });
    fireEvent.click(within(catalog).getByRole('button', { name: `${card.name}を1枚増やす` }));

    expect(screen.getByLabelText(`${card.name}の枚数`).textContent).toBe('1');
    expect(screen.getByLabelText('デッキ検証結果').textContent).toContain('DECK_SIZE');
    expect(screen.getByLabelText('構築中のデッキ').textContent).toContain(card.name);

    fireEvent.click(within(catalog).getByRole('button', { name: `${card.name}を1枚減らす` }));
    expect(screen.getByLabelText(`${card.name}の枚数`).textContent).toBe('0');
  }, 20000);

  /*
   * ★T51: ホイールでの枚数変更は廃止した。
   *   一覧をスクロールしただけで枚数が動いてしまい、気づかないまま壊れることがあった。
   */
  it('★ホイールでは枚数が変わらない', () => {
    const card = sampleCardIndex.all[0]!;
    render(<DeckBuilder />);

    fireEvent.change(screen.getByLabelText('カード検索'), { target: { value: card.name } });
    const count = screen.getByLabelText(`${card.name}の枚数`);
    expect(count.textContent).toBe('0');

    fireEvent.wheel(count.closest('article')!, { deltaY: -100 });
    fireEvent.wheel(count.closest('article')!, { deltaY: 100 });
    expect(count.textContent).toBe('0');
  }, 20000);

  it('★カードの効果がカードの中に出る', () => {
    const withText = sampleCardIndex.all.find(
      (card) => card.supertype === 'trainer' && card.text,
    )!;
    render(<DeckBuilder />);

    fireEvent.change(screen.getByLabelText('カード検索'), { target: { value: withText.name } });
    const catalog = screen.getByLabelText('カードカタログ');
    expect(catalog.textContent).toContain(withText.text);
  }, 20000);

  it('名前と内容を保存し、保存デッキ一覧へ反映する', async () => {
    const card = sampleCardIndex.all[0]!;
    render(<DeckBuilder />);

    fireEvent.change(screen.getByLabelText('デッキ名'), { target: { value: '保存テスト' } });
    fireEvent.click(screen.getByRole('button', { name: `${card.name}を1枚増やす` }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    // ★T47 で保存が非同期になった（置き場がアカウントのこともある）
    await waitFor(() => {
      expect(listSavedDecks()).toMatchObject([
        { name: '保存テスト', cards: [{ functionalId: card.functionalId, count: 1 }] },
      ]);
    });
    await waitFor(() => {
      expect((screen.getByLabelText('保存デッキ') as HTMLSelectElement).value).toBe(
        listSavedDecks()[0]!.id,
      );
    });
    expect(screen.getByLabelText('デッキ検証結果').textContent).toContain('保存しました');
    // ★どこに保存されたかが画面に出る
    expect(screen.getByLabelText('構築中のデッキ').textContent).toContain('この端末');
  }, 20000);
});
