"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { cn } from "@/lib/utils";

/**
 * A little celebration at the pointer, for the few seconds after a trade lands.
 *
 * The status note already says "Buy confirmed", and it says it in the panel — which is where the
 * eye is least likely to be by the time it appears, after a wallet popup has taken and given back
 * focus. This puts the good news where the pointer already is, and makes landing a trade feel like
 * something happened rather than a line of text quietly changing colour.
 *
 * Only on success, and only briefly: waiting is the panel's job, and a companion that turned up
 * for every pending transaction would be in the way far more often than it was welcome.
 *
 * It is decoration, so it never takes a click — `pointer-events: none` throughout — and it is
 * driven from `useBatch`'s own status rather than from anything a caller has to remember to fire.
 *
 * Not a CSS `cursor: url(…)`: Chrome renders only the first frame of an animated image used as a
 * cursor, so the dance has to be a real element that chases the pointer.
 */

/** How long the celebration stays up. */
const CELEBRATE_MS = 5_000;

/** Rendered size. The sprite is twice this, so it stays sharp on a retina screen. */
const SPRITE_W = 116;
const SPRITE_H = 118;

// ---------------------------------------------------------------------------------------------
// Shared between every `useBatch` on the page and the single companion in the layout.
// ---------------------------------------------------------------------------------------------

let celebrating = false;
let clearTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function publish(next: boolean) {
  if (next === celebrating) return;
  if (clearTimer) {
    clearTimeout(clearTimer);
    clearTimer = undefined;
  }
  celebrating = next;
  listeners.forEach((l) => l());
  // The celebration clears itself. Nothing else knows when the user has seen enough.
  if (next) clearTimer = setTimeout(() => publish(false), CELEBRATE_MS);
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Drive the celebration from a batch's status.
 *
 * Called inside `useBatch`, so every batched trade — writing an option, buying one, opening a whole
 * structure — gets this without its own wiring.
 */
export function useDanceWithBatch(status: "idle" | "running" | "success" | "failure") {
  useEffect(() => {
    if (status === "success") publish(true);
  }, [status]);
}

// ---------------------------------------------------------------------------------------------
// Where the pointer is. Tracked continuously, so the dancer appears *at* the button that was just
// clicked instead of flying in from the corner.
// ---------------------------------------------------------------------------------------------

const pointer = { x: 0, y: 0, seen: false };

/** Mounted once, in the root layout. Renders nothing at all until a trade lands. */
export function CursorDance() {
  const visible = useSyncExternalStore(
    subscribe,
    () => celebrating,
    () => false,
  );

  const holder = useRef<HTMLDivElement>(null);
  /** Where the sprite actually is, trailing the pointer. Null until a pointer has been seen. */
  const at = useRef<{ x: number; y: number } | null>(null);
  const [anchored, setAnchored] = useState(true);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      pointer.x = e.clientX;
      pointer.y = e.clientY;
      pointer.seen = true;
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerdown", onMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerdown", onMove);
    };
  }, []);

  useEffect(() => {
    if (!visible) return;
    const el = holder.current;
    if (!el) return;

    // Whether there is a pointer to follow is decided every frame, not once on the way in. A
    // touch device never grows one, and parks in the corner for good; a keyboard user who pressed
    // Enter on the button starts there and is picked up the moment they reach for the mouse.
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    let frame = 0;

    const tick = () => {
      frame = requestAnimationFrame(tick);
      if (!pointer.seen) return;

      if (!at.current) {
        // First sight of the pointer: appear there rather than sliding in from the corner.
        at.current = { x: pointer.x, y: pointer.y };
        setAnchored(false);
      }
      const p = at.current;
      if (reduced) {
        p.x = pointer.x;
        p.y = pointer.y;
      } else {
        // A lag of about a fifth per frame: enough that it trails the pointer like something
        // being pulled along, little enough that it never feels lost.
        p.x += (pointer.x - p.x) * 0.18;
        p.y += (pointer.y - p.y) * 0.18;
      }
      // Feet near the pointer, body up and a little to the right — clear of the cursor itself
      // and of whatever it is hovering.
      el.style.transform = `translate3d(${p.x - SPRITE_W * 0.16}px, ${p.y - SPRITE_H * 0.86}px, 0)`;
    };

    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      at.current = null;
      setAnchored(!pointer.seen);
    };
  }, [visible]);

  if (!visible) return null;

  return (
    <div
      ref={holder}
      aria-hidden="true"
      className={cn(
        "pointer-events-none fixed left-0 top-0 z-[100] select-none",
        // Touch: a sticker in the corner, out of the way of the panel it is celebrating.
        anchored && "!left-auto !right-4 !top-auto bottom-4 !transform-none",
      )}
      style={{ width: SPRITE_W, height: SPRITE_H }}
    >
      <div className="relative size-full animate-pop-in">
        {/* One ring, thrown outward the moment the trade lands. */}
        <span className="absolute left-1/2 top-1/2 size-16 -translate-x-1/2 -translate-y-1/2 animate-cheer rounded-pill border-[3px] border-lime-deep" />
        <div className="size-full animate-bob">
          {/* Plain <img>: next/image would rewrite this through the optimiser, and an animated
              WebP that comes back as a still frame is a dancer that does not dance. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/dance.webp"
            alt=""
            width={SPRITE_W}
            height={SPRITE_H}
            className="size-full object-contain drop-shadow-[0_6px_10px_oklch(var(--color-ink)/0.28)]"
            draggable={false}
          />
        </div>
      </div>
    </div>
  );
}
