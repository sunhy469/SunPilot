import { useRef } from "react";
import { useWorldApp } from "./hooks/useWorldApp";
import "./DigitalWorld.scss";

export function DigitalWorld() {
  const canvasHostRef = useRef<HTMLDivElement | null>(null);
  useWorldApp(canvasHostRef);

  return (
    <section className="digital-world">
      <div ref={canvasHostRef} className="digital-world__canvas-host" />
    </section>
  );
}
