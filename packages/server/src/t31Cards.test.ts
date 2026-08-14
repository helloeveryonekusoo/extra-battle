/** T31: each requested card has an initial-state -> apply -> expected-state golden case. */
import { describe, expect, it } from 'vitest';
import { cardsInZone, type CardText, type Zone } from '@pokeca/shared';
import { Room } from './room';
import { loadCardTexts } from './cardStore';

const pool = loadCardTexts();
const names = [
  'クイックボール', 'ハイパーボール', 'ネストボール', 'レベルボール',
  'しんかのおこう', 'ミステリートレジャー', '霧の水晶', 'ダイブボール',
  'ネットボール', 'プレシャスボール', 'バトルVIPパス', 'トレーナーズポスト',
  'ぼうけんのカバン', 'はかせのてがみ', '火打石', 'ふしぎなアメ',
  'N', '博士の研究', 'シロナ', 'アクロマ', 'ジャッジマン', 'ナンジャモ',
  'マリィ', 'ヒガナ', 'ミツル', 'セイジ', 'アセロラ', 'グズマ&ハラ',
  'タッグコール', 'カリン',
] as const;

const card = (name: string): CardText => {
  const found = pool.find((entry) => entry.name === name);
  if (!found) throw new Error(`${name} is missing`);
  return found;
};

const deck = (cards: readonly CardText[]) => ({
  name: 'golden',
  cards: cards.map((entry) => ({ functionalId: entry.functionalId, count: 1 })),
});

function setup(sourceName: string, extra: readonly CardText[] = []) {
  const source = card(sourceName);
  const filler = pool.filter((entry) => !entry.effects).slice(0, 20);
  const room = new Room({ code: 'T31GLD', rngSeed: `gold-${sourceName}`, cardPool: pool });
  const alice = room.join('Alice', undefined, deck([source, ...extra, ...filler])).playerId;
  const bob = room.join('Bob', undefined, deck(filler)).playerId;
  room.submitAction(alice, { type: 'setPhase', phase: 'turn' });
  const sourceInstance = Object.values(room.rawState.cards).find(
    (instance) => instance.ownerId === alice && instance.functionalId === source.functionalId,
  )!;
  room.submitAction(alice, { type: 'moveCard', cardId: sourceInstance.instanceId, toZone: 'hand' });
  return { room, alice, bob, source: sourceInstance };
}

function answer(room: Room, player: string, count?: number) {
  const choice = room.rawState.execution?.pendingChoice;
  if (!choice) return;
  const wanted = count ?? choice.max;
  const allowed = choice.allowedCounts
    ? [...choice.allowedCounts].sort((a, b) => b - a).find((value) => value <= choice.candidates.length) ?? 0
    : wanted;
  const selected = choice.candidates.slice(0, allowed);
  room.submitIntent(player, { type: 'resolveChoice', requestId: choice.requestId, selected });
}

function finish(room: Room, alice: string, bob: string, optionalCost = true) {
  for (let i = 0; i < 20 && room.rawState.execution; i += 1) {
    const choice = room.rawState.execution.pendingChoice;
    if (!choice) break;
    const chooser = choice.chooser === bob ? bob : alice;
    const count = choice.allowedCounts ? (optionalCost ? Math.max(...choice.allowedCounts) : 0) : undefined;
    answer(room, chooser, count);
  }
}

const count = (room: Room, player: string, zone: Zone) => cardsInZone(room.rawState, player, zone).length;

describe('T31 definitions', () => {
  it('contains exactly all 30 requested cards as AUTO effects', () => {
    expect(names).toHaveLength(30);
    for (const name of names) expect(card(name).effects, name).toBeTruthy();
  });
});

describe('T31 search item golden cases', () => {
  const cases: readonly [string, string, number, CardText[]][] = [
    ['クイックボール', 'hand', 1, [pool.find((c) => c.stage === 'basic')!]],
    ['ハイパーボール', 'hand', 2, [pool.find((c) => c.stage === 'stage1')!]],
    ['ネストボール', 'bench', 0, [pool.find((c) => c.stage === 'basic')!]],
    ['レベルボール', 'hand', 0, [pool.find((c) => c.stage === 'basic' && (c.hp ?? 999) <= 90)!]],
    ['しんかのおこう', 'hand', 0, [pool.find((c) => c.stage === 'stage1')!]],
    ['ミステリートレジャー', 'hand', 1, [pool.find((c) => c.types?.includes('psychic'))!]],
    ['霧の水晶', 'hand', 0, [pool.find((c) => c.isBasicEnergy && c.energyProvides?.includes('psychic'))!]],
    ['ダイブボール', 'hand', 0, [pool.find((c) => c.types?.includes('water'))!]],
    ['ネットボール', 'hand', 0, [pool.find((c) => c.isBasicEnergy && c.energyProvides?.includes('grass'))!]],
    ['ぼうけんのカバン', 'hand', 0, [pool.find((c) => c.trainerKind === 'tool')!]],
    ['はかせのてがみ', 'hand', 0, [pool.find((c) => c.isBasicEnergy)!]],
    ['火打石', 'hand', 2, [pool.find((c) => c.isBasicEnergy && c.energyProvides?.includes('fire'))!]],
  ];
  it.each(cases)('%s: initial -> apply -> expected', (name, destination, cost, targets) => {
    const { room, alice, bob, source } = setup(name, [...targets, ...pool.filter((c) => !c.effects).slice(0, cost + 2)]);
    const before = destination === 'bench' ? room.rawState.players[alice]!.pokemon.length : count(room, alice, 'hand');
    room.submitIntent(alice, { type: 'useCardEffect', instanceId: source.instanceId });
    finish(room, alice, bob);
    if (destination === 'bench') expect(room.rawState.players[alice]!.pokemon.length).toBe(before + 1);
    else expect(count(room, alice, 'hand')).toBeGreaterThanOrEqual(before - cost);
    expect(room.rawState.execution).toBeNull();
  });

  it('プレシャスボール: GX is offered and moved to hand', () => {
    const gx: CardText = { ...pool.find((c) => c.stage === 'basic')!, functionalId: 'gold-gx', name: 'テストGX', ruleBox: 'GX' };
    const room = new Room({ code: 'GOLDGX', rngSeed: 'gx', cardPool: [...pool, gx] });
    const source = card('プレシャスボール');
    const alice = room.join('Alice', undefined, deck([source, gx])).playerId;
    const bob = room.join('Bob').playerId;
    room.submitAction(alice, { type: 'setPhase', phase: 'turn' });
    const sourceId = Object.values(room.rawState.cards).find((c) => c.functionalId === source.functionalId)!.instanceId;
    room.submitAction(alice, { type: 'moveCard', cardId: sourceId, toZone: 'hand' });
    room.submitIntent(alice, { type: 'useCardEffect', instanceId: sourceId });
    finish(room, alice, bob);
    expect(cardsInZone(room.rawState, alice, 'hand').some((c) => c.functionalId === gx.functionalId)).toBe(true);
  });

  it('バトルVIPパス: first own turn puts up to two basics on bench', () => {
    const basics = pool.filter((c) => c.stage === 'basic').slice(0, 2);
    const { room, alice, bob, source } = setup('バトルVIPパス', basics);
    room.rawState.turnHistory.push({ turn: 1, playerId: alice, isExtra: false });
    room.submitIntent(alice, { type: 'useCardEffect', instanceId: source.instanceId });
    finish(room, alice, bob);
    expect(room.rawState.players[alice]!.pokemon).toHaveLength(2);
  });

  it('トレーナーズポスト: only the top four are inspected', () => {
    const { room, alice, source } = setup('トレーナーズポスト', [card('N')]);
    const n = Object.values(room.rawState.cards).find((c) => c.ownerId === alice && c.functionalId === card('N').functionalId)!;
    room.submitAction(alice, { type: 'moveCard', cardId: n.instanceId, toZone: 'deck', insertAt: 'top' });
    room.submitIntent(alice, { type: 'useCardEffect', instanceId: source.instanceId });
    expect(room.rawState.execution?.pendingChoice?.candidates.length).toBeLessThanOrEqual(4);
  });

  it('ふしぎなアメ: basic -> stage2 evolution stack', () => {
    const basic = pool.find((c) => c.name === 'ヒトカゲ')!;
    const stage2 = pool.find((c) => c.name === 'リザードンex')!;
    const { room, alice, bob, source } = setup('ふしぎなアメ', [basic, stage2]);
    const basicId = Object.values(room.rawState.cards).find((c) => c.functionalId === basic.functionalId)!.instanceId;
    const stage2Id = Object.values(room.rawState.cards).find((c) => c.functionalId === stage2.functionalId)!.instanceId;
    room.submitAction(alice, { type: 'moveCard', cardId: basicId, toZone: 'hand' });
    room.submitAction(alice, { type: 'moveCard', cardId: stage2Id, toZone: 'hand' });
    room.submitAction(alice, { type: 'placePokemon', playerId: alice, slotId: 'active', cardId: basicId });
    room.submitIntent(alice, { type: 'useCardEffect', instanceId: source.instanceId });
    finish(room, alice, bob);
    expect(room.rawState.players[alice]!.pokemon[0]?.stack).toEqual([basicId, stage2Id]);
  });
});

describe('T31 supporter and remaining golden cases', () => {
  const simple: readonly [string, (room: Room, a: string, b: string) => boolean][] = [
    ['N', (r, a, b) => count(r, a, 'hand') === 6 && count(r, b, 'hand') === 6],
    ['博士の研究', (r, a) => count(r, a, 'hand') === 7],
    ['シロナ', (r, a) => count(r, a, 'hand') === 6],
    ['アクロマ', (r, a) => count(r, a, 'hand') === 0],
    ['ジャッジマン', (r, a, b) => count(r, a, 'hand') === 4 && count(r, b, 'hand') === 4],
    ['ナンジャモ', (r, a, b) => count(r, a, 'hand') === 6 && count(r, b, 'hand') === 6],
    ['マリィ', (r, a, b) => count(r, a, 'hand') === 5 && count(r, b, 'hand') === 4],
  ];
  it.each(simple)('%s: initial -> apply -> expected', (name, expected) => {
    const { room, alice, bob, source } = setup(name, pool.filter((c) => !c.effects).slice(0, 8));
    room.submitIntent(alice, { type: 'useCardEffect', instanceId: source.instanceId });
    finish(room, alice, bob);
    expect(expected(room, alice, bob)).toBe(true);
  });

  it.each(['ミツル', 'セイジ'] as const)('%s evolves a chosen Pokemon from deck', (name) => {
    const basic = pool.find((c) => c.name === 'ゼニガメ')!;
    const stage1 = pool.find((c) => c.name === 'カメール')!;
    const { room, alice, bob, source } = setup(name, [basic, stage1]);
    const basicId = Object.values(room.rawState.cards).find((c) => c.functionalId === basic.functionalId)!.instanceId;
    room.submitAction(alice, { type: 'moveCard', cardId: basicId, toZone: 'hand' });
    room.submitAction(alice, { type: 'placePokemon', playerId: alice, slotId: 'active', cardId: basicId });
    room.submitIntent(alice, { type: 'useCardEffect', instanceId: source.instanceId });
    finish(room, alice, bob);
    expect(room.rawState.players[alice]!.pokemon[0]?.stack).toHaveLength(2);
  });

  it('ヒガナ attaches up to two basic energies after a previous-turn knockout', () => {
    const energies = pool.filter((c) => c.isBasicEnergy).slice(0, 2);
    const basic = pool.find((c) => c.stage === 'basic')!;
    const { room, alice, bob, source } = setup('ヒガナ', [basic, ...energies]);
    const basicId = Object.values(room.rawState.cards).find((c) => c.functionalId === basic.functionalId)!.instanceId;
    room.submitAction(alice, { type: 'moveCard', cardId: basicId, toZone: 'hand' });
    room.submitAction(alice, { type: 'placePokemon', playerId: alice, slotId: 'active', cardId: basicId });
    for (const energy of energies) {
      const id = Object.values(room.rawState.cards).find((c) => c.functionalId === energy.functionalId)!.instanceId;
      room.submitAction(alice, { type: 'moveCard', cardId: id, toZone: 'hand' });
    }
    room.rawState.turn = 2;
    room.rawState.log.push({ seq: 999, at: 0, actorId: 'server', action: { type: 'knockOut', playerId: alice, slotId: 'bench-0', expectedTopInstanceId: 'gone', prizePlayerId: bob, prizeCount: 1, prizeCardIds: [], actorId: 'server', at: 0 }, summary: '', visibleTo: [alice, bob], undone: false, warnings: [] });
    room.submitIntent(alice, { type: 'useCardEffect', instanceId: source.instanceId });
    finish(room, alice, bob);
    expect(room.rawState.players[alice]!.pokemon[0]?.attachedEnergy).toHaveLength(2);
  });

  it('アセロラ returns a damaged Pokemon stack and attachments to hand', () => {
    const basic = pool.find((c) => c.stage === 'basic')!;
    const { room, alice, bob, source } = setup('アセロラ', [basic]);
    const id = Object.values(room.rawState.cards).find((c) => c.functionalId === basic.functionalId)!.instanceId;
    room.submitAction(alice, { type: 'moveCard', cardId: id, toZone: 'hand' });
    room.submitAction(alice, { type: 'placePokemon', playerId: alice, slotId: 'active', cardId: id });
    room.submitAction(alice, { type: 'adjustDamage', playerId: alice, slotId: 'active', delta: 1 });
    room.submitIntent(alice, { type: 'useCardEffect', instanceId: source.instanceId });
    finish(room, alice, bob);
    expect(room.rawState.cards[id]?.zone).toBe('hand');
  });

  it('グズマ&ハラ searches a Stadium and resolves the optional exact-two cost', () => {
    const stadium = pool.find((c) => c.trainerKind === 'stadium')!;
    const tool = pool.find((c) => c.trainerKind === 'tool')!;
    const { room, alice, bob, source } = setup('グズマ&ハラ', [stadium, tool, ...pool.filter((c) => !c.effects).slice(0, 3)]);
    room.submitIntent(alice, { type: 'useCardEffect', instanceId: source.instanceId });
    finish(room, alice, bob, true);
    expect(cardsInZone(room.rawState, alice, 'hand').some((c) => c.functionalId === stadium.functionalId)).toBe(true);
  });

  it('タッグコール searches tagged cards', () => {
    const { room, alice, bob, source } = setup('タッグコール', [card('グズマ&ハラ')]);
    room.submitIntent(alice, { type: 'useCardEffect', instanceId: source.instanceId });
    finish(room, alice, bob);
    expect(cardsInZone(room.rawState, alice, 'hand').some((c) => c.functionalId === card('グズマ&ハラ').functionalId)).toBe(true);
  });

  it('カリン returns both players discarded Pokemon to their decks', () => {
    const basic = pool.find((c) => c.stage === 'basic')!;
    const { room, alice, bob, source } = setup('カリン', [basic]);
    const a = Object.values(room.rawState.cards).find((c) => c.ownerId === alice && c.functionalId === basic.functionalId)!;
    room.submitAction(alice, { type: 'moveCard', cardId: a.instanceId, toZone: 'discard' });
    const b = cardsInZone(room.rawState, bob, 'deck').find((c) => pool.find((x) => x.functionalId === c.functionalId)?.supertype === 'pokemon')!;
    room.submitAction(bob, { type: 'moveCard', cardId: b.instanceId, toZone: 'discard' });
    room.submitIntent(alice, { type: 'useCardEffect', instanceId: source.instanceId });
    finish(room, alice, bob);
    expect(room.rawState.cards[a.instanceId]?.zone).toBe('deck');
    expect(room.rawState.cards[b.instanceId]?.zone).toBe('deck');
  });
});
