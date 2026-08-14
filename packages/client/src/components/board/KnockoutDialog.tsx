/**
 * きぜつの確認ダイアログ（T16 / 第2段階 §5.2）。
 *
 * ★アプリは勝手にきぜつさせない。
 *   残りHPが0になったことに気づかせ、内容を見せて、押されたときだけ実行する。
 *   サイドの枚数は ruleBox から既定値を入れるが、**必ず手で変えられる**
 *   （オルタージェネシスGX の +1、効果でサイドを取らないきぜつがあるため）。
 */
import { useEffect, useState } from 'react';
import {
  findKnockoutCandidates,
  knockoutTimingOf,
  KNOCKOUT_TIMING_LABEL,
  prizeCountForSlot,
  type CardIndex,
  type GameState,
  type Intent,
  type KnockoutCandidate,
  type KnockoutTiming,
  type PlayerId,
} from '@pokeca/shared';
import styles from './KnockoutDialog.module.css';

const RULE_BOX_LABEL = (candidate: KnockoutCandidate): string =>
  candidate.ruleBox === null || candidate.ruleBox === undefined ? '非ルール' : candidate.ruleBox;

const slotLabel = (slotId: string): string =>
  slotId === 'active' ? 'バトル場' : `ベンチ${Number(slotId.slice('bench-'.length)) + 1}`;

export interface KnockoutDialogProps {
  state: GameState;
  viewerId: PlayerId;
  cardIndex: CardIndex | null;
  candidate: KnockoutCandidate;
  timing: KnockoutTiming;
  onConfirm: (options: { prizeCount: number }) => void;
  onDismiss: () => void;
}

export function KnockoutDialog({
  state,
  viewerId,
  cardIndex,
  candidate,
  timing,
  onConfirm,
  onDismiss,
}: KnockoutDialogProps) {
  /*
   * ★既定値はルールボックスだけでなく、場の効果も足したもの（T27 の派生状態）。
   *   オルタージェネシスGX などがかかっていれば、その +1 が最初から入る。
   *   もちろん手で変えられる（T16 の要件）。
   */
  const suggested = prizeCountForSlot(state, candidate.playerId, candidate.slotId, {
    cards: cardIndex,
  });
  const [prizeCount, setPrizeCount] = useState(suggested);

  // 別のポケモンに切り替わったら既定値に戻す
  useEffect(() => {
    setPrizeCount(suggested);
  }, [candidate.key, suggested]);

  const mine = candidate.playerId === viewerId;
  const ownerName = state.players[candidate.playerId]?.displayName ?? candidate.playerId;
  const takerName = candidate.prizeTo
    ? (state.players[candidate.prizeTo]?.displayName ?? candidate.prizeTo)
    : null;
  const totalCards = candidate.stackSize + candidate.attachedCount;

  return (
    <div className={styles.backdrop} role="dialog" aria-label="きぜつの確認">
      <div className={styles.panel}>
        <div className={styles.head}>
          <span className={styles.timing}>{KNOCKOUT_TIMING_LABEL[timing]}</span>
          <h2 className={styles.title}>きぜつの確認</h2>
        </div>

        <div className={styles.target}>
          <span className={`${styles.owner} ${mine ? styles.ownerMine : ''}`}>
            {mine ? '自分' : ownerName}
          </span>
          <span className={styles.name}>{candidate.pokemonName}</span>
          <span className={styles.where}>{slotLabel(candidate.slotId)}</span>
          <span className={styles.ruleBox}>{RULE_BOX_LABEL(candidate)}</span>
        </div>

        <div className={styles.hpRow}>
          <span className={styles.hpLabel}>HP</span>
          {/* きぜつ＝ダメージがHP以上なので、バーは必ず満タン */}
          <span className={styles.hpBar}>
            <span className={styles.hpFill} />
          </span>
          <span className={styles.hpText}>
            {candidate.damage} / {candidate.currentHp}
            <b className={styles.zero}>残り 0</b>
          </span>
        </div>

        <div className={styles.field}>
          <span className={styles.fieldLabel}>
            サイド
            {takerName && <span className={styles.sub}>{takerName}がとる</span>}
          </span>
          <span className={styles.stepper}>
            <button
              className={styles.step}
              aria-label="サイドを減らす"
              disabled={prizeCount <= 0}
              onClick={() => setPrizeCount((n) => Math.max(0, n - 1))}
            >
              −
            </button>
            <span className={styles.count}>{prizeCount}</span>
            <button
              className={styles.step}
              aria-label="サイドを増やす"
              onClick={() => setPrizeCount((n) => n + 1)}
            >
              +
            </button>
          </span>
          <span className={styles.note}>
            既定 {suggested}枚（{RULE_BOX_LABEL(candidate)}
            {suggested !== candidate.suggestedPrizeCount &&
              ` ${candidate.suggestedPrizeCount} + 効果 ${suggested - candidate.suggestedPrizeCount}`}
            ）
            {prizeCount !== suggested && (
              <b className={styles.changed}>変更中</b>
            )}
          </span>
        </div>
        <p className={styles.hint}>
          オルタージェネシスGX などで増えるとき、効果でサイドを取らないときは、ここで変えてください。
        </p>

        <div className={styles.field}>
          <span className={styles.fieldLabel}>
            送り先
            <span className={styles.sub}>スタックとついているカード {totalCards}枚</span>
          </span>
          <strong>持ち主のトラッシュ</strong>
        </div>

        <div className={styles.footer}>
          <span className={styles.footNote}>
            まだきぜつさせない場合は「あとで」。特性や効果で耐えたときはそのままで構いません。
          </span>
          <button className={styles.button} onClick={onDismiss}>
            あとで
          </button>
          <button
            className={`${styles.button} ${styles.primary}`}
            onClick={() => onConfirm({ prizeCount })}
          >
            きぜつを確定
          </button>
        </div>
      </div>
    </div>
  );
}

export interface KnockoutWatchProps {
  state: GameState;
  viewerId: PlayerId;
  cardIndex: CardIndex | null;
  intent: (intent: Intent) => void;
}

/**
 * 盤面を見張り、きぜつしているポケモンが現れたらダイアログを出す。
 *
 * ★状態から毎回作り直すので、指示書の3つのタイミング
 *   （ワザの処理の最後 / ポケモンチェックの最後 / それ以外で残りHPが0になったとき）
 *   がすべて同じ経路で拾える。
 */
export function KnockoutWatch({ state, viewerId, cardIndex, intent }: KnockoutWatchProps) {
  const [dismissed, setDismissed] = useState<string[]>([]);

  const candidates = findKnockoutCandidates(state, { cards: cardIndex });
  const keys = candidates.map((c) => c.key);

  // きぜつ状態でなくなったものは「あとで」を忘れる（回復して再びHPが0になれば また出る）
  useEffect(() => {
    setDismissed((prev) => {
      const kept = prev.filter((key) => keys.includes(key));
      return kept.length === prev.length ? prev : kept;
    });
  }, [keys.join('|')]);

  const current = candidates.find((c) => !dismissed.includes(c.key));
  if (!current) return null;

  return (
    <KnockoutDialog
      state={state}
      viewerId={viewerId}
      cardIndex={cardIndex}
      candidate={current}
      timing={knockoutTimingOf(state)}
      onDismiss={() => setDismissed((prev) => [...prev, current.key])}
      onConfirm={({ prizeCount }) => {
        intent({
          type: 'knockOut',
          playerId: current.playerId,
          slotId: current.slotId,
          expectedTopInstanceId: current.topInstanceId!,
          prizePlayerId: current.prizeTo,
          prizeCount,
        });
        setDismissed((prev) => [...prev, current.key]);
      }}
    />
  );
}
