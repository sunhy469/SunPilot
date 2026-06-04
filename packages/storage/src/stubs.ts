import { mkdirSync } from "node:fs";
import type { SunPilotPaths } from "./paths.js";

export class DuckDbAdapterStub {
  constructor(private readonly paths: SunPilotPaths) {}

  initialize(): { enabled: false; path: string } {
    mkdirSync(this.paths.analytics, { recursive: true });
    return { enabled: false, path: this.paths.analytics };
  }
}

export class LanceDbAdapterStub {
  constructor(private readonly paths: SunPilotPaths) {}

  initialize(): { enabled: false; path: string } {
    mkdirSync(this.paths.vectors, { recursive: true });
    return { enabled: false, path: this.paths.vectors };
  }
}
