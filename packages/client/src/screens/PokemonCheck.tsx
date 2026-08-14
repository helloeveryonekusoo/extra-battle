/**
 * ポケモンチェックの実処理UI（T17）。
 * 進行は GameState.pokemonCheck に置き、両画面で同じ順序・解決結果を見る。
 */
import { useEffect, useState } from 'react';
import {
  isPokemonCheckComplete,
  nextPokemonCheckTarget,
  type ActionRequest,
  type CardIndex,
  type GameState,
  type Intent,
  type PlayerId,
  type PokemonCheckStep,
  type PokemonCheckTarget,
  type SlotId,
  type SpecialCondition,
} from '@pokeca/shared';
import styles from './PokemonCheck.module.css';

const DETAILS: Record<
  1 | 2 | 3 | 4,
  { condition: SpecialCondition; label: string; rule: string }
> = {
  1: { condition: 'poisoned', label: 'どく', rule: 'ダメカン（既定1個・変更可）' },
  2: { condition: 'burned', label: 'やけど', rule: 'ダメカン2個 → コイン → オモテで回復' },
  3: { condition: 'asleep', label: 'ねむり', rule: 'コイン → オモテで回復' },
  4: { condition: 'paralyzed', label: 'マヒ', rule: '持ち主の番の終わりに自動回復' },
};

export interface PokemonCheckProps {
  state: GameState;
  viewerId: PlayerId;
  cardIndex: CardIndex | null;
  dispatch: (action: ActionRequest) => void;
  intent: (intent: Intent) => void;
  canRandomize: boolean;
}

const targetKey = (target: PokemonCheckTarget): string =>
  `${target.playerId}/${target.slotId}/${target.topInstanceId}`;

const slotLabel = (slotId: SlotId): string =>
  slotId === 'active' ? 'バトル場' : `ベンチ${Number(slotId.slice('bench-'.length)) + 1}`;

function targetName(
  state: GameState,
  cardIndex: CardIndex | null,
  target: PokemonCheckTarget,
): string {
  const instance = state.cards[target.topInstanceId];
  if (!instance || instance.functionalId === '') return '非公開のポケモン';
  return cardIndex?.byFunctionalId.get(instance.functionalId)?.name ?? 'ポケモン';
}

const sameTarget = (
  current: ReturnType<typeof nextPokemonCheckTarget>,
  step: PokemonCheckStep,
  target: PokemonCheckTarget,
): boolean =>
  current?.step.order === step.order &&
  current.target.playerId === target.playerId &&
  current.target.slotId === target.slotId &&
  current.target.topInstanceId === target.topInstanceId;

export function PokemonCheck({
  state,
  viewerId,
  cardIndex,
  dispatch,
  intent,
  canRandomize,
}: PokemonCheckProps) {
  const [poisonCounters, setPoisonCounters] = useState<Record<string, number>>({});
  const check = state.pokemonCheck;
  const current = nextPokemonCheckTarget(state);
  const complete = isPokemonCheckComplete(state);
  const nameOf = (playerId: PlayerId) => state.players[playerId]?.displayName ?? playerId;

  // マヒは対象の持ち主（＝直前の番のプレイヤー）の画面から自動で解決を依頼する。
  // 両画面から送らないので通常は1件だけ。サーバー側も重複をno-opにする。
  useEffect(() => {
    if (
      !canRandomize ||
      !check ||
      current?.step.order !== 4 ||
      check.endedTurnPlayerId !== viewerId
    ) {
      return;
    }
    intent({
      type: 'resolvePokemonCheckTarget',
      order: 4,
      playerId: current.target.playerId,
      slotId: current.target.slotId,
      expectedTopInstanceId: current.target.topInstanceId,
    });
  }, [
    canRandomize,
    check?.endedTurnPlayerId,
    current?.step.order,
    current?.target.playerId,
    current?.target.slotId,
    current?.target.topInstanceId,
    intent,
    viewerId,
  ]);

  if (!check) {
    return (
      <div className={styles.backdrop} role="dialog" aria-label="ポケモンチェック">
        <div className={styles.panel}>
          <div className={styles.head}>
            <h2 className={styles.title}>ポケモンチェック</h2>
            <p className={styles.lead}>対象を準備しています…</p>
          </div>
        </div>
      </div>
    );
  }

  const total = check.steps.reduce((sum, step) => sum + step.targets.length, 0);
  const resolve = (step: PokemonCheckStep, target: PokemonCheckTarget, skip = false) => {
    const key = targetKey(target);
    intent({
      type: 'resolvePokemonCheckTarget',
      order: step.order,
      playerId: target.playerId,
      slotId: target.slotId,
      expectedTopInstanceId: target.topInstanceId,
      ...(step.order === 1 ? { poisonCounters: poisonCounters[key] ?? 1 } : {}),
      ...(skip ? { skip: true } : {}),
    });
  };

  return (
    <div className={styles.backdrop} role="dialog" aria-label="ポケモンチェック">
      <div className={styles.panel}>
        <div className={styles.head}>
          <h2 className={styles.title}>ポケモンチェック</h2>
          <p className={styles.lead}>
            どく → やけど → ねむり → マヒの順に、サーバーと同期して処理します。
            {total === 0 && ' 今回は対象がいません。'}
          </p>
        </div>

        <div className={styles.body}>
          {check.steps.map((step) => {
            const detail = DETAILS[step.order];
            return (
              <section key={step.order} className={styles.section}>
                <div className={styles.sectionHead}>
                  <span className={styles.index}>{step.order}</span>
                  <span className={`${styles.dot} ${styles[detail.condition]}`} />
                  <span className={styles.sectionName}>{detail.label}</span>
                  <span className={styles.rule}>{detail.rule}</span>
                </div>

                {step.targets.length === 0 && <div className={styles.none}>該当なし</div>}

                {step.targets.map((target) => {
                  const key = targetKey(target);
                  const active = sameTarget(current, step, target);
                  const count = poisonCounters[key] ?? 1;
                  const isMine = target.playerId === viewerId;
                  return (
                    <div
                      key={key}
                      className={`${styles.entry} ${target.resolved ? styles.entryDone : ''}`}
                    >
                      <span className={`${styles.owner} ${isMine ? styles.ownerMine : ''}`}>
                        {isMine ? '自分' : nameOf(target.playerId)}
                      </span>
                      <span className={styles.pokemon}>
                        {targetName(state, cardIndex, target)}{' '}
                        <span className={styles.where}>{slotLabel(target.slotId)}</span>
                      </span>

                      <span className={styles.actions}>
                        {target.resolved ? (
                          <span className={styles.result}>
                            {target.skipped
                              ? 'スキップ'
                              : target.coinResult
                                ? `コイン ${target.coinResult === 'heads' ? 'オモテ' : 'ウラ'}`
                                : '処理済み'}
                          </span>
                        ) : active && step.order === 1 ? (
                          <>
                            <span className={styles.counter}>
                              <button
                                className={styles.mini}
                                aria-label="どくのダメカンを減らす"
                                disabled={count <= 0}
                                onClick={() =>
                                  setPoisonCounters((values) => ({
                                    ...values,
                                    [key]: Math.max(0, count - 1),
                                  }))
                                }
                              >
                                −
                              </button>
                              <b>{count}</b>
                              <button
                                className={styles.mini}
                                aria-label="どくのダメカンを増やす"
                                onClick={() =>
                                  setPoisonCounters((values) => ({ ...values, [key]: count + 1 }))
                                }
                              >
                                +
                              </button>
                            </span>
                            <button
                              className={`${styles.action} ${styles.primaryAction}`}
                              onClick={() => resolve(step, target)}
                            >
                              ダメカンをのせる
                            </button>
                          </>
                        ) : active && step.order === 2 ? (
                          <button
                            className={`${styles.action} ${styles.primaryAction}`}
                            disabled={!canRandomize}
                            onClick={() => resolve(step, target)}
                          >
                            +2してコイン
                          </button>
                        ) : active && step.order === 3 ? (
                          <button
                            className={`${styles.action} ${styles.primaryAction}`}
                            disabled={!canRandomize}
                            onClick={() => resolve(step, target)}
                          >
                            コインを投げる
                          </button>
                        ) : active && step.order === 4 ? (
                          <span className={styles.result}>自動回復中…</span>
                        ) : (
                          <span className={styles.result}>前の処理を待っています</span>
                        )}

                        {active && step.order !== 4 && !target.resolved && (
                          <button className={styles.action} onClick={() => resolve(step, target, true)}>
                            スキップ
                          </button>
                        )}
                      </span>

                      <span className={styles.check}>{target.resolved ? '✓' : active ? '→' : ''}</span>
                    </div>
                  );
                })}
              </section>
            );
          })}
        </div>

        <div className={styles.footer}>
          <span className={styles.footNote}>
            {complete
              ? '特殊状態の処理が完了しました。HPが0なら、先にきぜつ確認が表示されます。'
              : `次の対象を処理してください。例外は「スキップ」で先へ進めます。`}
          </span>
          <button className={styles.button} onClick={() => dispatch({ type: 'setPhase', phase: 'turn' })}>
            戻る
          </button>
          <button
            className={`${styles.button} ${styles.primary}`}
            disabled={!complete}
            onClick={() => intent({ type: 'endTurn' })}
          >
            チェック完了
          </button>
        </div>
      </div>
    </div>
  );
}
