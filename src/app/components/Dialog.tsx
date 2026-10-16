import { useEffect, useRef, type ReactNode } from "react";

export const useDialog = (close: () => void) => {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const previous = document.activeElement;
    ref.current?.focus();
    const original = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRef.current();
      if (event.key !== "Tab") return;
      const elements = ref.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input, select, textarea, [tabindex="0"]',
      );
      if (!elements?.length) return;
      const first = elements.item(0);
      const last = elements.item(elements.length - 1);
      if (!first || !last) return;
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          document.activeElement === ref.current)
      ) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handler);
    return () => {
      document.body.style.overflow = original;
      document.removeEventListener("keydown", handler);
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);
  return ref;
};

export const Dialog = ({
  close,
  labelledBy,
  className,
  overlayClassName = "overlay",
  children,
}: {
  close: () => void;
  labelledBy: string;
  className: string;
  overlayClassName?: string;
  children: ReactNode;
}) => {
  const ref = useDialog(close);
  return (
    <div className={overlayClassName} onClick={close}>
      <div
        ref={ref}
        tabIndex={-1}
        className={className}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
};
