import { describe, expect, it } from 'vitest';
import { ENERGY_TYPES } from '@pokeca/shared';
import { loadCardIndex, loadCardTexts } from './cardStore';

const cards = loadCardTexts();
const index = loadCardIndex();

describe('sample.json のローダー', () => {
  it('40枚程度のサンプルを読み込める', () => {
    expect(cards.length).toBeGreaterThanOrEqual(38);
  });

  it('functionalId がすべて一意', () => {
    expect(new Set(cards.map((c) => c.functionalId)).size).toBe(cards.length);
  });

  it('全11タイプのポケモンが揃っている（T7 の見本用）', () => {
    const covered = new Set(cards.flatMap((c) => c.types ?? []));
    for (const t of ENERGY_TYPES) {
      expect(covered.has(t), `${t} タイプのポケモンがない`).toBe(true);
    }
  });

  it('基本エネルギーが9種ある', () => {
    const basics = cards.filter((c) => c.supertype === 'energy' && c.isBasicEnergy === true);
    expect(basics).toHaveLength(9);
  });

  it('グッズ・どうぐ・サポート・スタジアムが揃っている', () => {
    const count = (kind: string) =>
      cards.filter((c) => c.supertype === 'trainer' && c.trainerKind === kind).length;
    expect(count('item')).toBeGreaterThanOrEqual(5);
    expect(count('tool')).toBeGreaterThanOrEqual(2);
    expect(count('supporter')).toBeGreaterThanOrEqual(5);
    // T33 でスタジアムが増えるので、下限だけを見る
    expect(count('stadium')).toBeGreaterThanOrEqual(2);
  });

  it('1進化・2進化ラインが2組つながっている', () => {
    /*
     * ★T42 以降、進化元をデータに持たない2進化カード（ラフレシア等のロック系）が入る。
     *   ここで見たいのは「見本デッキの進化ラインがつながっていること」なので、
     *   進化元がデータにあるものだけを対象にする。
     */
    const stage2 = cards.filter(
      (c) => c.stage === 'stage2' && index.byName.has(c.evolvesFrom ?? ''),
    );
    expect(stage2.length).toBeGreaterThanOrEqual(2);
    for (const s2 of stage2) {
      const s1 = index.byName.get(s2.evolvesFrom ?? '')?.[0];
      expect(s1?.stage, `${s2.name} の1進化元が見つからない`).toBe('stage1');
      const basic = index.byName.get(s1?.evolvesFrom ?? '')?.[0];
      expect(basic?.stage, `${s1?.name} のたねが見つからない`).toBe('basic');
    }
  });

  it('ACE SPEC と古代能力とポケパワー/ポケボディーの見本を含む', () => {
    expect(cards.some((c) => c.isAceSpec === true)).toBe(true);
    const kinds = new Set(cards.flatMap((c) => c.abilities ?? []).map((a) => a.kind));
    expect(kinds.has('ability')).toBe(true);
    expect(kinds.has('ancientTrait')).toBe(true);
    expect(kinds.has('pokeBody')).toBe(true);
    expect(kinds.has('pokePower')).toBe(true);
  });

  it('damage は原文のまま文字列で保持している', () => {
    const damages = cards.flatMap((c) => c.attacks ?? []).map((a) => a.damage);
    expect(damages).toContain('120+');
    expect(damages).toContain('30×');
  });

  it('画像URL・フレーバーテキストを一切持たない（絶対制約）', () => {
    const json = JSON.stringify(cards);
    expect(json).not.toMatch(/https?:\/\//);
    expect(json).not.toMatch(/"(image|imageUrl|flavorText)"/);
  });
});
