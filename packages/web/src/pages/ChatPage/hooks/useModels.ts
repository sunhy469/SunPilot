import { useEffect, useMemo, useState } from "react";
import { createRequest } from "../../../shared/api/client";

export interface ModelInfo {
  id: string;
  label: string;
  provider: string;
  model: string;
  available: boolean;
}

export interface ModelsResponse {
  defaultModelId: string;
  items: ModelInfo[];
}

/** Available model option for the UI dropdown. */
export interface ModelOption {
  value: string;
  label: string;
  disabled: boolean;
}

const FALLBACK_MODELS: ModelOption[] = [
  { value: "dp", label: "Deepseek-v4-flash", disabled: false },
  { value: "seed", label: "Seed-2.0-lite", disabled: false },
];
const FALLBACK_DEFAULT = "seed";

export function useModels(): {
  options: ModelOption[];
  defaultModelId: string;
  loaded: boolean;
} {
  const [data, setData] = useState<ModelsResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    const request = createRequest();
    try {
      void request<ModelsResponse>("/v1/models")
        .then((result) => {
          if (cancelled) return;
          setData(result);
        })
        .catch(() => {
          // Fallback to hardcoded defaults if API unavailable
        });
    } catch {
      // Request creation itself failed (e.g. missing fetch in test env)
    }
    return () => {
      cancelled = true;
    };
  }, []);

  return useMemo(() => {
    if (!data || !Array.isArray(data.items)) {
      return { options: FALLBACK_MODELS, defaultModelId: FALLBACK_DEFAULT, loaded: false };
    }
    const options: ModelOption[] = data.items.map((item) => ({
      value: item.id,
      label: item.label,
      disabled: !item.available,
    }));
    return { options, defaultModelId: data.defaultModelId, loaded: true };
  }, [data]);
}
