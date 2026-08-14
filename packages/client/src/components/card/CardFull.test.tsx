import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { CardText } from '@pokeca/shared';
import { CardFull } from './CardFull';
import { rotationFor } from './CardCompact';
import { sampleCardIndex } from '../../cards/sampleCards';

const kamex = sampleCardIndex.byName.get('カメックス')![0]!;
const yamikarasu = sampleCardIndex.byName.get('ヤミカラス')![0]!;
const lizardon = sampleCardIndex.byName.get('リザードンex')![0]!;
const aceSpec = sampleCardIndex.all.find((c) => c.isAceSpec)!;

describe('CardFull', () => {
  it('名前・HP・進化元を出す', () => {
    render(<CardFull card={kamex} />);
    expect(screen.getByRole('heading', { name: 'カメックス' })).toBeTruthy();
    expect(screen.getByText('180')).toBeTruthy();
    expect(screen.getByText('2進化 ← カメール')).toBeTruthy();
  });

  it('ダメージを原文のまま出す（数値化しない）', () => {
    render(<CardFull card={kamex} />);
    expect(screen.getByText('120+')).toBeTruthy();
    expect(screen.getByText('30×')).toBeTruthy();
  });

  it('エネルギーコストを文字ではなく円で出す', () => {
    const { container } = render(<CardFull card={kamex} />);
    // ハイドロカノンは 水・水・無 の3個
    const pips = container.querySelectorAll('[role="img"]');
    expect(pips.length).toBeGreaterThanOrEqual(3);
    // コストが "水水無" のような文字列で出ていない
    expect(container.textContent).not.toContain('水水');
  });

  it('特性の種別を書き分ける', () => {
    render(<CardFull card={yamikarasu} />);
    expect(screen.getByText('ポケパワー')).toBeTruthy();
    expect(screen.getByText('ポケボディー')).toBeTruthy();

    render(<CardFull card={sampleCardIndex.byName.get('リザード')![0]!} />);
    expect(screen.getByText('古代能力')).toBeTruthy();
  });

  it('ルールボックスをバッジで出す', () => {
    render(<CardFull card={lizardon} />);
    expect(screen.getByText('ex')).toBeTruthy();
  });

  it('ACE SPEC をバッジで示す', () => {
    render(<CardFull card={aceSpec} />);
    expect(screen.getByText('ACE SPEC')).toBeTruthy();
  });

  it('manual opを含むカードはASSISTEDと表示する', () => {
    render(<CardFull card={{ ...kamex, effects: [{ op: 'manual', prompt: '手で処理する' }] }} />);
    expect(screen.getByText('ASSISTED')).toBeTruthy();
  });

  it('弱点・抵抗・にげるを出す', () => {
    render(<CardFull card={kamex} />);
    expect(screen.getByText('弱点')).toBeTruthy();
    expect(screen.getByText('抵抗')).toBeTruthy();
    expect(screen.getByText('にげる')).toBeTruthy();
    expect(screen.getByText('×2')).toBeTruthy();
  });

  it('見えないカードは中身を出さない', () => {
    const { container } = render(<CardFull card={undefined} faceDown />);
    expect(container.textContent).toBe('非公開');
  });

  it('デュアルタイプでも壊れない', () => {
    const dual: CardText = { ...kamex, types: ['water', 'fighting'] };
    render(<CardFull card={dual} />);
    expect(screen.getByText('水・闘')).toBeTruthy();
  });

  it('★画像を一切使わない（絶対制約）', () => {
    for (const card of sampleCardIndex.all) {
      const { container, unmount } = render(<CardFull card={card} />);
      expect(container.querySelector('img')).toBeNull();
      expect(container.innerHTML).not.toMatch(/https?:\/\//);
      expect(container.innerHTML).not.toMatch(/background-image|url\(/);
      unmount();
    }
  });
});

describe('特殊状態の回転（§6.4）', () => {
  it('ねむり・マヒは90°', () => {
    expect(rotationFor(['asleep'])).toBe(90);
    expect(rotationFor(['paralyzed'])).toBe(90);
  });

  it('こんらんは180°', () => {
    expect(rotationFor(['confused'])).toBe(180);
  });

  it('どく・やけどでは回転しない', () => {
    expect(rotationFor(['poisoned'])).toBe(0);
    expect(rotationFor(['burned'])).toBe(0);
  });

  it('ねむり + こんらんは270°（実物と同じ）', () => {
    expect(rotationFor(['asleep', 'confused'])).toBe(270);
  });

  it('状態なしは0°', () => {
    expect(rotationFor([])).toBe(0);
  });
});
