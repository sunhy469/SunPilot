import { useCallback, useState } from "react";
import { errorMessage } from "../api/errors";

export function useRequest() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const run = useCallback(async <T,>(action: () => Promise<T>) => {
    setLoading(true);
    setError("");
    try {
      return await action();
    } catch (err) {
      setError(errorMessage(err));
      return undefined;
    } finally {
      setLoading(false);
    }
  }, []);
  return { loading, error, run, setError };
}
