import { describe, expect, it } from 'vitest';
import { cardsInZone, findSlot } from '@pokeca/shared';
import { loadCardTexts } from './cardStore';
import { Room } from './room';

const cardPool = loadCardTexts();

function table() {
  let now = 1_800_000_000_000;
  const room = new Room({
    code: 'CHECK1',
    rngSeed: 'seed-pokemon-check',
    cardPool,
    now: () => (now += 1000),
  });
  const alice = room.join('アリス').playerId;
  const bob = room.join('ボブ').playerId;
  for (const playerId of [alice, bob]) {
    room.submitIntent(playerId, { type: 'devDealSampleDeck', playerId, size: 20 });
    const top = cardsInZone(room.rawState, playerId, 'deck')[0]!;
    room.submitAction(playerId, {
      type: 'placePokemon',
      playerId,
      slotId: 'active',
      cardId: top.instanceId,
    });
  }
  room.submitAction(alice, { type: 'setActivePlayer', playerId: alice });
  return { room, alice, bob };
}

describe('サーバー側ポケモンチェック', () => {
  it('やけどのダメカンとコインを1アクションで処理し、乱数seedをログに残す', () => {
    const { room, alice } = table();
    room.submitAction(alice, {
      type: 'setCondition',
      playerId: alice,
      slotId: 'active',
      condition: 'burned',
      on: true,
    });
    room.submitAction(alice, { type: 'setPhase', phase: 'pokemonCheck' });
    const target = room.rawState.pokemonCheck!.steps[1]!.targets[0]!;

    room.submitIntent(alice, {
      type: 'resolvePokemonCheckTarget',
      order: 2,
      playerId: target.playerId,
      slotId: target.slotId,
      expectedTopInstanceId: target.topInstanceId,
    });

    expect(findSlot(room.rawState, alice, 'active')?.damageCounters).toBe(2);
    const entry = room.rawState.log.at(-1)!;
    expect(entry.action.type).toBe('resolvePokemonCheckTarget');
    expect(entry.seed).toMatch(/^seed-pokemon-check:\d+$/);
    if (entry.action.type === 'resolvePokemonCheckTarget') {
      expect(['heads', 'tails']).toContain(entry.action.coinResult);
      expect(room.rawState.pokemonCheck?.steps[1]?.targets[0]?.coinResult).toBe(
        entry.action.coinResult,
      );
    }
  });

  it('ねむりのコインもサーバーが決め、同じ対象への重複要求は一度だけ処理する', () => {
    const { room, alice } = table();
    room.submitAction(alice, {
      type: 'setCondition',
      playerId: alice,
      slotId: 'active',
      condition: 'asleep',
      on: true,
    });
    room.submitAction(alice, { type: 'setPhase', phase: 'pokemonCheck' });
    const target = room.rawState.pokemonCheck!.steps[2]!.targets[0]!;
    const intent = {
      type: 'resolvePokemonCheckTarget' as const,
      order: 3 as const,
      playerId: target.playerId,
      slotId: target.slotId,
      expectedTopInstanceId: target.topInstanceId,
    };

    const before = room.rawState.log.length;
    room.submitIntent(alice, intent);
    room.submitIntent(alice, intent);
    expect(room.rawState.log).toHaveLength(before + 1);
    expect(room.rawState.pokemonCheck?.steps[2]?.targets[0]?.resolved).toBe(true);
  });

  it('マヒは直前に番を行ったプレイヤーだけを対象にする', () => {
    const { room, alice, bob } = table();
    for (const playerId of [alice, bob]) {
      room.submitAction(playerId, {
        type: 'setCondition',
        playerId,
        slotId: 'active',
        condition: 'paralyzed',
        on: true,
      });
    }
    room.submitAction(alice, { type: 'setPhase', phase: 'pokemonCheck' });
    expect(room.rawState.pokemonCheck?.steps[3]?.targets).toEqual([
      expect.objectContaining({ playerId: alice }),
    ]);
    expect(findSlot(room.rawState, bob, 'active')?.conditions).toContain('paralyzed');
  });
});
