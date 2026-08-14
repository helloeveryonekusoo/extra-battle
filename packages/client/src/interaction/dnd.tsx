/**
 * ドラッグ&ドロップの土台（§6.6）。
 *
 * 外部ライブラリを足さず Pointer Events で自作している。理由は2つ:
 *   - HTML5 の DnD はタッチ端末で動かない（§6.9 でタブレット・スマホも見る）
 *   - ドロップ可能な場所のハイライトを自前で制御したい
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import type { CardText, PlayerId, SlotId, Zone } from '@pokeca/shared';

/** 動かしているもの */
export interface DragPayload {
  instanceId: string;
  ownerId: PlayerId;
  fromZone: Zone;
  /** 場のカードならどのスロットから来たか */
  fromSlotId?: SlotId;
  card?: CardText;
  faceDown: boolean;
}

export interface DropTargetSpec {
  id: string;
  accepts: (payload: DragPayload) => boolean;
  onDrop: (payload: DragPayload) => void;
}

interface Registered extends DropTargetSpec {
  el: HTMLElement;
}

interface DragState {
  payload: DragPayload | null;
  overId: string | null;
  register: (target: Registered) => () => void;
  begin: (payload: DragPayload, event: React.PointerEvent) => void;
}

const DragContext = createContext<DragState | null>(null);

/** 5px 動いたらドラッグ開始。クリックと区別する */
const DRAG_THRESHOLD = 5;

export function DragProvider({ children }: { children: ReactNode }) {
  const targets = useRef(new Map<string, Registered>());
  const [payload, setPayload] = useState<DragPayload | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null);

  const pending = useRef<{ payload: DragPayload; x: number; y: number } | null>(null);
  const active = useRef<DragPayload | null>(null);

  const register = useCallback((target: Registered) => {
    targets.current.set(target.id, target);
    return () => {
      targets.current.delete(target.id);
    };
  }, []);

  /** 座標の下にある、受け入れ可能なドロップ先を探す */
  const hitTest = useCallback((x: number, y: number, dragged: DragPayload): string | null => {
    let best: { id: string; area: number } | null = null;
    for (const target of targets.current.values()) {
      if (!target.el.isConnected || !target.accepts(dragged)) continue;
      const rect = target.el.getBoundingClientRect();
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;
      const area = rect.width * rect.height;
      // 入れ子になっている場合は内側（面積の小さいほう）を優先する
      if (!best || area < best.area) best = { id: target.id, area };
    }
    return best?.id ?? null;
  }, []);

  const begin = useCallback((next: DragPayload, event: React.PointerEvent) => {
    pending.current = { payload: next, x: event.clientX, y: event.clientY };
  }, []);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      if (!active.current && pending.current) {
        const dx = event.clientX - pending.current.x;
        const dy = event.clientY - pending.current.y;
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        active.current = pending.current.payload;
        setPayload(pending.current.payload);
      }
      if (!active.current) return;
      event.preventDefault();
      setGhost({ x: event.clientX, y: event.clientY });
      setOverId(hitTest(event.clientX, event.clientY, active.current));
    };

    const onUp = (event: PointerEvent) => {
      const dragged = active.current;
      pending.current = null;
      active.current = null;
      if (dragged) {
        const id = hitTest(event.clientX, event.clientY, dragged);
        const target = id ? targets.current.get(id) : undefined;
        target?.onDrop(dragged);
      }
      setPayload(null);
      setOverId(null);
      setGhost(null);
    };

    const onCancel = () => {
      pending.current = null;
      active.current = null;
      setPayload(null);
      setOverId(null);
      setGhost(null);
    };

    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };
  }, [hitTest]);

  const value = useMemo<DragState>(
    () => ({ payload, overId, register, begin }),
    [payload, overId, register, begin],
  );

  return (
    <DragContext.Provider value={value}>
      {children}
      {payload &&
        ghost &&
        createPortal(
          <div
            style={{
              position: 'fixed',
              left: ghost.x + 12,
              top: ghost.y + 12,
              zIndex: 200,
              pointerEvents: 'none',
              padding: '5px 10px',
              background: 'var(--panel-hi)',
              border: '1px solid var(--accent)',
              borderRadius: 6,
              fontSize: 12,
              boxShadow: '0 8px 20px rgba(0,0,0,0.5)',
            }}
          >
            {payload.faceDown ? '非公開のカード' : (payload.card?.name ?? 'カード')}
          </div>,
          document.body,
        )}
    </DragContext.Provider>
  );
}

function useDragContext(): DragState | null {
  return useContext(DragContext);
}

/** つかめるカードにする */
export function useDraggable(payload: DragPayload | null): {
  onPointerDown: (e: React.PointerEvent) => void;
  isDragging: boolean;
} {
  const ctx = useDragContext();
  return {
    onPointerDown: (event: React.PointerEvent) => {
      if (!ctx || !payload || event.button !== 0) return;
      ctx.begin(payload, event);
    },
    isDragging: ctx?.payload?.instanceId === payload?.instanceId && payload !== null,
  };
}

/**
 * 置ける場所にする。
 * isActive = 今つかんでいるものを受け入れられる（ハイライト対象）
 * isOver   = そのうえにポインタがある
 */
export function useDropTarget(spec: DropTargetSpec | null): {
  ref: (el: HTMLElement | null) => void;
  isActive: boolean;
  isOver: boolean;
} {
  const ctx = useDragContext();
  const elRef = useRef<HTMLElement | null>(null);
  const cleanup = useRef<(() => void) | null>(null);
  const specRef = useRef(spec);
  specRef.current = spec;

  const ref = useCallback(
    (el: HTMLElement | null) => {
      cleanup.current?.();
      cleanup.current = null;
      elRef.current = el;
      const current = specRef.current;
      if (el && ctx && current) {
        cleanup.current = ctx.register({
          id: current.id,
          el,
          accepts: (p) => (specRef.current ?? current).accepts(p),
          onDrop: (p) => (specRef.current ?? current).onDrop(p),
        });
      }
    },
    [ctx],
  );

  useEffect(() => () => cleanup.current?.(), []);

  const dragging = ctx?.payload ?? null;
  const isActive = Boolean(spec && dragging && spec.accepts(dragging));
  return { ref, isActive, isOver: isActive && ctx?.overId === spec?.id };
}
