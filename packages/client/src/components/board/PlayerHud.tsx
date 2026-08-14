/**
 * 常時表示のHUD（§6.5）。
 * 勝敗と手番に直結する情報だけを、迷わず読める大きさで出す。
 *
 * 山札・トラッシュ・ロスト・サイドはドロップ先も兼ねる（§6.6）。
 */
import {
  attackAllowanceFor,
  ONCE_PER_GAME_LABEL,
  vUnionGroupsInDiscard,
  type CardIndex,
  type GameState,
  type OncePerGameKind,
  type BooleanTurnFlag,
  type PlayerId,
  type TurnFlags,
  type Zone,
} from '@pokeca/shared';
import { zoneCount } from './boardView';
import { useDropTarget } from '../../interaction/dnd';
import type { TableController } from '../../interaction/useTableController';
import styles from './PlayerHud.module.css';

/** 山札がこの枚数以下になったら警告色にする */
const DECK_WARNING = 10;

const LIMITS: { flag: BooleanTurnFlag; icon: string; label: string }[] = [
  { flag: 'energyAttached', icon: '⚡', label: 'エネルギー' },
  { flag: 'supporterUsed', icon: '👤', label: 'サポート' },
  { flag: 'stadiumPlayed', icon: '🏟', label: 'スタジアム' },
  { flag: 'retreated', icon: '🏃', label: 'にげる' },
];

/** サイド残り枚数。円で表し、とられたものは消灯。数字も併記する */
export function PrizeDots({ remaining, total }: { remaining: number; total: number }) {
  return (
    <div className={styles.prizes}>
      <span className={styles.prizeLabel}>サイド</span>
      <div className={styles.dots}>
        {Array.from({ length: total }, (_, i) => (
          <span
            key={i}
            className={`${styles.dot} ${i >= remaining ? styles.dotTaken : ''}`}
            aria-hidden
          />
        ))}
      </div>
      <span
        className={`${styles.prizeCount} ${remaining <= 1 ? styles.prizeCountLast : ''}`}
        aria-label={`サイド残り${remaining}枚`}
      >
        {remaining}
      </span>
    </div>
  );
}

export function TurnLimits({
  flags,
  onToggle,
}: {
  flags: TurnFlags;
  onToggle?: (flag: BooleanTurnFlag, next: boolean) => void;
}) {
  return (
    <div className={styles.limits}>
      {LIMITS.map(({ flag, icon, label }) => (
        <button
          key={flag}
          type="button"
          className={`${styles.limit} ${flags[flag] ? styles.limitUsed : ''} ${
            onToggle ? styles.limitClickable : ''
          }`}
          disabled={!onToggle}
          title={flags[flag] ? `${label}：使用済み` : `${label}：まだ使える`}
          onClick={() => onToggle?.(flag, !flags[flag])}
        >
          <span className={styles.limitIcon} aria-hidden>
            {icon}
          </span>
          {label}
        </button>
      ))}
    </div>
  );
}

/**
 * ★この番に使えるワザの回数（Ω連打。T39）。
 *   「1番に1回」を定数にしないので、上限が2以上のときだけ出す。
 *   ワザを使っても番が終わらない場合があることを、ここで気づけるようにする。
 */
export function AttackAllowance({ used, allowance }: { used: number; allowance: number }) {
  if (allowance <= 1) return null;
  return (
    <span
      className={`${styles.onceChip} ${used >= allowance ? styles.onceUsed : ''}`}
      title={`この番に使えるワザは${allowance}回（すでに${used}回）`}
    >
      ワザ {used}/{allowance}
    </span>
  );
}

/**
 * ★対戦中1回の枠（T36）。
 *   GXワザ・VSTARパワーは **プレイヤー単位** なので、
 *   ポケモンのバッジではなく HUD に出す。ポケモンを入れ替えても戻らないことが見て分かる。
 */
export function OncePerGameChips({
  used,
  kinds = ['gx', 'vstar'],
  onToggle,
}: {
  used: readonly OncePerGameKind[];
  /** 出す枠。V-UNION はデッキに入っている卓でだけ出す */
  kinds?: readonly OncePerGameKind[];
  onToggle?: (kind: OncePerGameKind, next: boolean) => void;
}) {
  return (
    <div className={styles.once}>
      {kinds.map((kind) => {
        const spent = used.includes(kind);
        return (
          <button
            key={kind}
            type="button"
            className={`${styles.onceChip} ${spent ? styles.onceUsed : ''} ${
              onToggle ? styles.limitClickable : ''
            }`}
            disabled={!onToggle}
            title={
              spent
                ? `${ONCE_PER_GAME_LABEL[kind]}：この対戦で使用済み（プレイヤーごとに1回）`
                : `${ONCE_PER_GAME_LABEL[kind]}：まだ使える（プレイヤーごとに1回）`
            }
            onClick={() => onToggle?.(kind, !spent)}
          >
            {CHIP_LABEL[kind]}
            {spent && <span className={styles.onceMark}>使用済み</span>}
          </button>
        );
      })}
    </div>
  );
}

const CHIP_LABEL: Record<OncePerGameKind, string> = {
  gx: 'GX',
  vstar: 'VSTAR',
  vunion: 'V-UNION',
};

/** 枚数表示 兼 ドロップ先 兼 メニューの入口 */
function ZoneChip({
  label,
  count,
  zone,
  playerId,
  warn = false,
  controller,
  onZoneMenu,
}: {
  label: string;
  count: number;
  zone: Zone;
  playerId: PlayerId;
  warn?: boolean;
  controller: TableController | null;
  onZoneMenu?: (playerId: PlayerId, zone: Zone, x: number, y: number) => void;
}) {
  const drop = useDropTarget(
    controller
      ? {
          id: `zone-${playerId}-${zone}`,
          accepts: () => true,
          onDrop: (p) =>
            controller.dispatch({
              type: 'moveCard',
              cardId: p.instanceId,
              toZone: zone,
              ...(zone === 'deck' ? { insertAt: 'top' as const } : {}),
            }),
        }
      : null,
  );

  const open = (e: React.MouseEvent) => {
    e.preventDefault();
    onZoneMenu?.(playerId, zone, e.clientX, e.clientY);
  };

  return (
    <button
      type="button"
      ref={drop.ref as never}
      className={`${styles.count} ${warn ? styles.low : ''} ${
        drop.isOver ? styles.dropOver : drop.isActive ? styles.dropActive : ''
      } ${controller ? styles.countClickable : ''}`}
      disabled={!controller}
      onClick={open}
      onContextMenu={open}
      title={controller ? 'クリックで操作メニュー / ドラッグで移動' : ''}
    >
      {label} <b>{count}</b>
    </button>
  );
}

export function PlayerHud({
  state,
  playerId,
  cardIndex = null,
  connected = true,
  controller = null,
  onZoneMenu,
}: {
  state: GameState;
  playerId: PlayerId;
  /** V-UNION の枠を出すかどうかの判定に要る（T38） */
  cardIndex?: CardIndex | null;
  connected?: boolean;
  controller?: TableController | null;
  onZoneMenu?: (playerId: PlayerId, zone: Zone, x: number, y: number) => void;
}) {
  const player = state.players[playerId];
  if (!player) return null;

  const deck = zoneCount(state, playerId, 'deck');
  const chip = (label: string, zone: Zone, warn = false) => (
    <ZoneChip
      label={label}
      count={zoneCount(state, playerId, zone)}
      zone={zone}
      playerId={playerId}
      warn={warn}
      controller={controller}
      {...(onZoneMenu ? { onZoneMenu } : {})}
    />
  );

  return (
    <div className={styles.hud}>
      <span className={styles.name}>
        {player.displayName || playerId}
        {!connected && <span className={styles.offline}>切断中</span>}
      </span>

      <button
        type="button"
        className={styles.prizeButton}
        disabled={!controller}
        onClick={(e) => onZoneMenu?.(playerId, 'prize', e.clientX, e.clientY)}
        title={controller ? 'クリックでサイドの操作' : ''}
      >
        <PrizeDots remaining={player.prizesRemaining} total={player.prizesTotal} />
      </button>

      <div className={styles.counts}>
        {chip('山札', 'deck', deck <= DECK_WARNING)}
        {chip('手札', 'hand')}
        {chip('トラッシュ', 'discard')}
        {chip('ロスト', 'lost')}
        <button
          type="button"
          className={`${styles.count} ${controller ? styles.countClickable : ''}`}
          disabled={!controller}
          onClick={(e) => onZoneMenu?.(playerId, 'bench', e.clientX, e.clientY)}
          title={controller ? 'クリックでベンチ上限を変える' : ''}
        >
          ベンチ上限 <b>{player.benchLimit}</b>
        </button>
      </div>

      <span className={styles.spacer} />

      {/* ★Ω連打などでワザの回数が増えているときだけ出す（T39） */}
      <AttackAllowance
        used={player.turnFlags.attacksUsed}
        allowance={
          // バトル場のポケモンを基準にする。ワザを使うのはバトル場だけ
          attackAllowanceFor(state, playerId, 'active', { cards: cardIndex })
        }
      />

      <OncePerGameChips
        used={player.oncePerGameUsed}
        kinds={
          // V-UNION の枠は、その卓に V-UNION がある（or もう組み立てた）ときだけ出す
          vUnionGroupsInDiscard(state, playerId, { cards: cardIndex }).length > 0 ||
          player.oncePerGameUsed.includes('vunion')
            ? (['gx', 'vstar', 'vunion'] as const)
            : (['gx', 'vstar'] as const)
        }
        {...(controller
          ? {
              onToggle: (kind: OncePerGameKind, value: boolean) =>
                controller.dispatch({ type: 'setOncePerGameUsed', playerId, kind, value }),
            }
          : {})}
      />

      <TurnLimits
        flags={player.turnFlags}
        {...(controller
          ? {
              onToggle: (flag: BooleanTurnFlag, value: boolean) =>
                controller.dispatch({ type: 'setTurnFlag', playerId, flag, value }),
            }
          : {})}
      />
    </div>
  );
}
