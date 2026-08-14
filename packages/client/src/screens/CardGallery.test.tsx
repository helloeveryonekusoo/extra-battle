/**
 * T7 の完了条件そのもの:
 * 「全タイプ・全ルールボックス・特殊状態つきの見本が並ぶ」ことを確かめる。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { CardGallery } from './CardGallery';
import { TYPE_LABEL } from '../components/card/cardVisuals';
import { saveCardPool } from '../cards/cardPool';
import { sampleCardIndex } from '../cards/sampleCards';

describe('カード見本ページ', () => {
  // ★T45: カードデータは同梱しないので、見本もプールから引く
  beforeEach(() => {
    window.localStorage.clear();
    saveCardPool([{ name: 'test.json', cards: sampleCardIndex.all }]);
  });

  it('全11タイプの見本が並ぶ', () => {
    render(<CardGallery />);
    const section = screen.getByRole('heading', { name: '全11タイプ' }).closest('section')!;
    for (const label of Object.values(TYPE_LABEL)) {
      expect(within(section).getAllByText(label).length, `${label} の見本がない`).toBeGreaterThan(0);
    }
  });

  it('全12種のルールボックスの見本が並ぶ', () => {
    render(<CardGallery />);
    const section = screen.getByRole('heading', { name: '全ルールボックス' }).closest('section')!;
    // セクション見出し（h2）を除いた、カード名（h3）だけを数える
    const captions = within(section)
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent);
    expect(captions).toHaveLength(12);
    expect(captions).toContain('見本 VSTAR');
    expect(captions).toContain('見本 かがやく');
    expect(captions).toContain('見本 TAG TEAM');
  });

  it('特殊状態つきの見本が並ぶ', () => {
    render(<CardGallery />);
    const section = screen.getByRole('heading', { name: '特殊状態' }).closest('section')!;
    expect(within(section).getByText('ねむり → 90°')).toBeTruthy();
    expect(within(section).getByText('こんらん → 180°')).toBeTruthy();
    expect(within(section).getByText('どく → 紫に脈動')).toBeTruthy();
    expect(within(section).getByText('やけど → 橙に脈動')).toBeTruthy();
    expect(within(section).getByText('ねむり + こんらん → 270°')).toBeTruthy();
  });

  it('ACE SPEC・トレーナーズ・エネルギー・伏せカードの見本がある', () => {
    render(<CardGallery />);
    expect(screen.getByRole('heading', { name: 'ACE SPEC' })).toBeTruthy();
    // グッズは通常のグッズと ACE SPEC の2枚が並ぶ
    expect(screen.getAllByText('グッズ').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('ポケモンのどうぐ')).toBeTruthy();
    expect(screen.getByText('サポート')).toBeTruthy();
    expect(screen.getByText('スタジアム')).toBeTruthy();
    expect(screen.getAllByText('基本エネルギー').length).toBeGreaterThan(0);
    expect(screen.getAllByText('非公開').length).toBeGreaterThan(0);
  });

  it('★ページ全体で画像を1枚も使っていない（絶対制約）', () => {
    const { container } = render(<CardGallery />);
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(container.innerHTML).not.toMatch(/https?:\/\//);
    expect(container.innerHTML).not.toMatch(/url\(/);
  });
});
