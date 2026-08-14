import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DECK_VALIDATION_DATA,
  validateDeck,
  type DeckEntry,
  type DeckValidationCode,
} from './deckValidation';
import type { CardText, Printing } from './types';

const basic: CardText = {
  functionalId: 'basic-pokemon',
  name: 'テストたねポケモン',
  supertype: 'pokemon',
  stage: 'basic',
  hp: 60,
};
const energy: CardText = {
  functionalId: 'basic-energy',
  name: '基本水エネルギー',
  supertype: 'energy',
  isBasicEnergy: true,
};
const modern: Printing = {
  printingId: 'modern',
  functionalId: 'x',
  setCode: 'SV1',
  number: '001',
  rarity: 'C',
  era: 'SV',
};

const card = (name: string, extra: Partial<CardText> = {}): CardText => ({
  functionalId: `fn-${name}`,
  name,
  supertype: 'trainer',
  ...extra,
});

function deckWith(...extras: DeckEntry[]): DeckEntry[] {
  const extraCount = extras.reduce((sum, entry) => sum + entry.count, 0);
  return [
    { card: basic, count: 4, printing: modern },
    { card: energy, count: 56 - extraCount, printing: modern },
    ...extras,
  ];
}

const codesOf = (deck: DeckEntry[]): DeckValidationCode[] =>
  validateDeck(deck).map((result) => result.code);

describe('T20 デッキ構築バリデータ', () => {
  it('条件を満たす60枚デッキはエラーなし', () => {
    expect(validateDeck(deckWith())).toEqual([]);
  });

  it('DECK_SIZE: 60枚でなければエラー', () => {
    expect(codesOf([{ card: basic, count: 4 }, { card: energy, count: 55 }])).toContain(
      'DECK_SIZE',
    );
  });

  it('NO_BASIC_POKEMON: たねポケモンがなければエラー', () => {
    expect(codesOf([{ card: energy, count: 60 }])).toContain('NO_BASIC_POKEMON');
  });

  it('CARD_LIMIT: 基本エネルギー以外の同名カードは4枚まで', () => {
    expect(codesOf(deckWith({ card: card('ハイパーボール'), count: 5 }))).toContain(
      'CARD_LIMIT',
    );
    expect(codesOf([{ card: basic, count: 4 }, { card: energy, count: 56 }])).not.toContain(
      'CARD_LIMIT',
    );
  });

  it('ACE_SPEC_LIMIT: 別名でもデッキ全体で1枚まで', () => {
    const deck = deckWith(
      { card: card('ACE A', { isAceSpec: true }), count: 1 },
      { card: card('ACE B', { isAceSpec: true }), count: 1 },
    );
    expect(codesOf(deck)).toContain('ACE_SPEC_LIMIT');
  });

  it('RADIANT_LIMIT: かがやくポケモンは別名でも全体で1枚まで', () => {
    const deck = deckWith(
      {
        card: card('かがやくA', { supertype: 'pokemon', stage: 'basic', ruleBox: 'RADIANT' }),
        count: 1,
      },
      {
        card: card('かがやくB', { supertype: 'pokemon', stage: 'basic', ruleBox: 'RADIANT' }),
        count: 1,
      },
    );
    expect(codesOf(deck)).toContain('RADIANT_LIMIT');
  });

  it('PRISM_LIMIT: プリズムスターは同名1枚まで', () => {
    const prism = card('プリズムスター', {
      supertype: 'pokemon',
      stage: 'basic',
      ruleBox: 'PRISM',
    });
    expect(codesOf(deckWith({ card: prism, count: 2 }))).toContain('PRISM_LIMIT');
  });

  it('BANNED_CARD: 外部禁止リストのカードを検出する', () => {
    const archeops = card('アーケオス', { supertype: 'pokemon', stage: 'stage1' });
    const bw2: Printing = { ...modern, printingId: 'bw2', setCode: 'BW2', era: 'BW' };
    expect(codesOf(deckWith({ card: archeops, count: 1, printing: bw2 }))).toContain(
      'BANNED_CARD',
    );
    expect(DEFAULT_DECK_VALIDATION_DATA.banned.updatedAt).toBe('2026-02-20');
  });

  it('OUT_OF_FORMAT: BWより前の版は再録利用可でなければエラー', () => {
    const oldCard = card('古いカード');
    const oldPrinting: Printing = {
      ...modern,
      printingId: 'old',
      setCode: 'DP5',
      era: 'pre-BW',
    };
    expect(
      codesOf(deckWith({ card: oldCard, count: 1, printing: oldPrinting })),
    ).toContain('OUT_OF_FORMAT');
    expect(
      codesOf(
        deckWith({
          card: oldCard,
          count: 1,
          printing: { ...oldPrinting, extraLegalReprint: true },
        }),
      ),
    ).not.toContain('OUT_OF_FORMAT');
  });

  it('ALIAS_LIMIT: 博士の研究の別版を合計して4枚制限を判定する', () => {
    const deck = deckWith(
      { card: card('博士の研究（マグノリア博士）'), count: 3 },
      { card: card('博士の研究（ウィロー博士）'), count: 2 },
    );
    expect(codesOf(deck)).toContain('ALIAS_LIMIT');
  });

  it('ALIAS_LIMIT: ボスの指令の別版も合計する', () => {
    const deck = deckWith(
      { card: card('ボスの指令（サカキ）'), count: 2 },
      { card: card('ボスの指令（アカギ）'), count: 3 },
    );
    expect(codesOf(deck)).toContain('ALIAS_LIMIT');
  });

  it('EXCLUSIVE_GROUP: アララギ博士と博士の研究は同居できない', () => {
    const deck = deckWith(
      { card: card('アララギ博士'), count: 1 },
      { card: card('博士の研究（マグノリア博士）'), count: 1 },
    );
    expect(codesOf(deck)).toContain('EXCLUSIVE_GROUP');
  });

  it('EXCLUSIVE_GROUP: フラダリとボスの指令は同居できない', () => {
    const deck = deckWith(
      { card: card('フラダリ'), count: 1 },
      { card: card('ボスの指令（サカキ）'), count: 1 },
    );
    expect(codesOf(deck)).toContain('EXCLUSIVE_GROUP');
  });

  it('全エラーはseverity errorで返る', () => {
    const results = validateDeck([]);
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((result) => result.severity === 'error')).toBe(true);
  });
});
