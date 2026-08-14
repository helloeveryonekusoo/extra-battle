/**
 * ポケモンチェックの共有進行（T17）。
 *
 * 対象と解決済み状態を GameState に置くことで、両画面・Undo・ログ再生で
 * 「どこまで処理したか」が一致する。特殊状態が機能するのはバトル場だけなので、
 * ベンチに手動でマーカーが残っていても処理対象にはしない。
 */
import type {
  GameState,
  PlayerId,
  PokemonCheckState,
  PokemonCheckStep,
  PokemonCheckTarget,
  SpecialCondition,
} from './types';

const ORDER = [
  { order: 1, condition: 'poisoned' },
  { order: 2, condition: 'burned' },
  { order: 3, condition: 'asleep' },
  { order: 4, condition: 'paralyzed' },
] as const satisfies readonly Pick<PokemonCheckStep, 'order' | 'condition'>[];

function targetsFor(
  state: GameState,
  condition: SpecialCondition,
  endedTurnPlayerId: PlayerId,
): PokemonCheckTarget[] {
  const targets: PokemonCheckTarget[] = [];
  for (const [playerId, player] of Object.entries(state.players)) {
    // マヒは「そのポケモンの持ち主の番の終わり」だけ回復する。
    if (condition === 'paralyzed' && playerId !== endedTurnPlayerId) continue;
    const slot = player.pokemon.find((pokemon) => pokemon.slotId === 'active');
    const topInstanceId = slot?.stack[slot.stack.length - 1];
    if (!slot || !topInstanceId || !slot.conditions.includes(condition)) continue;
    targets.push({
      playerId,
      slotId: slot.slotId,
      topInstanceId,
      ...(condition === 'burned' || condition === 'asleep' ? { coinResult: null } : {}),
      resolved: false,
    });
  }
  return targets;
}

export function createPokemonCheckState(state: GameState): PokemonCheckState {
  const endedTurnPlayerId = state.activePlayer;
  return {
    endedTurnPlayerId,
    steps: ORDER.map(({ order, condition }) => ({
      order,
      condition,
      targets: targetsFor(state, condition, endedTurnPlayerId),
    })),
  };
}

export function isPokemonCheckComplete(state: GameState): boolean {
  return (
    state.phase === 'pokemonCheck' &&
    state.pokemonCheck !== null &&
    state.pokemonCheck.steps.every((step) => step.targets.every((target) => target.resolved))
  );
}

export function nextPokemonCheckTarget(
  state: GameState,
): { step: PokemonCheckStep; target: PokemonCheckTarget } | null {
  for (const step of state.pokemonCheck?.steps ?? []) {
    const target = step.targets.find((candidate) => !candidate.resolved);
    if (target) return { step, target };
  }
  return null;
}
