/**
 * 入力を伴う操作のダイアログ。
 * メモ・ダメカン個数・サイド枚数・ベンチ上限・表示名、
 * それに「他のカードのワザを参照」（§5.1-3）の選択。
 */
import { useMemo, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import type { CardIndex, GameState, PlayerId } from '@pokeca/shared';
import { HIDDEN_FUNCTIONAL_ID } from '@pokeca/shared';
import { EnergyPips } from '../components/card/EnergyPips';
import { slotLabel, type PromptResult, type PromptSpec } from './menus';
import styles from './PromptDialog.module.css';

/** 場に出ていて、ワザを持っていて、中身が見えているカードを集める */
function attackSources(state: GameState, cardIndex: CardIndex | null) {
  const out: {
    instanceId: string;
    playerId: PlayerId;
    slotId: string;
    name: string;
    attacks: { name: string; damage: string; cost: readonly string[]; index: number }[];
    functionalId: string;
  }[] = [];

  for (const [playerId, player] of Object.entries(state.players)) {
    for (const slot of player.pokemon) {
      for (const instanceId of slot.stack) {
        const instance = state.cards[instanceId];
        if (!instance || instance.functionalId === HIDDEN_FUNCTIONAL_ID) continue;
        const card = cardIndex?.byFunctionalId.get(instance.functionalId);
        if (!card?.attacks || card.attacks.length === 0) continue;
        out.push({
          instanceId,
          playerId,
          slotId: slot.slotId,
          name: card.name,
          functionalId: card.functionalId,
          attacks: card.attacks.map((a, index) => ({
            name: a.name,
            damage: a.damage,
            cost: a.cost,
            index,
          })),
        });
      }
    }
  }
  return out;
}

export function PromptDialog({
  spec,
  state,
  cardIndex,
  onSubmit,
  onCancel,
}: {
  spec: PromptSpec;
  state: GameState;
  cardIndex: CardIndex | null;
  onSubmit: (result: PromptResult) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(spec.input === 'text' ? spec.initial : '');
  const [num, setNum] = useState(spec.input === 'number' ? String(spec.initial) : '');
  const sources = useMemo(
    () => (spec.input === 'attackRef' ? attackSources(state, cardIndex) : []),
    [spec, state, cardIndex],
  );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (spec.input === 'text') onSubmit(spec.build(text));
    if (spec.input === 'number') {
      const value = Number(num);
      if (!Number.isFinite(value)) return;
      onSubmit(spec.build(value));
    }
  };

  return createPortal(
    <div className={styles.backdrop} onPointerDown={(e) => e.target === e.currentTarget && onCancel()}>
      <form className={styles.dialog} onSubmit={submit}>
        <div className={styles.title}>{spec.title}</div>

        <div className={styles.body}>
          {spec.input === 'text' && (
            <input
              className={styles.input}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={spec.placeholder ?? ''}
              autoFocus
            />
          )}

          {spec.input === 'number' && (
            <>
              <input
                className={styles.input}
                type="number"
                value={num}
                min={spec.min ?? undefined}
                max={spec.max ?? undefined}
                onChange={(e) => setNum(e.target.value)}
                autoFocus
              />
              <div className={styles.quick}>
                {[-5, -1, +1, +5].map((delta) => (
                  <button
                    key={delta}
                    type="button"
                    className={styles.quickButton}
                    onClick={() =>
                      setNum((v) => {
                        const next = (Number(v) || 0) + delta;
                        const min = spec.min ?? Number.NEGATIVE_INFINITY;
                        const max = spec.max ?? Number.POSITIVE_INFINITY;
                        return String(Math.min(max, Math.max(min, next)));
                      })
                    }
                  >
                    {delta > 0 ? `+${delta}` : delta}
                  </button>
                ))}
              </div>
            </>
          )}

          {spec.input === 'attackRef' && (
            <>
              {sources.length === 0 && (
                <p className={styles.empty}>参照できるワザを持つカードが場にありません。</p>
              )}
              {sources.map((source) => (
                <div key={source.instanceId}>
                  <div className={styles.groupLabel}>
                    {state.players[source.playerId]?.displayName ?? source.playerId} /{' '}
                    {slotLabel(source.slotId as never)} — {source.name}
                  </div>
                  <div className={styles.sourceList}>
                    {source.attacks.map((attack) => (
                      <button
                        key={attack.index}
                        type="button"
                        className={styles.source}
                        onClick={() =>
                          onSubmit({
                            action: {
                              type: 'grantAttack',
                              playerId: spec.playerId,
                              slotId: spec.slotId,
                              ref: {
                                functionalId: source.functionalId,
                                attackIndex: attack.index,
                                sourceInstanceId: source.instanceId,
                              },
                            },
                          })
                        }
                      >
                        <EnergyPips types={attack.cost as never} size="sm" />
                        <span className={styles.sourceName}>{attack.name}</span>
                        {attack.damage && <span className={styles.damage}>{attack.damage}</span>}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>

        <div className={styles.footer}>
          <button type="button" className={styles.button} onClick={onCancel}>
            やめる
          </button>
          {spec.input !== 'attackRef' && (
            <button type="submit" className={`${styles.button} ${styles.primary}`}>
              決定
            </button>
          )}
        </div>
      </form>
    </div>,
    document.body,
  );
}
