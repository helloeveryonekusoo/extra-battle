/**
 * V-UNION の組み立て（第4段階 T38 / 完了条件「トラッシュに4種揃うと組み立てUIが出て、ベンチに出せる」）。
 *
 * ★足りないときも「何番が足りないか」だけ出す。どこにあるかは言わない。
 *   サイドの中身を推測させないため（可視性の絶対制約）。
 *
 * ★組み立てられない状態でもボタンは消さない。理由を添えて押せるままにする
 *   （第2段階 §2「警告はするが、禁止はしない」）。
 */
import {
  checkVUnionAssembly,
  getBenchLimit,
  hasUsedOncePerGame,
  vUnionGroupsInDiscard,
  type ActionRequest,
  type CardIndex,
  type GameState,
  type PlayerId,
  type SlotId,
} from '@pokeca/shared';
import { benchSlotIds } from './boardView';
import styles from './VUnionPanel.module.css';

/** 空いているベンチの先頭。なければ null */
function firstFreeBench(
  state: GameState,
  playerId: PlayerId,
  cardIndex: CardIndex | null,
): SlotId | null {
  const used = new Set(state.players[playerId]?.pokemon.map((p) => p.slotId) ?? []);
  const limit = getBenchLimit(state, playerId, { cards: cardIndex });
  for (let i = 0; i < limit; i += 1) {
    const slotId = `bench-${i}` as SlotId;
    if (!used.has(slotId)) return slotId;
  }
  return null;
}

export function VUnionPanel({
  state,
  playerId,
  cardIndex,
  dispatch,
}: {
  state: GameState;
  playerId: PlayerId;
  cardIndex: CardIndex | null;
  dispatch?: (action: ActionRequest) => void;
}) {
  const groups = vUnionGroupsInDiscard(state, playerId, { cards: cardIndex });
  // トラッシュに V-UNION が1枚もなければ、そもそも何も出さない
  if (groups.length === 0) return null;

  const used = hasUsedOncePerGame(state, playerId, 'vunion');
  const bench = firstFreeBench(state, playerId, cardIndex);

  return (
    <section className={styles.panel} aria-label="V-UNIONの組み立て">
      <h3 className={styles.title}>V-UNION の組み立て</h3>
      {groups.map((group) => {
        const readiness = checkVUnionAssembly(group, used, bench !== null);
        return (
          <div key={group.name} className={styles.group}>
            <div className={styles.head}>
              <span className={styles.name}>{group.name}</span>
              <span className={`${styles.count} ${group.complete ? styles.countOk : ''}`}>
                {group.parts.length} / 4
              </span>
            </div>

            {/* 何番がそろっているかを見せる */}
            <ol className={styles.parts} aria-label={`${group.name}の内訳`}>
              {[1, 2, 3, 4].map((part) => {
                const found = group.parts.find((entry) => entry.part === part);
                return (
                  <li
                    key={part}
                    className={`${styles.part} ${found ? styles.partFound : styles.partMissing}`}
                  >
                    {part}
                  </li>
                );
              })}
            </ol>

            {readiness.reason && <p className={styles.reason}>{readiness.reason}</p>}

            <button
              type="button"
              className={styles.assemble}
              disabled={!dispatch || bench === null}
              onClick={() =>
                bench &&
                dispatch?.({
                  type: 'assembleVUnion',
                  playerId,
                  slotId: bench,
                  // 1枚目から4枚目の順に積む
                  cardIds: group.parts.map((entry) => entry.instanceId),
                })
              }
              title={readiness.reason ?? 'ベンチに組み立てて出す'}
            >
              {bench === null ? 'ベンチに空きがありません' : `ベンチに出す（${benchLabel(state, playerId, cardIndex, bench)}）`}
            </button>
          </div>
        );
      })}
    </section>
  );
}

const benchLabel = (
  state: GameState,
  playerId: PlayerId,
  cardIndex: CardIndex | null,
  slotId: SlotId,
): string => {
  const index = benchSlotIds(state, playerId, cardIndex).indexOf(slotId);
  return `ベンチ${index + 1}`;
};
