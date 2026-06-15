import { useRef, useState, useCallback } from "react";

export interface DragDropHandlers {
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
}

/**
 * Tracks drag-over state with a counter to prevent flicker when
 * dragging over child elements inside the drop zone.
 */
export function useDragDrop(
  onFiles: (files: FileList) => void,
): { dragOver: boolean; handlers: DragDropHandlers } {
  const [dragOver, setDragOver] = useState(false);
  const dragCounter = useRef(0);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current += 1;
    if (dragCounter.current === 1) {
      setDragOver(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current -= 1;
    if (dragCounter.current <= 0) {
      dragCounter.current = 0;
      setDragOver(false);
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter.current = 0;
      setDragOver(false);
      if (e.dataTransfer?.files) {
        onFiles(e.dataTransfer.files);
      }
    },
    [onFiles],
  );

  return {
    dragOver,
    handlers: {
      onDragOver: handleDragOver,
      onDragLeave: handleDragLeave,
      onDrop: handleDrop,
    },
  };
}
