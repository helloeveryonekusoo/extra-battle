/**
 * 手札（§6.1 横並び・ホバーで持ち上がる）。
 *
 * ホバーで 0.3秒後にフル表示の拡大パネルを出す（§6.6）。
 * カード名とタイプは持ち上がる前から読めるようにしてある。
 */
import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CardIndex, GameState } from '@pokeca/shared';
import { CardFull } from '../card/CardFull';
import { cardKindLine, stripeBackground } from '../card/cardVisuals';
import { dragPayloadFor, handLockOf, type CardView } from './boardView';
import { useDraggable, useDropTarget } from '../../interaction/dnd';
import { useLongPress, type TableController } from '../../interaction/useTableController';
import styles from './Hand.module.css';

const HOVER_DELAY_MS = 300;

export function HandTile({
  view,
  state,
  cardIndex,
  controller,
  onContextMenu,
  onHoverPreview,
}: {
  view: CardView;
  state: GameState;
  cardIndex: CardIndex | null;
  controller: TableController | null;
  onContextMenu?: (e: React.MouseEvent) => void;
  onHoverPreview: (view: CardView | null, rect: DOMRect | null) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const payload = dragPayloadFor(state, cardIndex, view.instanceId);
  const drag = useDraggable(controller && payload ? payload : null);
  const longPress = useLongPress(({ x, y }) => {
    controller?.openMenu({ kind: 'card', instanceId: view.instanceId }, { x, y });
  });

  const startHover = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      onHoverPreview(view, ref.current?.getBoundingClientRect() ?? null);
    }, HOVER_DELAY_MS);
  };

  const endHover = () => {
    if (timer.current) clearTimeout(timer.current);
    onHoverPreview(null, null);
  };

  const card = view.card;

  /*
   * ★ロックで使えないカードは暗くする（§4.1）。
   *   ただし **押せなくはしない**（第2段階 §2「警告はするが、禁止はしない」）。
   *   効果で例外的に使える場面があるので、理由を出して判断は人に任せる。
   */
  const owner = state.cards[view.instanceId]?.ownerId;
  const lock = owner ? handLockOf(state, cardIndex, owner, card) : { locked: false, reason: '' };

  return (
    <button
      ref={ref}
      type="button"
      {...(lock.locked ? { title: `いまは使えません：${lock.reason}` } : {})}
      className={`${styles.tile} ${view.faceDown ? styles.faceDown : ''} ${
        drag.isDragging ? styles.dragging : ''
      } ${lock.locked ? styles.locked : ''}`}
      onMouseEnter={startHover}
      onMouseLeave={endHover}
      onFocus={startHover}
      onBlur={endHover}
      onContextMenu={onContextMenu}
      onPointerDown={(e) => {
        endHover();
        drag.onPointerDown(e);
        longPress.onPointerDown(e);
      }}
      onPointerUp={longPress.onPointerUp}
      onPointerLeave={longPress.onPointerLeave}
      onPointerCancel={longPress.onPointerCancel}
    >
      {card ? (
        <>
          <span className={styles.stripe} style={{ background: stripeBackground(card) }} />
          <span className={styles.tileBody}>
            <span className={styles.tileName}>{card.name}</span>
            <span className={styles.tileKind}>{cardKindLine(card)}</span>
          </span>
          {card.hp !== undefined && <span className={styles.tileHp}>{card.hp}</span>}
        </>
      ) : (
        <span className={styles.tileBody}>
          <span className={styles.tileKind}>非公開</span>
        </span>
      )}
    </button>
  );
}

/** ホバー中に出すフル表示。画面外にはみ出さないよう位置を寄せる */
function HoverPreview({ view, rect }: { view: CardView; rect: DOMRect }) {
  const width = 264;
  const height = 320;
  const left = Math.min(Math.max(8, rect.left + rect.width / 2 - width / 2), window.innerWidth - width - 8);
  const top = Math.max(8, rect.top - height - 10);
  return createPortal(
    <div className={styles.preview} style={{ left, top }}>
      <CardFull card={view.card} faceDown={view.faceDown} />
    </div>,
    document.body,
  );
}

export function Hand({
  views,
  state,
  cardIndex,
  controller = null,
  onCardContextMenu,
}: {
  views: readonly CardView[];
  state: GameState;
  cardIndex: CardIndex | null;
  controller?: TableController | null;
  onCardContextMenu?: (view: CardView, e: React.MouseEvent) => void;
}) {
  const [preview, setPreview] = useState<{ view: CardView; rect: DOMRect } | null>(null);
  const viewerId = views[0] ? state.cards[views[0].instanceId]?.ownerId : undefined;

  // 手札そのものもドロップ先。場やトラッシュから手札へ戻せる
  const drop = useDropTarget(
    controller && viewerId
      ? {
          id: `zone-${viewerId}-hand`,
          accepts: () => true,
          onDrop: (p) => controller.dispatch({ type: 'moveCard', cardId: p.instanceId, toZone: 'hand' }),
        }
      : null,
  );

  return (
    <div
      className={`${styles.hand} ${drop.isOver ? styles.handOver : drop.isActive ? styles.handActive : ''}`}
      ref={drop.ref as never}
    >
      {views.length === 0 && <span className={styles.empty}>手札はありません</span>}
      {views.map((view) => (
        <HandTile
          key={view.instanceId}
          view={view}
          state={state}
          cardIndex={cardIndex}
          controller={controller}
          {...(onCardContextMenu
            ? { onContextMenu: (e: React.MouseEvent) => onCardContextMenu(view, e) }
            : {})}
          onHoverPreview={(v, rect) => setPreview(v && rect ? { view: v, rect } : null)}
        />
      ))}
      {preview && <HoverPreview view={preview.view} rect={preview.rect} />}
    </div>
  );
}

/** 相手の手札。枚数だけが分かる（中身はサーバーが送ってこない） */
export function OpponentHand({ count }: { count: number }) {
  return (
    <div className={styles.opponentHand} aria-label={`相手の手札 ${count}枚`}>
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className={styles.opponentCard} />
      ))}
    </div>
  );
}
